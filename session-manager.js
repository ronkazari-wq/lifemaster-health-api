/**
 * Session Manager
 * Maps user_id ↔ anthropic_session_id
 * Manages session lifecycle
 */

const Anthropic = require("@anthropic-ai/sdk");
const { supabase } = require("./supabaseClient");
const { getAgentConfig } = require("./anthropic-setup");

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
 * Create a new Anthropic session for a user
 * Called when user first triggers agent
 */
async function createSessionForUser(userId) {
  console.log(`📝 Creating Anthropic session for user ${userId}`);

  const { agentId, environmentId } = await getAgentConfig();

  // Create session with Anthropic
  const session = await client.beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
  });

  console.log(`✅ Anthropic session created: ${session.id}`);

  // Store mapping in database
  const { error: dbError } = await supabase
    .from("user_sessions")
    .insert({
      user_id: userId,
      anthropic_session_id: session.id,
      status: "active",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

  if (dbError) {
    console.error(`❌ Failed to store session in DB:`, dbError.message);
    throw dbError;
  }

  return session.id;
}

/**
 * Get active session for user
 * Returns session_id if exists and not expired
 * Creates new session if needed
 */
async function getOrCreateSession(userId) {
  console.log(`🔍 Looking up session for user ${userId}`);

  // Check if user has active session (not expired)
  const { data: existingSession, error } = await supabase
    .from("user_sessions")
    .select("anthropic_session_id, created_at, status")
    .eq("user_id", userId)
    .eq("status", "active")
    .gte("expires_at", new Date().toISOString())
    .single();

  if (error && error.code !== "PGRST116") {
    // PGRST116 = no rows found, which is ok
    console.error(`❌ DB error:`, error.message);
    throw error;
  }

  if (existingSession) {
    console.log(
      `✅ Reusing existing session: ${existingSession.anthropic_session_id}`
    );
    return existingSession.anthropic_session_id;
  }

  // No active session, create new one
  console.log(
    `⚠️  No active session found, creating new one for user ${userId}`
  );
  return createSessionForUser(userId);
}

/**
 * Get session by session_id
 * Returns user_id from DB (ONLY source of user identity for requests)
 * CRITICAL: This extracts user_id from database, not from request
 */
async function getSessionOwner(sessionId) {
  console.log(`🔐 Verifying session ${sessionId}`);

  // Validate session_id format
  if (!sessionId || !/^ses[sn]_[a-zA-Z0-9]+$/.test(sessionId)) {
    throw new Error("INVALID_SESSION_FORMAT");
  }

  // Lookup in database
  const { data: session, error } = await supabase
    .from("user_sessions")
    .select("user_id, created_at, status, expires_at")
    .eq("anthropic_session_id", sessionId)
    .single();

  if (error || !session) {
    console.error(`❌ Session not found: ${sessionId}`);
    throw new Error("SESSION_NOT_FOUND");
  }

  // Verify not expired
  const expiresAt = new Date(session.expires_at);
  if (expiresAt < new Date()) {
    console.error(`❌ Session expired: ${sessionId}`);
    throw new Error("SESSION_EXPIRED");
  }

  // Verify active
  if (session.status !== "active") {
    console.error(`❌ Session not active: ${sessionId}`);
    throw new Error("SESSION_NOT_ACTIVE");
  }

  console.log(`✅ Session valid, owner: ${session.user_id}`);
  return session.user_id;
}

/**
 * Mark session as completed
 * Used when agent finishes a cycle or user resets
 */
async function completeSession(sessionId) {
  console.log(`✅ Marking session as completed: ${sessionId}`);

  const { error } = await supabase
    .from("user_sessions")
    .update({
      status: "completed",
      last_event_at: new Date().toISOString(),
    })
    .eq("anthropic_session_id", sessionId);

  if (error) {
    console.error(`❌ Failed to complete session:`, error.message);
    throw error;
  }
}

/**
 * Get all active sessions that need morning/evening cycle
 * Used by cron jobs
 */
async function getActiveUsers() {
  console.log(`📋 Fetching active users`);

  const { data: users, error } = await supabase
    .from("user_profiles")
    .select("user_id");

  if (error) {
    console.error(`❌ Failed to fetch users:`, error.message);
    throw error;
  }

  return users;
}

module.exports = {
  createSessionForUser,
  getOrCreateSession,
  getSessionOwner,
  completeSession,
  getActiveUsers,
};
