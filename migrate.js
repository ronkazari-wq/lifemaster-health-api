/**
 * Supabase migration: Extended user data model
 * Additive only. Safe to run multiple times.
 */

require("dotenv").config();
const { Client } = require("pg");

const migration = `
-- ============================================================
-- Migration: Extended User Data Model
-- Additive only. No columns dropped. Idempotent.
-- ============================================================

-- PART 1: Extend user_profiles
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS goals_structured    jsonb        DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS medical_constraints jsonb        DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS recovery_profile    jsonb        DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS nutrition           jsonb        DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS training            jsonb        DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS schedule            jsonb        DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS shopping            jsonb        DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS agent_preferences   jsonb        DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS frictions           jsonb        DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at          timestamptz  DEFAULT now();

-- PART 2: Create user_daily_state
CREATE TABLE IF NOT EXISTS user_daily_state (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  date              date        NOT NULL,
  sleep             jsonb       DEFAULT '{}'::jsonb,
  recovery          jsonb       DEFAULT '{}'::jsonb,
  subjective        jsonb       DEFAULT '{}'::jsonb,
  planned_workout   jsonb       DEFAULT '{}'::jsonb,
  completed_workout jsonb       DEFAULT '{}'::jsonb,
  nutrition_today   jsonb       DEFAULT '{}'::jsonb,
  daily_decision    jsonb       DEFAULT '{}'::jsonb,
  agent_notes       text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (user_id, date)
);

-- PART 3: Indexes
CREATE INDEX IF NOT EXISTS idx_daily_state_user_date
  ON user_daily_state (user_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_daily_state_date
  ON user_daily_state (date DESC);

CREATE INDEX IF NOT EXISTS idx_user_profiles_nutrition_gin
  ON user_profiles USING GIN (nutrition);

CREATE INDEX IF NOT EXISTS idx_user_profiles_agent_prefs_gin
  ON user_profiles USING GIN (agent_preferences);

CREATE INDEX IF NOT EXISTS idx_daily_state_recovery_gin
  ON user_daily_state USING GIN (recovery);
`;

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    console.log("🔌 Connected to database.");
    console.log("🔄 Running migration...");
    await client.query(migration);
    console.log("✅ Migration complete.\n");

    // Verify columns on user_profiles
    const { rows: cols } = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'user_profiles'
      ORDER BY ordinal_position;
    `);
    console.log("user_profiles columns:");
    cols.forEach(c => console.log(`  ${c.column_name.padEnd(22)} ${c.data_type}`));

    // Verify user_daily_state exists
    const { rows: tables } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'user_daily_state';
    `);
    console.log(`\nuser_daily_state: ${tables.length > 0 ? "✅ exists" : "❌ missing"}`);
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
    throw err;
  } finally {
    await client.end();
  }
}

run().catch(() => process.exit(1));
