/**
 * Agent Events
 * Send events to Anthropic sessions
 * Anthropic manages the agent loop and tool execution
 */

const Anthropic = require("@anthropic-ai/sdk");
const { getSessionOwner } = require("./session-manager");
const { supabase } = require("./supabaseClient");

// Get API key - fallback to .env file if not in process.env
let apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '.env');
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/ANTHROPIC_API_KEY=(.+)/);
    if (match) {
      apiKey = match[1].trim();
    }
  } catch (err) {
    // Ignore
  }
}

const client = new Anthropic({
  apiKey,
});

/**
 * Send event to Anthropic session
 * Triggers agent to process the event
 * Anthropic handles the entire agent loop
 */
async function sendEvent(sessionId, eventType, eventData = {}) {
  console.log(
    `📤 Sending ${eventType} event to session ${sessionId}`
  );

  try {
    // Remove user_id from eventData if present (session_id maps to user_id in our DB)
    const cleanData = { ...eventData };
    delete cleanData.user_id;

    // Send event to Anthropic
    const response = await client.beta.sessions.events.send(sessionId, {
      events: [
        {
          type: "user.message",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                trigger_type: eventType,
                timestamp: new Date().toISOString(),
                ...cleanData,
              }),
            },
          ],
        },
      ],
    });

    console.log(`✅ Event sent, Anthropic processing...`);

    return response;
  } catch (error) {
    console.error(`❌ Failed to send event:`, error.message);
    throw error;
  }
}

/**
 * Handle completion event from Anthropic
 * Called when agent finishes a cycle
 * Persists results to database
 */
async function handleCompletion(sessionId, result) {
  console.log(`✅ Agent completed for session ${sessionId}`);

  try {
    // Get user_id from session
    const userId = await getSessionOwner(sessionId);

    // Extract decision from Anthropic result
    const decision = result.decision || result.summary || "Agent completed";
    const rationale = result.rationale || result.analysis || "";

    // Persist to database
    const { error } = await supabase
      .from("agent_decisions")
      .insert({
        user_id: userId,
        proposal_text: decision,
        rationale: rationale,
        decision_type: result.decision_type || "autonomous",
        trigger_type: result.trigger_type || "unknown",
        decision_payload: result.payload || {},
        status: "granted",
        scope: "health",
        is_final: true,
      });

    if (error) {
      console.error(`❌ Failed to persist decision:`, error.message);
      throw error;
    }

    console.log(`✅ Decision persisted for user ${userId}`);
    return { user_id: userId, decision_id: result.id };
  } catch (error) {
    console.error(`❌ Failed to handle completion:`, error.message);
    throw error;
  }
}

/**
 * 08:30 — Morning greeting: sleep review + today's workout + breakfast
 */
async function sendMorningEvent(sessionId) {
  return sendEvent(sessionId, "morning_greeting", {});
}

/**
 * 13:00 — Lunch time: what to eat right now
 */
async function sendLunchEvent(sessionId) {
  return sendEvent(sessionId, "lunch_time", {});
}

/**
 * 19:30 — Dinner time: what to eat for dinner
 */
async function sendDinnerEvent(sessionId) {
  return sendEvent(sessionId, "dinner_time", {});
}

/**
 * 21:00 — Evening check-in: brief day summary + tomorrow prep
 */
async function sendEveningEvent(sessionId) {
  return sendEvent(sessionId, "evening_checkin", {});
}

/**
 * Send supermarket event
 * User is shopping, generate shopping list
 */
async function sendSupermarketEvent(sessionId, location) {
  return sendEvent(sessionId, "supermarket", {
    location: location || "store",
    description:
      "User is at supermarket. Generate TODAY's shopping list based on meal plan and preferences.",
  });
}

/**
 * Send workout event
 * User completed or about to start workout
 */
async function sendWorkoutEvent(sessionId, workoutData) {
  return sendEvent(sessionId, "workout", {
    description: "Log or analyze workout. Update performance tracking.",
    ...workoutData,
  });
}

/**
 * Send anomaly event
 * Unusual health metric detected
 */
async function sendAnomalyEvent(sessionId, anomalyData) {
  return sendEvent(sessionId, "anomaly", {
    description:
      "Health anomaly detected. Analyze and recommend adjustments.",
    ...anomalyData,
  });
}

module.exports = {
  sendEvent,
  handleCompletion,
  sendMorningEvent,
  sendLunchEvent,
  sendDinnerEvent,
  sendEveningEvent,
  sendSupermarketEvent,
  sendWorkoutEvent,
  sendAnomalyEvent,
};
