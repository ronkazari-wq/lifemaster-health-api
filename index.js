require('dotenv').config();
console.log('ENV CHECK - ANTHROPIC_API_KEY:', !!process.env.ANTHROPIC_API_KEY);
const express = require('express');
const app = express();
const tokenStore = require('./tokenStore');
const withingsClient = require('./withingsClient');
const { DateTime } = require('luxon');
const { supabase } = require('./supabaseClient');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
// Anthropic Managed Agents
const { getAgentConfig } = require('./anthropic-setup');
const { syncAllUsers } = require('./withings-sync');
const sessionManager = require('./session-manager');
const agentEvents = require('./agent-events');
const { sendLunchEvent, sendDinnerEvent } = agentEvents;
const consumerPool = require('./consumer-pool');
const SessionConsumer = require('./session-consumer');

// Middleware to parse JSON request bodies
app.use(express.json());
// Twilio sends form-encoded bodies
app.use(express.urlencoded({ extended: false }));

// OpenAI configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const AGENT_API_BASE = process.env.AGENT_API_BASE || "https://lifemaster-health-api.onrender.com";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ===== DATABASE HELPERS =====

/**
 * Fetch a user's full health identity and metrics from Supabase
 */
async function getUserProfile(userId) {
  if (!userId) throw new Error('userId is required to fetch profile');

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error || !profile) {
    console.error(`Error fetching profile for user ${userId}:`, error?.message);
    throw new Error(`Profile not found for user ${userId}`);
  }

  // Calculate age from birth_date
  const birthDate = DateTime.fromISO(profile.birth_date);
  const age = Math.floor(DateTime.now().diff(birthDate, 'years').years * 10) / 10;

  return { ...profile, age };
}

// ===== PROGRESS AGENT CORE FUNCTION =====

// NOTE: analyze_and_persist_progress and runMorningAgent removed in favor of Anthropic Managed Agents

// ===== ENDPOINTS =====

console.log('REGISTERING /ping');
app.get('/ping', (req, res) => res.send('pong'));

// ===== ANTHROPIC MANAGED AGENTS =====

// POST /tools/execute removed - using event-stream consumer model instead

// /dev/trigger-agent removed - use GET /agent/execute instead
// GET endpoint at /health/daily - Real Withings data for a specific user
// GET endpoint at /health/daily - Manual check for events
app.get('/health/daily', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  try {
    const { data } = await supabase
      .from('lifemaster_events')
      .select('*')
      .eq('user_id', user_id)
      .order('occurred_at', { ascending: false })
      .limit(10);
    res.json({ count: data.length, entries: data });
  } catch (error) {
    res.status(500).json({ error: 'internal_error', message: error.message });
  }
});

// Endpoints consolidated above




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

// ===== CORE OAUTH FLOW (PHASE 1) =====

/**
 * Initiate Withings OAuth flow for a specific user.
 * Validates user_id format and existence.
 */
app.get('/connect-withings', async (req, res) => {
  const { user_id } = req.query;

  // 1. Validate UUID format
  if (!user_id || !UUID_REGEX.test(user_id)) {
    return res.status(400).json({ error: 'Invalid or missing user_id. Must be a valid UUID.' });
  }

  try {
    // 2. Verify user exists in DB
    const { data: profile, error } = await supabase
      .from('user_profiles')
      .select('user_id')
      .eq('user_id', user_id)
      .maybeSingle();

    if (error || !profile) {
      return res.status(404).json({ error: 'User profile not found. Connection cannot be initiated.' });
    }

    // 3. Construct Auth URL
    const clientId = process.env.WITHINGS_CLIENT_ID;
    const redirectUri = encodeURIComponent(`${process.env.WITHINGS_REDIRECT_URI || 'http://localhost:3000/api/withings/callback'}`);

    const authUrl = `https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&scope=user.info,user.metrics,user.activity&state=${user_id}`;

    console.log(`OAuth initiation for user ${user_id}`);
    res.redirect(authUrl);

  } catch (error) {
    console.error('Connect error:', error.message);
    res.status(500).json({ error: 'Internal server error during connection initiation' });
  }
});

/**
 * Callback for Withings OAuth.
 * Strictly uses state as user_id and validates Withings response.
 */
app.get('/api/withings/callback', async (req, res) => {
  const { code, state: userId } = req.query;

  if (!code || !userId) {
    return res.status(400).send('Missing code or state (user_id)');
  }

  console.log(`Processing Withings callback for user ${userId}`);

  const tokenUrl = 'https://wbsapi.withings.net/v2/oauth2';
  const params = new URLSearchParams({
    action: 'requesttoken',
    grant_type: 'authorization_code',
    client_id: process.env.WITHINGS_CLIENT_ID,
    client_secret: process.env.WITHINGS_CLIENT_SECRET,
    code,
    redirect_uri: process.env.WITHINGS_REDIRECT_URI || 'http://localhost:3000/api/withings/callback'
  });

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    const data = await response.json();

    // 1. Strict validation of Withings response status
    if (data.status !== 0) {
      console.error('Withings Token Exchange Failed:', data);
      return res.status(502).json({
        error: 'Withings API error',
        details: data.error || 'Unknown error',
        status: data.status
      });
    }

    // 2. Store tokens with user scoping
    const saveResult = await tokenStore.saveWithingsTokens(userId, data.body);

    if (!saveResult.ok) {
      return res.status(500).json({ error: 'Failed to persist tokens', details: saveResult.reason });
    }

    res.json({
      status: 'success',
      message: 'Withings account linked successfully',
      user_id: userId
    });

  } catch (error) {
    console.error('Callback error:', error.message);
    res.status(500).json({ error: 'Internal server error during token exchange' });
  }
});

app.get("/auth/withings/callback", async (req, res) => {
  console.log("CALLBACK - Reached token exchange");
  const code = req.query.code;
  const userId = req.query.state; // Extraction of user_id from state

  if (!code) return res.status(400).send("No authorization code received");
  if (!userId || userId === 'lifemaster') {
    return res.status(400).send("No user_id found in state. Initiation must include user_id.");
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

  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    const data = await response.json();
    if (data.status !== 0) return res.status(500).json(data);

    // Save tokens to persistent storage for the specific user
    const saveResult = await tokenStore.saveTokens(
      userId,
      data.body.access_token,
      data.body.refresh_token,
      data.body.expires_in
    );

    if (!saveResult.ok) {
      return res.status(500).json({ error: "Failed to save tokens", userId, details: saveResult });
    }

    res.json({ message: "OAuth success - tokens saved", userId, expires_in: data.body.expires_in });
  } catch (error) {
    res.status(500).json({ error: "OAuth execution failed", details: error.message });
  }
});

app.get("/auth/withings", (req, res) => {
  const { user_id } = req.query;
  const clientId = process.env.WITHINGS_CLIENT_ID;

  if (!user_id) return res.status(400).send("user_id is required to initiate auth");
  if (!clientId) return res.status(500).send("WITHINGS_CLIENT_ID is not set");

  const redirectUri = "https://lifemaster-health-api.onrender.com/auth/withings/callback";

  const authUrl =
    "https://account.withings.com/oauth2_user/authorize2" +
    `?response_type=code` +
    `&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=user.info,user.metrics,user.activity` +
    `&state=${user_id}`; // Passing user_id as state

  res.redirect(authUrl);
});

app.get("/withings/weight", async (req, res) => {
  const { user_id: userId } = req.query;
  if (!userId) return res.status(400).json({ error: "user_id is required" });

  try {
    // Get a valid access token for this specific user
    const accessToken = await tokenStore.getValidAccessToken(userId);

    // Call Withings measure API
    const measureUrl = "https://wbsapi.withings.net/measure?action=getmeas&meastype=1&category=1&lastupdate=0";

    const response = await fetch(measureUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`
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

// GET /agent/state - Read recent progress entries for a specific user
app.get("/agent/state", async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: "user_id is required" });

  const { data, error } = await supabase
    .from("lifemaster_events")
    .select("*")
    .eq("user_id", user_id)
    .order("occurred_at", { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    count: data.length,
    entries: data
  });
});

// POST /agent/event - See line ~857 for the managed agents implementation

// POST /agent/commit - Write agent decisions for a user (requires consent)
app.post("/agent/commit", async (req, res) => {
  const { user_id, consent, ...rest } = req.body;
  if (!user_id) return res.status(400).json({ error: "user_id is required" });

  if (!consent || consent.status !== "granted") {
    return res.status(403).json({ error: "Consent not granted" });
  }

  const payload = {
    user_id,
    ...rest,
    occurred_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("lifemaster_events")
    .insert(payload)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    status: "committed",
    entry: data
  });
});

// POST /agent/chat - OpenAI-powered agent with tool calling
app.post("/agent/chat", async (req, res) => {
  try {
    const { message, user_id: userId } = req.body;

    if (!message) return res.status(400).json({ error: "Message is required" });
    if (!userId) return res.status(400).json({ error: "user_id is required" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    // Check for explicit consent words in Hebrew
    const hasConsent = /מאשר|תעדכן|בצע/.test(message);

    // Store incoming message as event for that user
    await supabase.from("lifemaster_events").insert({
      user_id: userId,
      entry_type: "event",
      source: "manual",
      title: "User message",
      notes: message,
      occurred_at: new Date().toISOString()
    });

    // Define tools for OpenAI function calling
    const tools = [
      {
        type: "function",
        function: {
          name: "get_agent_state",
          description: "Retrieve recent health events and progress from the lifemaster_events table for the current user.",
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

    // Fetch real user profile from Supabase for the legacy agent
    const profile = await getUserProfile(userId);

    // System prompt for the agent
    const systemPrompt = `You are a professional health and fitness coach assistant for the LifeMaster system.
 
User Profile:
- Name: ${profile.full_name}
- Age: ${profile.age}
- Goals: ${JSON.stringify(profile.goals)}
- Constraints: ${JSON.stringify(profile.medical_constraints)}

Your role:
- Analyze user health data (sleep, weight, HRV, training adherence)
- Provide evidence-based guidance focused on sustainability
- Prioritize sleep, recovery, and adherence over aggressive optimization

CRITICAL RULES:
1. NEVER call commit_agent_decision unless the user explicitly gave consent with words: "מאשר", "תעדכן", or "בצע"
2. If proposing changes without consent, explain the plan and ASK for explicit approval
3. Always call get_agent_state first to understand current context
4. Log observations using create_agent_event when appropriate

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
            // Call GET /agent/state with explicit user_id scoping
            const stateResponse = await fetch(`${AGENT_API_BASE}/agent/state?user_id=${userId}`);
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
              body: JSON.stringify({ ...eventPayload, user_id: userId })
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
                body: JSON.stringify({ ...commitPayload, user_id: userId })
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

    // Get current snapshot for this user from their latest event
    const { data: recentMetrics } = await supabase
      .from('lifemaster_events')
      .select('metrics')
      .eq('user_id', userId)
      .not('metrics', 'is', null)
      .order('occurred_at', { ascending: false })
      .limit(1);

    const currentSnapshot = recentMetrics && recentMetrics.length > 0
      ? recentMetrics[0].metrics
      : { weight_kg: null, heart_pulse_bpm: null, hrv: null, sleep_duration_minutes: null };

    console.log('Current snapshot:', currentSnapshot);

    // NOTE: analyze_and_persist_progress removed. Logic moved to autonomous agent.
    
    res.json({
      reply: assistantReply,
      committed: committed,
      tool_trace: toolTrace
    });

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

console.log('REGISTERING /ping-end');
app.get('/ping-end', (req, res) => res.send('pong-end'));

// ===== MANAGED AGENT ENDPOINTS =====
// Execute autonomous health agent for a user
app.get('/agent/execute', async (req, res) => {
  const { user_id, trigger_type } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  const triggerType = trigger_type || 'manual';
  console.log(`\n[API] GET /agent/execute for user ${user_id} (trigger: ${triggerType})`);

  try {
    // Get or create session for this user
    const sessionId = await sessionManager.getOrCreateSession(user_id);

    // Start consumer (if not already running) with trigger type
    consumerPool.startConsumer(sessionId, user_id, SessionConsumer, triggerType);

    // Send event to Anthropic session
    // Consumer will handle tool calls and completion
    await agentEvents.sendEvent(sessionId, triggerType, {
      timestamp: new Date().toISOString(),
    });

    return res.json({
      status: 'success',
      user_id,
      trigger_type: triggerType,
      session_id: sessionId,
      message: 'Event sent to Anthropic agent'
    });
  } catch (error) {
    console.error(`[API] Agent execution failed:`, error.message);
    return res.status(500).json({
      error: 'Agent execution failed',
      details: error.message
    });
  }
});

// Trigger agent for event (supermarket, workout completed, etc.)
app.post('/agent/event', async (req, res) => {
  const { user_id, event_type, data } = req.body;

  if (!user_id || !event_type) {
    return res.status(400).json({ error: 'user_id and event_type required' });
  }

  console.log(`[API] POST /agent/event: ${event_type} for user ${user_id}`);

  try {
    // Store event in lifemaster_events
    const { error: eventError } = await supabase
      .from('lifemaster_events')
      .insert({
        user_id,
        title: `User event: ${event_type}`,
        event_type: 'event',
        source: 'user',
        metrics: data || {},
        occurred_at: new Date().toISOString()
      });

    if (eventError) throw eventError;

    // Trigger agent in background if event is triggerable
    const triggerableEvents = ['at_supermarket', 'workout_completed', 'meal_logged', 'anomaly_detected'];
    if (triggerableEvents.includes(event_type)) {
      // Don't await - send event in background
      (async () => {
        try {
          const sessionId = await sessionManager.getOrCreateSession(user_id);

          // Start consumer (if not already running) with trigger type
          consumerPool.startConsumer(sessionId, user_id, SessionConsumer, event_type);

          // Send event to Anthropic
          await agentEvents.sendEvent(sessionId, 'event', {
            event_type,
            data,
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          console.error(`[Background] Event trigger failed:`, error.message);
        }
      })();
    }

    return res.json({
      status: 'event_recorded',
      user_id,
      event_type
    });
  } catch (error) {
    console.error(`[API] Event handling failed:`, error.message);
    return res.status(500).json({
      error: 'Event handling failed',
      details: error.message
    });
  }
});

console.log('REGISTERING /agent endpoints');

// ===== WHATSAPP WEBHOOK =====
const { handleIncomingMessage } = require('./whatsapp');

app.post('/webhook/whatsapp', (req, res) => {
  // Respond to Twilio immediately — processing happens in background
  res.sendStatus(200);

  const from = req.body.From;  // "whatsapp:+972501234567"
  const body = req.body.Body;  // message text

  if (!from || !body) return;

  handleIncomingMessage(from, body).catch(err =>
    console.error(`[WHATSAPP] Unhandled error for ${from}:`, err.message)
  );
});

// Start server on port from environment or default to 3000
const PORT = process.env.PORT || 3000;
console.log('INDEX LOADED');
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log("ENV CHECK - WITHINGS_CLIENT_ID:", !!process.env.WITHINGS_CLIENT_ID);

  // Initialize Cron Jobs

  // WITHINGS SYNC — 07:30, 16:00, 22:00 Jerusalem time
  for (const cronTime of ['30 7 * * *', '0 16 * * *', '0 22 * * *']) {
    cron.schedule(cronTime, async () => {
      console.log(`CRON: Withings sync (${cronTime})...`);
      await syncAllUsers().catch(err =>
        console.error('CRON: Withings sync failed:', err.message)
      );
    }, { timezone: "Asia/Jerusalem" });
  }

  // Helper: trigger agent event for all active users
  async function triggerForAllUsers(triggerType, sendEventFn) {
    console.log(`CRON: Triggering ${triggerType} for all active users...`);
    try {
      const users = await sessionManager.getActiveUsers();
      console.log(`CRON: ${users.length} users`);
      for (const user of users) {
        (async () => {
          try {
            const sessionId = await sessionManager.getOrCreateSession(user.user_id);
            consumerPool.startConsumer(sessionId, user.user_id, SessionConsumer, triggerType);
            await sendEventFn(sessionId);
          } catch (err) {
            console.error(`CRON: ${triggerType} failed for ${user.user_id}:`, err.message);
          }
        })();
      }
    } catch (err) {
      console.error(`CRON: Failed to fetch users for ${triggerType}:`, err.message);
    }
  }

  // 08:30 — Morning greeting (after 07:30 Withings sync)
  cron.schedule('30 8 * * *', () =>
    triggerForAllUsers('morning_greeting', agentEvents.sendMorningEvent),
    { timezone: "Asia/Jerusalem" }
  );

  // 13:00 — Lunch suggestion
  cron.schedule('0 13 * * *', () =>
    triggerForAllUsers('lunch_time', agentEvents.sendLunchEvent),
    { timezone: "Asia/Jerusalem" }
  );

  // 19:30 — Dinner suggestion
  cron.schedule('30 19 * * *', () =>
    triggerForAllUsers('dinner_time', agentEvents.sendDinnerEvent),
    { timezone: "Asia/Jerusalem" }
  );

  // 21:00 — Evening check-in
  cron.schedule('0 21 * * *', () =>
    triggerForAllUsers('evening_checkin', agentEvents.sendEveningEvent),
    { timezone: "Asia/Jerusalem" }
  );
});

