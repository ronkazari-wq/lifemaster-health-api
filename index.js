const express = require('express');
const app = express();
const tokenStore = require('./tokenStore');
const withingsClient = require('./withingsClient');
const { DateTime } = require('luxon');
const { supabase } = require('./supabaseClient');
const OpenAI = require('openai');

// Middleware to parse JSON request bodies
app.use(express.json());

// OpenAI configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const AGENT_API_BASE = process.env.AGENT_API_BASE || "https://lifemaster-health-api.onrender.com";

// ===== PROGRESS AGENT CORE FUNCTION =====

/**
 * Analyze current health data and persist progress assessment
 * Called by /health/daily (on significant change) and /agent/chat (always)
 */
async function analyze_and_persist_progress(input) {
  const { snapshot, source, entry_type, user_message } = input;
  
  console.log('=== ANALYZE_AND_PERSIST_PROGRESS START ===');
  console.log('Input:', { source, entry_type, has_snapshot: !!snapshot, has_message: !!user_message });
  
  if (!process.env.OPENAI_API_KEY) {
    console.error('CRITICAL: OPENAI_API_KEY not set');
    throw new Error('OPENAI_API_KEY is required for progress analysis');
  }

  // Read last 30 days from lifemaster_progress
  const thirtyDaysAgo = DateTime.now().setZone('Asia/Jerusalem').minus({ days: 30 }).toISODate();
  const { data: recentHistory, error: historyError } = await supabase
    .from('lifemaster_progress')
    .select('*')
    .gte('entry_date', thirtyDaysAgo)
    .order('entry_ts', { ascending: false })
    .limit(50);

  if (historyError) {
    console.error('ERROR fetching history from Supabase:', historyError);
    throw new Error(`Failed to fetch history: ${historyError.message}`);
  }
  
  console.log(`Fetched ${recentHistory?.length || 0} history entries`);

    // Read TRUTH_STATE for context (inline summary)
    const truthContext = {
      baseline: {
        weight_kg: 63.1,
        resting_hr: 85,
        hrv_ms: 57,
        sleep_score: 48,
        sleep_duration_minutes: 345
      },
      goals: {
        primary: "Body recomposition with visible abs, no weight loss target",
        secondary: ["Reduce triglycerides", "Improve sleep", "Lower RHR", "Build training habit"]
      },
      constraints: {
        medical: ["Cervical/lumbar disc herniation"],
        training: "2x30min/week",
        lifestyle: "Poor sleep 5h45m, evening stress"
      }
    };

    // Build prompt for OpenAI
    const systemPrompt = `You are a clinical health analyst for LifeMaster.

Context:
- 48.9yo male, 172cm, baseline: 63.1kg, RHR 85bpm, HRV 57ms, Sleep 5h45m
- Goals: Body recomposition, improve sleep, lower RHR, reduce triglycerides
- Constraints: Disc herniation, 2x30min training/week, poor sleep

Rules:
- Prioritize sleep and recovery over all else
- Weight changes secondary to body composition
- No extreme recommendations
- Focus on sustainability

Output ONLY valid JSON:
{
  "summary": "2-3 sentence assessment in Hebrew",
  "impact_assessment": "positive|neutral|negative",
  "delta_vs_baseline": {
    "weight_kg": number or null,
    "resting_hr_bpm": number or null,
    "hrv_ms": number or null,
    "sleep_duration_min": number or null
  },
  "confidence": "low|medium|high"
}`;

    const userPrompt = source === 'user' && user_message
      ? `User message: "${user_message}"\n\nCurrent snapshot: ${JSON.stringify(snapshot)}\n\nRecent history: ${JSON.stringify(recentHistory.slice(0, 5))}`
      : `Current snapshot: ${JSON.stringify(snapshot)}\n\nRecent history: ${JSON.stringify(recentHistory.slice(0, 5))}`;

    console.log('Calling OpenAI with model:', OPENAI_MODEL);
    
    // Call OpenAI (ONE call only)
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: "json_object" }
    });

    const analysis = JSON.parse(completion.choices[0].message.content);
    console.log('OpenAI analysis received:', { 
      impact: analysis.impact_assessment, 
      confidence: analysis.confidence,
      summary_length: analysis.summary?.length || 0
    });

    // Persist to lifemaster_progress
    const today = DateTime.now().setZone('Asia/Jerusalem').toISODate();
    const progressEntry = {
      entry_type: entry_type || 'measurement',
      entry_date: today,
      source: source || 'withings',
      title: analysis.summary ? analysis.summary.substring(0, 100) : 'No summary',
      summary: analysis.summary || '',
      impact_assessment: analysis.impact_assessment,
      confidence: analysis.confidence || 'medium',
      metrics: snapshot || {},
      delta_vs_baseline: analysis.delta_vs_baseline || {},
      entry_ts: new Date().toISOString()
    };

    console.log('=== ATTEMPTING INSERT TO lifemaster_progress ===');
    console.log('Progress entry:', JSON.stringify(progressEntry, null, 2));

    const { data: savedEntry, error: saveError } = await supabase
      .from('lifemaster_progress')
      .insert(progressEntry)
      .select()
      .single();

    console.log('PROGRESS INSERT RESULT:', { data: savedEntry, error: saveError });

    if (saveError) {
      console.error('PROGRESS INSERT ERROR:', saveError);
      console.error('Full error details:', JSON.stringify(saveError, null, 2));
      throw new Error(`Failed to insert progress: ${saveError.message} (code: ${saveError.code})`);
    }

    console.log('✓ Progress saved successfully. Entry ID:', savedEntry?.id);
    console.log('=== ANALYZE_AND_PERSIST_PROGRESS END ===');

    return {
      success: true,
      entry: savedEntry,
      analysis
    };
}

// ===== ENDPOINTS =====

// GET endpoint at /health/daily - Real Withings data
app.get('/health/daily', async (req, res) => {
  try {
    // Get date parameter or default to today in Asia/Jerusalem
    const dateParam = req.query.date;
    const debug = req.query.debug === "1";
    const timezone = 'Asia/Jerusalem';
    
    let targetDate;
    if (dateParam) {
      targetDate = DateTime.fromISO(dateParam, { zone: timezone });
      if (!targetDate.isValid) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
      }
    } else {
      targetDate = DateTime.now().setZone(timezone);
    }
    
    const dateStr = targetDate.toISODate();
    const startOfDay = targetDate.startOf('day');
    const endOfDay = startOfDay.plus({ days: 1 });
    
    // Wider window for measurements (3 days back to handle timezone/sync issues)
    const measureStartTs = Math.floor(startOfDay.minus({ days: 3 }).toSeconds());
    const measureEndTs = Math.floor(endOfDay.toSeconds());
    
    // Original window for sleep (using same day)
    const startTs = Math.floor(startOfDay.toSeconds());
    const endTs = Math.floor(endOfDay.toSeconds());
    
    // Get valid access token (auto-refreshes if needed)
    let accessToken;
    try {
      accessToken = await tokenStore.getValidAccessToken();
    } catch (error) {
      return res.status(401).json({ error: 'withings_not_connected', message: error.message });
    }
    
    const dataPoints = [];
    const snapshot = {
      weight_kg: null,
      heart_pulse_bpm: null,
      spo2_pct: null,
      hrv: null,
      sleep_score: null,
      sleep_duration_minutes: null
    };
    
    const debugInfo = debug ? { measure: {}, sleep: {} } : null;
    
    // Fetch measurements (weight, HR, SpO2, HRV, BP)
    let measureRes;
    const measureUrl = 'https://wbsapi.withings.net/measure';
    const measureParams = {
      action: 'getmeas',
      startdate: measureStartTs,
      enddate: measureEndTs,
      category: 1,
      meastypes: '1,11,54,9,10,62'
    };
    
    try {
      if (debug) {
        debugInfo.measure.url = measureUrl;
        debugInfo.measure.action = measureParams.action;
        debugInfo.measure.startdate = measureParams.startdate;
        debugInfo.measure.enddate = measureParams.enddate;
        debugInfo.measure.window_days = Math.ceil((measureEndTs - measureStartTs) / 86400);
      }
      
      measureRes = await withingsClient.formPost(measureUrl, measureParams, accessToken);
      
      if (debug) {
        debugInfo.measure.status = measureRes.status;
        debugInfo.measure.raw_measuregrps_count = measureRes.body?.measuregrps?.length || 0;
        
        if (measureRes.error || measureRes.body?.error) {
          debugInfo.measure.error = measureRes.error || measureRes.body?.error;
        }
        if (measureRes.message || measureRes.body?.message) {
          debugInfo.measure.message = measureRes.message || measureRes.body?.message;
        }
        
        if (measureRes.body?.measuregrps && measureRes.body.measuregrps.length > 0) {
          debugInfo.measure.first_two_groups = measureRes.body.measuregrps.slice(0, 2).map(grp => ({
            date: grp.date,
            category: grp.category,
            deviceid: grp.deviceid,
            measures: grp.measures.map(m => ({
              type: m.type || m.meastype,
              value: m.value,
              unit: m.unit,
              measure_keys: Object.keys(m)
            }))
          }));
        }
      }
      
      if (measureRes.status !== 0) {
        console.error('Withings measure API error:', measureRes);
        if (debug) {
          return res.status(502).json({ 
            error: 'withings_api_error', 
            debug: debugInfo
          });
        }
        return res.status(502).json({ error: 'withings_api_error', details: measureRes });
      }
      
      // Parse measurements
      if (measureRes.body && measureRes.body.measuregrps) {
        const latestValues = {};
        
        for (const grp of measureRes.body.measuregrps) {
          for (const measure of grp.measures) {
            const meastype = measure.type;
            const actualValue = measure.value * Math.pow(10, measure.unit);
            
            // Keep latest value per meastype
            if (!latestValues[meastype] || grp.date > latestValues[meastype].date) {
              latestValues[meastype] = {
                value: actualValue,
                ts: grp.date,
                raw: {
                  meastype,
                  value: measure.value,
                  unit: measure.unit,
                  date: grp.date,
                  deviceid: grp.deviceid,
                  category: grp.category
                }
              };
            }
          }
        }
        
        // Map meastypes to datapoints
        const typeMapping = {
          1: { key: 'weight_kg', snapshotKey: 'weight_kg', unit: 'kg' },
          11: { key: 'heart_pulse_bpm', snapshotKey: 'heart_pulse_bpm', unit: 'bpm' },
          54: { key: 'spo2_pct', snapshotKey: 'spo2_pct', unit: '%' },
          62: { key: 'hrv_ms', snapshotKey: 'hrv', unit: 'ms' },
          9: { key: 'diastolic_mmhg', snapshotKey: null, unit: 'mmHg' },
          10: { key: 'systolic_mmhg', snapshotKey: null, unit: 'mmHg' }
        };
        
        for (const [meastype, data] of Object.entries(latestValues)) {
          const mapping = typeMapping[meastype];
          if (mapping) {
            dataPoints.push({
              key: mapping.key,
              value: data.value,
              unit: mapping.unit,
              ts: data.ts,
              source: 'withings',
              raw: data.raw
            });
            
            if (mapping.snapshotKey) {
              snapshot[mapping.snapshotKey] = data.value;
            }
          }
        }
      }
    } catch (error) {
      console.error('⚠️ Error fetching measurements from Withings:', error.message);
      console.error('Continuing with empty snapshot - Withings is data source, not blocker');
      // Don't fail the request - continue with empty measurements
      measureRes = { status: -1, body: { measuregrps: [] }, error: error.message };
    }
    
    // Fetch sleep data
    let sleepRes;
    const sleepUrl = 'https://wbsapi.withings.net/v2/sleep';
    const sleepParams = {
      action: 'getsummary',
      startdateymd: dateStr,
      enddateymd: dateStr
    };
    
    try {
      if (debug) {
        debugInfo.sleep.url = sleepUrl;
        debugInfo.sleep.action = sleepParams.action;
        debugInfo.sleep.startdateymd = sleepParams.startdateymd;
        debugInfo.sleep.enddateymd = sleepParams.enddateymd;
      }
      
      sleepRes = await withingsClient.formPost(sleepUrl, sleepParams, accessToken);
      
      if (debug) {
        debugInfo.sleep.status = sleepRes.status;
        debugInfo.sleep.raw_series_count = sleepRes.body?.series?.length || 0;
        
        if (sleepRes.error || sleepRes.body?.error) {
          debugInfo.sleep.error = sleepRes.error || sleepRes.body?.error;
        }
        if (sleepRes.message || sleepRes.body?.message) {
          debugInfo.sleep.message = sleepRes.message || sleepRes.body?.message;
        }
        
        if (sleepRes.body?.series && sleepRes.body.series.length > 0) {
          const firstItem = sleepRes.body.series[0];
          debugInfo.sleep.first_item_keys = Object.keys(firstItem);
          debugInfo.sleep.first_item_data_keys = firstItem.data ? Object.keys(firstItem.data) : [];
          debugInfo.sleep.first_item_sample = {
            startdate: firstItem.startdate,
            enddate: firstItem.enddate,
            sleep_score: firstItem.data?.sleep_score,
            total_sleep_time: firstItem.data?.total_sleep_time,
            total_timeinbed: firstItem.data?.total_timeinbed
          };
        }
      }
      
      if (sleepRes.status !== 0) {
        console.warn('Withings sleep API error:', sleepRes);
        if (debug) {
          debugInfo.sleep.error_detected = true;
        }
      } else if (sleepRes.body && sleepRes.body.series && sleepRes.body.series.length > 0) {
        // Find best overlapping sleep session
        let bestSleep = null;
        let maxOverlap = 0;
        
        for (const session of sleepRes.body.series) {
          const sessionStart = session.startdate;
          const sessionEnd = session.enddate;
          
          // Calculate overlap with our target day
          const overlapStart = Math.max(sessionStart, startTs);
          const overlapEnd = Math.min(sessionEnd, endTs);
          const overlap = Math.max(0, overlapEnd - overlapStart);
          
          if (overlap > maxOverlap) {
            maxOverlap = overlap;
            bestSleep = session;
          }
        }
        
        if (bestSleep) {
          // Extract sleep score
          if (bestSleep.data && bestSleep.data.sleep_score !== undefined) {
            snapshot.sleep_score = bestSleep.data.sleep_score;
            dataPoints.push({
              key: 'sleep_score',
              value: bestSleep.data.sleep_score,
              unit: 'score',
              ts: bestSleep.startdate,
              source: 'withings',
              raw: { session: bestSleep }
            });
          }
          
          // Extract sleep duration
          const durationSeconds = bestSleep.data?.total_sleep_time || bestSleep.data?.total_timeinbed;
          if (durationSeconds) {
            const durationMinutes = Math.round(durationSeconds / 60);
            snapshot.sleep_duration_minutes = durationMinutes;
            dataPoints.push({
              key: 'sleep_duration_minutes',
              value: durationMinutes,
              unit: 'minutes',
              ts: bestSleep.startdate,
              source: 'withings',
              raw: { duration_seconds: durationSeconds }
            });
          }
        }
      }
    } catch (error) {
      console.error('⚠️ Error fetching sleep from Withings:', error.message);
      console.error('Continuing with empty sleep data - Withings is data source, not blocker');
      // Don't fail the entire request for sleep data
    }
    
    // Return structured response
    const response = {
      date: dateStr,
      window: {
        start_ts: startTs,
        end_ts: endTs,
        timezone,
        measure_window: {
          start_ts: measureStartTs,
          end_ts: measureEndTs,
          days_back: 3
        }
      },
      data_points: dataPoints,
      snapshot
    };
    
    if (debug) {
      response.debug = debugInfo;
    }
    
    // ===== TRIGGER PROGRESS AGENT ON SIGNIFICANT CHANGE =====
    // Check if there's a significant change compared to recent measurements
    try {
      const { data: recentMeasurements } = await supabase
        .from('lifemaster_progress')
        .select('metrics')
        .eq('source', 'withings')
        .eq('entry_type', 'measurement')
        .order('entry_ts', { ascending: false })
        .limit(1);

      let shouldTriggerAgent = false;
      
      if (!recentMeasurements || recentMeasurements.length === 0) {
        // No previous measurement, this is the first one
        shouldTriggerAgent = true;
      } else {
        const lastMetrics = recentMeasurements[0].metrics;
        
        // Check for significant changes
        const changes = {
          weight: snapshot.weight_kg && lastMetrics.weight_kg 
            ? Math.abs(snapshot.weight_kg - lastMetrics.weight_kg) 
            : 0,
          rhr: snapshot.heart_pulse_bpm && lastMetrics.heart_pulse_bpm
            ? Math.abs(snapshot.heart_pulse_bpm - lastMetrics.heart_pulse_bpm)
            : 0,
          hrv: snapshot.hrv && lastMetrics.hrv
            ? Math.abs((snapshot.hrv - lastMetrics.hrv) / lastMetrics.hrv * 100)
            : 0,
          sleep: snapshot.sleep_duration_minutes && lastMetrics.sleep_duration_minutes
            ? Math.abs(snapshot.sleep_duration_minutes - lastMetrics.sleep_duration_minutes)
            : 0
        };

        // Thresholds: weight ≥0.5kg, RHR ≥5bpm, HRV ≥10%, sleep ≥60min
        shouldTriggerAgent = 
          changes.weight >= 0.5 ||
          changes.rhr >= 5 ||
          changes.hrv >= 10 ||
          changes.sleep >= 60;

        if (debug && shouldTriggerAgent) {
          response.agent_trigger = { reason: 'significant_change', changes };
        }
      }

      // Trigger agent analysis if significant change detected
      if (shouldTriggerAgent) {
        const agentResult = await analyze_and_persist_progress({
          snapshot,
          source: 'withings',
          entry_type: 'measurement'
        });
        
        if (debug && agentResult.success) {
          response.agent_analysis = agentResult.analysis;
        }
      }
    } catch (agentError) {
      console.error('Error in agent trigger logic:', agentError);
      // Don't fail the request if agent fails
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('Error in /health/daily:', error);
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});




app.get('/openapi.yaml', (req, res) => {
  res.type('text/yaml').send(`
openapi: 3.1.1
info:
  title: LifeMaster Health API
  version: "1.0"
servers:
  - url: https://lifemaster-health-api.onrender.com
paths:
  /health/daily:
    get:
      operationId: getDailyHealth
      summary: Get daily health snapshot with real Withings data
      parameters:
        - name: date
          in: query
          schema:
            type: string
            format: date
          description: Target date in YYYY-MM-DD format (defaults to today in Asia/Jerusalem)
      responses:
        "200":
          description: Daily health snapshot with measurements and sleep data
          content:
            application/json:
              schema:
                type: object
                required:
                  - date
                  - window
                  - data_points
                  - snapshot
                properties:
                  date:
                    type: string
                    format: date
                  window:
                    type: object
                    properties:
                      start_ts:
                        type: integer
                      end_ts:
                        type: integer
                      timezone:
                        type: string
                  data_points:
                    type: array
                    items:
                      type: object
                      properties:
                        key:
                          type: string
                        value:
                          type: number
                        unit:
                          type: string
                        ts:
                          type: integer
                        source:
                          type: string
                        raw:
                          type: object
                  snapshot:
                    type: object
                    properties:
                      weight_kg:
                        type: number
                        nullable: true
                      heart_pulse_bpm:
                        type: number
                        nullable: true
                      spo2_pct:
                        type: number
                        nullable: true
                      hrv:
                        type: number
                        nullable: true
                      sleep_score:
                        type: number
                        nullable: true
                      sleep_duration_minutes:
                        type: number
                        nullable: true
        "401":
          description: Withings not connected or token expired
        "502":
          description: Withings API error
`);
});

app.get("/auth/withings/callback", async (req, res) => {
  console.log("CALLBACK - Reached token exchange");
  console.log("CALLBACK - CLIENT_ID present:", !!process.env.WITHINGS_CLIENT_ID);
  console.log("CALLBACK - CLIENT_SECRET present:", !!process.env.WITHINGS_CLIENT_SECRET);
  
  const code = req.query.code;

  if (!code) {
    return res.status(400).send("No authorization code received");
  }

  const tokenUrl = "https://wbsapi.withings.net/v2/oauth2";

  const params = new URLSearchParams({
    action: "requesttoken",
    grant_type: "authorization_code",
    client_id: process.env.WITHINGS_CLIENT_ID,
    client_secret: process.env.WITHINGS_CLIENT_SECRET,
    code,
    redirect_uri: "https://lifemaster-health-api.onrender.com/auth/withings/callback"
  });
  
  console.log("CALLBACK - Params include client_id:", params.has('client_id'));
  console.log("CALLBACK - Params include client_secret:", params.has('client_secret'));
  console.log("CALLBACK - Params include code:", params.has('code'));
  console.log("CALLBACK - Params include redirect_uri:", params.has('redirect_uri'));

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });

  const data = await response.json();

  if (data.status !== 0) {
    return res.status(500).json(data);
  }

  // Save tokens to persistent storage
  const saveResult = await tokenStore.saveTokens(
    data.body.access_token,
    data.body.refresh_token,
    data.body.expires_in
  );

  if (!saveResult.ok) {
    return res.status(500).json({ 
      error: "Failed to save tokens", 
      details: saveResult 
    });
  }

  res.json({
    message: "OAuth success - tokens saved",
    expires_in: data.body.expires_in
  });
});

app.get("/auth/withings", (req, res) => {
  const clientId = process.env.WITHINGS_CLIENT_ID;

  if (!clientId) {
    return res.status(500).send("WITHINGS_CLIENT_ID is not set");
  }

  const redirectUri = "https://lifemaster-health-api.onrender.com/auth/withings/callback";

  const authUrl =
    "https://account.withings.com/oauth2_user/authorize2" +
    `?response_type=code` +
    `&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=user.info,user.metrics,user.activity` +
    `&state=lifemaster`;

  res.redirect(authUrl);
});

app.get("/withings/weight", async (req, res) => {
  // Load access token from storage
  const tokens = await tokenStore.getTokens();
  
  if (!tokens) {
    return res.status(401).json({ error: "No tokens found. Please authenticate first." });
  }

  // Check if token is expired
  if (await tokenStore.isTokenExpired()) {
    return res.status(401).json({ error: "Token expired. Re-authentication required." });
  }

  // Call Withings measure API
  const measureUrl = "https://wbsapi.withings.net/measure?action=getmeas&meastype=1&category=1&lastupdate=0";
  
  try {
    const response = await fetch(measureUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${tokens.access_token}`
      }
    });

    const data = await response.json();

    if (data.status !== 0) {
      return res.status(500).json({ error: "Withings API error", details: data });
    }

    // Extract weight measurements
    if (!data.body || !data.body.measuregrps || data.body.measuregrps.length === 0) {
      return res.status(404).json({ error: "No weight measurements found" });
    }

    // Get last 10 measurement groups (preserve Withings API order)
    const measureGroups = data.body.measuregrps.slice(0, 10);
    
    const measurements = measureGroups.map(group => {
      const weightMeasure = group.measures.find(m => m.type === 1);
      
      if (!weightMeasure) {
        return null;
      }
      
      // Return RAW fields for inspection
      return {
        value: weightMeasure.value,
        unit: weightMeasure.unit,
        date: group.date,
        modified: group.modified || null,
        deviceid: group.deviceid || null,
        source: group.source || null,
        category: group.category
      };
    }).filter(m => m !== null);

    // Return all measurements with raw fields
    res.json({
      count: measurements.length,
      measurements: measurements
    });

  } catch (error) {
    console.error("Error fetching weight:", error);
    res.status(500).json({ error: "Failed to fetch weight data" });
  }
});

// ===== AGENT PROGRESS ENDPOINTS =====

// GET /agent/state - Read recent progress entries
app.get("/agent/state", async (req, res) => {
  const { data, error } = await supabase
    .from("lifemaster_progress")
    .select("*")
    .order("entry_ts", { ascending: false })
    .limit(100);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({
    count: data.length,
    entries: data
  });
});

// POST /agent/event - Write manual events
app.post("/agent/event", async (req, res) => {
  const payload = {
    ...req.body,
    entry_ts: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("lifemaster_progress")
    .insert(payload)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({
    status: "saved",
    entry: data
  });
});

// POST /agent/commit - Write agent decisions (requires consent)
app.post("/agent/commit", async (req, res) => {
  const { consent } = req.body;

  if (!consent || consent.status !== "granted") {
    return res.status(403).json({
      error: "Consent not granted"
    });
  }

  const payload = {
    ...req.body,
    entry_ts: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("lifemaster_progress")
    .insert(payload)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({
    status: "committed",
    entry: data
  });
});

// POST /agent/chat - OpenAI-powered agent with tool calling
app.post("/agent/chat", async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    // Check for explicit consent words in Hebrew
    const hasConsent = /מאשר|תעדכן|בצע/.test(message);

    // Store incoming message as event
    const today = DateTime.now().setZone('Asia/Jerusalem').toISODate();
    await supabase.from("lifemaster_progress").insert({
      entry_type: "event",
      entry_date: today,
      source: "manual",
      title: "User message",
      notes: message,
      entry_ts: new Date().toISOString()
    });

    // Define tools for OpenAI function calling
    const tools = [
      {
        type: "function",
        function: {
          name: "get_agent_state",
          description: "Retrieve recent progress entries from the lifemaster_progress table. Returns up to 100 recent entries ordered by timestamp descending.",
          parameters: {
            type: "object",
            properties: {},
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "create_agent_event",
          description: "Record a manual event (nutrition, sleep, training observation, or user note) to the progress log.",
          parameters: {
            type: "object",
            properties: {
              entry_date: {
                type: "string",
                description: "Date in YYYY-MM-DD format"
              },
              title: {
                type: "string",
                description: "Brief title of the event"
              },
              notes: {
                type: "string",
                description: "Detailed notes or observations"
              },
              metrics: {
                type: "object",
                description: "Optional structured metrics (e.g., sleep_hours, calories, etc.)"
              }
            },
            required: ["entry_date", "title"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "commit_agent_decision",
          description: "Commit an agent decision or intervention. ONLY call this if explicit consent was granted by the user (words like 'מאשר', 'תעדכן', 'בצע').",
          parameters: {
            type: "object",
            properties: {
              entry_date: {
                type: "string",
                description: "Date in YYYY-MM-DD format"
              },
              title: {
                type: "string",
                description: "Decision title"
              },
              analysis: {
                type: "object",
                description: "Analysis object with worked, didnt_work, and next fields"
              },
              consent: {
                type: "object",
                description: "Consent object with status='granted', granted_at timestamp, and scope",
                properties: {
                  status: { type: "string" },
                  granted_at: { type: "string" },
                  scope: { type: "string" }
                },
                required: ["status", "granted_at", "scope"]
              }
            },
            required: ["entry_date", "title", "consent"]
          }
        }
      }
    ];

    // System prompt for the agent
    const systemPrompt = `You are a professional health and fitness coach assistant for the LifeMaster system.

Your role:
- Analyze user health data (sleep, weight, HRV, training adherence)
- Provide evidence-based guidance focused on sustainability
- Prioritize sleep, recovery, and adherence over aggressive optimization
- Never suggest extreme interventions

CRITICAL RULES:
1. Read TRUTH_STATE.md principles: no extreme diets, prioritize adherence and recovery
2. NEVER call commit_agent_decision unless the user explicitly gave consent with words: "מאשר", "תעדכן", or "בצע"
3. If proposing changes without consent, explain the plan and ASK for explicit approval
4. Always call get_agent_state first to understand current context
5. Log observations using create_agent_event when appropriate

Current consent status: ${hasConsent ? "GRANTED - you may commit decisions" : "NOT GRANTED - only propose, do not commit"}

Respond in Hebrew (עברית) with professional, clear language.`;

    const toolTrace = [];
    let assistantReply = "";
    let committed = false;

    // Initial OpenAI call
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ];

    let response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: messages,
      tools: tools,
      tool_choice: "auto"
    });

    let responseMessage = response.choices[0].message;
    messages.push(responseMessage);

    // Handle tool calls (max 5 iterations to prevent infinite loops)
    let iteration = 0;
    const MAX_ITERATIONS = 5;

    while (responseMessage.tool_calls && iteration < MAX_ITERATIONS) {
      iteration++;

      for (const toolCall of responseMessage.tool_calls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        toolTrace.push({
          function: functionName,
          arguments: functionArgs
        });

        let functionResult;

        try {
          if (functionName === "get_agent_state") {
            // Call GET /agent/state
            const stateResponse = await fetch(`${AGENT_API_BASE}/agent/state`);
            functionResult = await stateResponse.json();

          } else if (functionName === "create_agent_event") {
            // Call POST /agent/event
            const eventPayload = {
              entry_type: "event",
              entry_date: functionArgs.entry_date,
              source: "agent",
              title: functionArgs.title,
              notes: functionArgs.notes,
              metrics: functionArgs.metrics || {}
            };

            const eventResponse = await fetch(`${AGENT_API_BASE}/agent/event`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(eventPayload)
            });
            functionResult = await eventResponse.json();

          } else if (functionName === "commit_agent_decision") {
            // Only allow if consent was granted
            if (!hasConsent) {
              functionResult = {
                error: "Consent not granted. User must explicitly approve with 'מאשר', 'תעדכן', or 'בצע'."
              };
            } else {
              // Call POST /agent/commit
              const commitPayload = {
                entry_type: "decision",
                entry_date: functionArgs.entry_date,
                source: "agent",
                title: functionArgs.title,
                analysis: functionArgs.analysis,
                consent: {
                  status: "granted",
                  granted_at: new Date().toISOString(),
                  scope: functionArgs.consent.scope
                }
              };

              const commitResponse = await fetch(`${AGENT_API_BASE}/agent/commit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(commitPayload)
              });
              functionResult = await commitResponse.json();
              
              if (functionResult.status === "committed") {
                committed = true;
              }
            }
          }
        } catch (error) {
          functionResult = { error: error.message };
        }

        // Add tool result to messages
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(functionResult)
        });
      }

      // Get next response from OpenAI
      response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: messages,
        tools: tools,
        tool_choice: "auto"
      });

      responseMessage = response.choices[0].message;
      messages.push(responseMessage);
    }

    assistantReply = responseMessage.content || "No response generated";

    // ===== ALWAYS TRIGGER PROGRESS ANALYSIS ON USER CHAT =====
    // Determine entry_type based on message content
    let chatEntryType = 'insight'; // default
    if (/אכלתי|אוכל|תזונה|ארוחה|סנדוויץ|פחמימות|חלבון/.test(message)) {
      chatEntryType = 'adherence';
    } else if (/אימון|התאמן|כוח|קרדיו|שרירים/.test(message)) {
      chatEntryType = 'adherence';
    } else if (/מתחיל|אתחיל|אשנה|אפסיק/.test(message)) {
      chatEntryType = 'intervention';
    }

    console.log('=== /agent/chat PROGRESS TRIGGER ===');
    console.log('Message:', message.substring(0, 50));
    console.log('Detected entry_type:', chatEntryType);

    // Get current snapshot from recent progress data
    const { data: recentMetrics } = await supabase
      .from('lifemaster_progress')
      .select('metrics')
      .not('metrics', 'is', null)
      .order('entry_ts', { ascending: false })
      .limit(1);

    const currentSnapshot = recentMetrics && recentMetrics.length > 0 
      ? recentMetrics[0].metrics 
      : { weight_kg: null, heart_pulse_bpm: null, hrv: null, sleep_duration_minutes: null };

    console.log('Current snapshot:', currentSnapshot);

    // Always call analyze_and_persist_progress for user chat
    // NO SILENT FAILURES - throw errors up
    const chatAnalysis = await analyze_and_persist_progress({
      snapshot: currentSnapshot,
      source: 'user',
      entry_type: chatEntryType,
      user_message: message
    });

    console.log('✓ Chat analysis completed and persisted');
    console.log('Entry ID:', chatAnalysis.entry?.id);

    res.json({
      reply: assistantReply,
      committed: committed,
      tool_trace: toolTrace
    });

  } catch (error) {
    console.error("Error in /agent/chat:", error);
    res.status(500).json({
      error: "Agent chat failed",
      details: error.message
    });
  }
});

// Start server on port from environment or default to 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log("ENV CHECK - CLIENT_ID:", !!process.env.WITHINGS_CLIENT_ID);
  console.log("ENV CHECK - CLIENT_SECRET:", !!process.env.WITHINGS_CLIENT_SECRET);
});

