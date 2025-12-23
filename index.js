const express = require('express');
const app = express();
const tokenStore = require('./tokenStore');
const withingsClient = require('./withingsClient');
const { DateTime } = require('luxon');

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
      console.error('Error fetching measurements:', error);
      return res.status(502).json({ error: 'withings_measure_failed', message: error.message });
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
      console.error('Error fetching sleep:', error);
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
  const saved = await tokenStore.saveTokens(
    data.body.access_token,
    data.body.refresh_token,
    data.body.expires_in
  );

  if (!saved) {
    return res.status(500).json({ error: "Failed to save tokens" });
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
    `&scope=user.metrics` +
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

// Start server on port from environment or default to 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log("ENV CHECK - CLIENT_ID:", !!process.env.WITHINGS_CLIENT_ID);
  console.log("ENV CHECK - CLIENT_SECRET:", !!process.env.WITHINGS_CLIENT_SECRET);
});

