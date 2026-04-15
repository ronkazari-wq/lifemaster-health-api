/**
 * Anthropic Managed Agents Setup
 * One-time: Create agent and environment
 * This runs once during deployment, stores IDs in config
 */

const Anthropic = require("@anthropic-ai/sdk");

// Get API key - caller should have loaded dotenv first
let apiKey = process.env.ANTHROPIC_API_KEY;

// Fallback: read from .env file if not in process.env
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

if (!apiKey) {
  throw new Error("ANTHROPIC_API_KEY not found in environment or .env file");
}

const client = new Anthropic({
  apiKey,
});

/**
 * Create Anthropic Agent for health management
 * Runs once, stores agent_id in environment
 */
async function createAgent() {
  console.log("📋 Creating Anthropic Agent for health management...");

  const agent = await client.beta.agents.create({
    name: "LifeMaster Health Agent",
    model: "claude-opus-4-6",
    system: `You are a personal health coach — not a report generator. You think and write like a real coach who cares about this specific person and is tracking them throughout the day.

━━━ WHO YOU ARE ━━━
You know everything about the user from their profile. You remember the context from earlier in the day. You don't repeat yourself. You respond based on what's happening right now — not a generic plan.

━━━ TOOL RULES ━━━
Always call tools before responding. Never answer from memory.
- morning_greeting: get_recommendations, get_daily_health(today)
- lunch_time: get_daily_health(today)
- dinner_time: get_daily_health(today)
- evening_checkin: get_daily_health(today), list_events
- User message: get_recommendations or get_daily_health as needed
- Supermarket: get_meal_plan, list_events
- After workout logged: log_workout, then get_recommendations

━━━ TRIGGER BEHAVIOR ━━━

trigger_type = morning_greeting (08:30):
  Open with: "בוקר טוב [name]" then ONE sentence about last night's sleep.
  State the day's focus (1 sentence based on HRV / recovery / stress).
  Give today's workout — numbered list, specific exercises, home gym, neck-safe.
  Then: "לארוחת בוקר:" followed by what to eat right now.
  Total length: 15–20 lines MAX. Warm, direct. Like a coach texting in the morning.

trigger_type = lunch_time (13:00):
  Open with: "זמן לאכול"
  State what to eat for lunch — specific, simple, 3–4 items.
  One optional note if something relevant happened this morning (activity, workout).
  Total length: 5–6 lines. Nothing more.

trigger_type = dinner_time (19:30):
  Open with: "ערב טוב"
  State what to eat for dinner — specific, simple, 3–4 items.
  Total length: 4–5 lines. Nothing more.

trigger_type = evening_checkin (21:00):
  Brief honest take on the day — did they train? how is recovery looking?
  One thing to focus on tomorrow.
  Sleep recommendation (when to sleep based on recovery data).
  Total length: 6–8 lines. No meal plans, no workout plans.

trigger_type = anything else (user WhatsApp message):
  Respond conversationally. Answer what was asked.
  Use tools as needed. Be a coach, not a chatbot.
  Never dump a full day plan unless specifically asked.

━━━ INTERNAL CALCULATION (never shown to user) ━━━
Calculate nutrition needs internally: weight, goal, training load → calorie + macro targets.
Apply decision_rules (triglycerides priority, rest day adjustments).
These drive food choices. Never appear in output.

━━━ OUTPUT RULES — STRICT ━━━
NEVER output: grams, calorie counts, macro numbers, nutrition tables.

Meals format:
  ארוחת בוקר: 2 ביצים / קוטג' / פרוסת לחם כוסמין / ירקות
  צהריים: חזה עוף / אורז / סלט
  ערב: דג / ירקות מאודים / חצי אבוקדו

Quantities: count (2 ביצים), slice (פרוסה), handful, cup, portion. No numbers beyond that.

━━━ FOOD SELECTION RULES ━━━
1. PRIORITY — build meals from realistic_foods and preferred_foods first.
   Staples: eggs, cottage cheese, chicken, fish, spelt bread, vegetables.
2. FLEXIBILITY — aligned additions allowed, minimal (1–2 per day max).
3. HARD CONSTRAINT — never suggest any food in avoided_foods. Absolute.
4. CONSISTENCY — familiar and repeatable. Variety is secondary.
5. DOUBT RULE — default to staples.

━━━ MEDICAL RULES (always enforced) ━━━
Read medical_constraints and decision_rules from profile.
Override rules (override: true) are absolute — no exceptions.`,
    tools: [
      {
        type: "custom",
        name: "get_daily_health",
        description: "Get the user's daily health events and metrics for a specific date. Returns all health events logged for that day including workouts, sleep, HRV, and other metrics.",
        input_schema: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "The date to fetch health data for, in YYYY-MM-DD format (e.g. '2024-01-15')",
            },
          },
          required: ["date"],
        },
      },
      {
        type: "custom",
        name: "get_meal_plan",
        description: "Get the user's current meal plan preferences. Returns the configured meal plan type and nutritional preferences.",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        type: "custom",
        name: "log_workout",
        description: "Log a completed workout for the user. Records the workout type, duration, and intensity in the health database.",
        input_schema: {
          type: "object",
          properties: {
            workout_type: {
              type: "string",
              description: "Type of workout (e.g. 'running', 'strength training', 'cycling', 'yoga')",
            },
            duration_minutes: {
              type: "number",
              description: "Duration of the workout in minutes",
            },
            intensity: {
              type: "string",
              enum: ["low", "moderate", "high"],
              description: "Workout intensity level",
            },
          },
          required: ["workout_type", "duration_minutes"],
        },
      },
      {
        type: "custom",
        name: "get_recommendations",
        description: "Get personalized health recommendations for the user based on their profile, fitness level, goals, and recent activity history.",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        type: "custom",
        name: "list_events",
        description: "List the user's recent health events in reverse chronological order. Useful for reviewing activity history and tracking progress.",
        input_schema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of events to return (default: 10)",
            },
          },
          required: [],
        },
      },
    ],
  });

  console.log(`✅ Agent created: ${agent.id}`);
  return agent;
}

/**
 * Create Anthropic Environment
 * Stores configuration and tool definitions
 * Runs once, stores environment_id in config
 */
async function createEnvironment() {
  console.log("📋 Creating Anthropic Environment...");

  const environment = await client.beta.environments.create({
    name: "LifeMaster Production",
    description:
      "Production environment for health agent with user-scoped tools and custom tool integration",
  });

  console.log(`✅ Environment created: ${environment.id}`);
  return environment;
}

/**
 * Setup both agent and environment
 * Call once, store IDs in process.env or config file
 */
async function setupManagedAgents() {
  try {
    console.log("\n🚀 Initializing Anthropic Managed Agents...");

    const agent = await createAgent();
    const environment = await createEnvironment();

    console.log("\n✅ Setup complete!");
    console.log(`   Agent ID: ${agent.id}`);
    console.log(`   Environment ID: ${environment.id}`);
    console.log("\n⚠️  Store these in your environment variables:");
    console.log(`   ANTHROPIC_AGENT_ID=${agent.id}`);
    console.log(`   ANTHROPIC_ENVIRONMENT_ID=${environment.id}`);

    return {
      agentId: agent.id,
      environmentId: environment.id,
    };
  } catch (error) {
    console.error("❌ Setup failed:", error.message);
    throw error;
  }
}

/**
 * Get or create agent ID from environment
 * Use stored IDs if available, otherwise create
 */
async function getOrCreateAgentId() {
  if (process.env.ANTHROPIC_AGENT_ID) {
    console.log(
      `✅ Using existing agent: ${process.env.ANTHROPIC_AGENT_ID}`
    );
    return process.env.ANTHROPIC_AGENT_ID;
  }

  console.log("⚠️  No ANTHROPIC_AGENT_ID found, creating new agent...");
  const agent = await createAgent();
  process.env.ANTHROPIC_AGENT_ID = agent.id;
  return agent.id;
}

/**
 * Get or create environment ID from environment
 */
async function getOrCreateEnvironmentId() {
  if (process.env.ANTHROPIC_ENVIRONMENT_ID) {
    console.log(
      `✅ Using existing environment: ${process.env.ANTHROPIC_ENVIRONMENT_ID}`
    );
    return process.env.ANTHROPIC_ENVIRONMENT_ID;
  }

  console.log(
    "⚠️  No ANTHROPIC_ENVIRONMENT_ID found, creating new environment..."
  );
  const environment = await createEnvironment();
  process.env.ANTHROPIC_ENVIRONMENT_ID = environment.id;
  return environment.id;
}

/**
 * Get agent and environment IDs
 * Cached during session
 */
let cachedAgentId = null;
let cachedEnvironmentId = null;

async function getAgentConfig() {
  if (!cachedAgentId) {
    cachedAgentId = await getOrCreateAgentId();
  }
  if (!cachedEnvironmentId) {
    cachedEnvironmentId = await getOrCreateEnvironmentId();
  }

  return {
    agentId: cachedAgentId,
    environmentId: cachedEnvironmentId,
  };
}

module.exports = {
  setupManagedAgents,
  getOrCreateAgentId,
  getOrCreateEnvironmentId,
  getAgentConfig,
};
