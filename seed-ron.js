/**
 * Seed Ron's real profile.
 * User ID is fixed — store this in your .env as RON_USER_ID.
 */

require("dotenv").config();
const { supabase } = require("./supabaseClient");

// Ron's real user ID (from public.users — email: RONKAZARI@GMAIL.COM)
const RON_USER_ID = "11111111-1111-1111-1111-111111111111";
const TODAY = new Date().toISOString().split("T")[0];

const profile = {
  user_id:            RON_USER_ID,
  full_name:          "רון",
  timezone:           "Asia/Jerusalem",

  // Mirror into legacy goals column
  goals: {
    primary: "fat_loss",
    secondary: ["muscle_definition", "reduce_triglycerides", "improve_recovery"],
    current_weight_kg: 64,
    target_body_composition: "visible_abs_and_chest_definition",
    priority_rule: "metabolic_health_first_then_aesthetics",
  },

  goals_structured: {
    primary: "fat_loss",
    secondary: ["muscle_definition", "reduce_triglycerides", "improve_recovery"],
    current_weight_kg: 64,
    target_body_composition: "visible_abs_and_chest_definition",
    priority_rule: "metabolic_health_first_then_aesthetics",
  },

  medical_constraints: {
    conditions: [
      "cervical_disc_herniation_C3_C4",
      "history_of_high_triglycerides",
    ],
    injuries: [
      {
        area: "neck",
        type: "disc_herniation",
        severity: "moderate",
        restrictions: [
          "avoid_heavy_axial_load",
          "avoid_neck_strain",
        ],
      },
    ],
    doctor_clearance: true,
    notes:
      "Focus on lowering triglycerides and improving lipid profile. Neck must never be loaded under axial compression.",
  },

  recovery_profile: {
    nervous_system_type:     "sensitive",
    overtraining_sensitivity: "high",
    sleep_pattern:           "fragmented",
    notes:
      "Baseline fight-or-flight activation. Needs cautious load management. Recovery between sessions is slow.",
  },

  nutrition: {
    dietary_style: "high_protein_moderate_carb_clean",
    goals: [
      "reduce_triglycerides",
      "reduce_simple_carbs",
      "maintain_protein_intake",
    ],
    preferred_foods: [
      "chicken", "beef", "fish", "eggs", "cottage cheese",
      "yellow cheese", "rice", "spelt bread", "vegetables",
    ],
    realistic_foods: [
      { food: "eggs",           frequency_per_week: 7, is_staple: true  },
      { food: "cottage cheese", frequency_per_week: 5, is_staple: true  },
      { food: "chicken",        frequency_per_week: 4, is_staple: true  },
      { food: "fish",           frequency_per_week: 3, is_staple: true  },
      { food: "rice",           frequency_per_week: 3, is_staple: false },
      { food: "spelt bread",    frequency_per_week: 4, is_staple: true  },
      { food: "vegetables",     frequency_per_week: 7, is_staple: true  },
    ],
    avoided_foods: [
      "mayonnaise",
      "processed sugar",
      "unnecessary dairy products",
    ],
    rules: [
      "prioritize protein in every meal",
      "reduce simple carbs",
      "avoid ultra processed food",
    ],
  },

  training: {
    experience_level:         "intermediate",
    preferred_modalities:     ["strength_training"],
    sessions_per_week_target: 3,
    session_duration_minutes: 45,
    preferred_time_of_day:    "morning",
    equipment_available:      "home_gym",
    focus: [
      "core_strength",
      "chest_development",
      "fat_loss_support",
    ],
    constraints: [
      "neck_sensitive",
      "avoid_heavy_spinal_loading",
    ],
  },

  schedule: {
    timezone:               "Asia/Jerusalem",
    preferred_training_time: "morning",
    notes:                  "Morning training is optimal and strongly preferred.",
  },

  shopping: {
    shopping_frequency:      "weekly",
    servings_per_household:  1,
    budget_per_week_ils:     "flexible",
    batch_cooking:           false,
    list_format:             "by_category",
  },

  agent_preferences: {
    autonomy_level:      "high",
    communication_style: "direct",
    language:            "he",
    decision_mode:       "autonomous",
    decision_rules: {
      metabolic: [
        {
          name:      "triglycerides_priority",
          condition: "always",
          action:    "prefer_low_glycemic_meals",
          override:  true,
          description:
            "Every meal recommendation must favor low-glycemic, low-triglyceride foods. No exceptions.",
        },
      ],
      training: [
        {
          name:      "neck_protection",
          condition: "always",
          action:    "avoid_spinal_load_exercises",
          override:  true,
          description:
            "Never prescribe exercises with axial neck load (overhead press behind neck, heavy shrugs, etc.). Cervical C3-C4 herniation is a hard constraint.",
        },
      ],
    },
  },

  frictions: {
    behavioral: [
      "needs simple execution — will not follow complex meal plans",
      "prefers repeatable meals — variety is secondary to consistency",
    ],
    cooking: [
      "prefers quick meals",
      "minimal preparation steps",
    ],
  },

  updated_at: new Date().toISOString(),
};

// Seeding a realistic daily state for today — fragmented sleep, sensitive recovery
const dailyState = {
  user_id: RON_USER_ID,
  date:    TODAY,
  sleep: {
    hours:         6.5,
    quality_score: 3,
    disruptions:   2,
    source:        "manual",
    notes:         "Woke up twice. Fragmented as usual.",
  },
  recovery: {
    resting_hr_bpm:   65,
    readiness_score:  60,
    soreness: {
      neck:        "mild",
      upper_back:  "none",
      chest:       "none",
      legs:        "none",
    },
    source: "manual",
  },
  subjective: {
    energy_level: 3,
    stress_level: 3,
    mood:         "neutral",
    motivation:   4,
    notes:        "Ready to train. Neck feels fine today.",
  },
  nutrition_today: {
    meals_logged:     0,
    calories_consumed: 0,
    protein_g:        0,
    water_l:          0,
    supplements_taken: [],
  },
  daily_decision: {},
  agent_notes:    "",
};

async function seed() {
  console.log("🌱 Seeding Ron's profile...\n");

  const { error: profileError } = await supabase
    .from("user_profiles")
    .upsert(profile, { onConflict: "user_id" });

  if (profileError) {
    console.error("❌ Profile upsert failed:", profileError.message);
    throw profileError;
  }
  console.log("✅ user_profiles — Ron seeded");

  const { error: stateError } = await supabase
    .from("user_daily_state")
    .upsert(dailyState, { onConflict: "user_id,date" });

  if (stateError) {
    console.error("❌ Daily state upsert failed:", stateError.message);
    throw stateError;
  }
  console.log(`✅ user_daily_state — ${TODAY} seeded`);

  // Read back
  const { data: p } = await supabase
    .from("user_profiles")
    .select("user_id, full_name, goals_structured, medical_constraints, recovery_profile, nutrition, training, agent_preferences, frictions")
    .eq("user_id", RON_USER_ID)
    .single();

  const { data: s } = await supabase
    .from("user_daily_state")
    .select("date, sleep, recovery, subjective")
    .eq("user_id", RON_USER_ID)
    .eq("date", TODAY)
    .single();

  console.log("\n── Profile read-back ──────────────────────────────────────");
  console.log(`  user_id:              ${p.user_id}`);
  console.log(`  full_name:            ${p.full_name}`);
  console.log(`  primary goal:         ${p.goals_structured.primary}`);
  console.log(`  secondary goals:      ${p.goals_structured.secondary.join(", ")}`);
  console.log(`  conditions:           ${p.medical_constraints.conditions.join(", ")}`);
  console.log(`  neck restriction:     ${p.medical_constraints.injuries[0].restrictions.join(", ")}`);
  console.log(`  NS type:              ${p.recovery_profile.nervous_system_type}`);
  console.log(`  sleep pattern:        ${p.recovery_profile.sleep_pattern}`);
  console.log(`  dietary_style:        ${p.nutrition.dietary_style}`);
  console.log(`  realistic_foods:      ${p.nutrition.realistic_foods.length} items`);
  console.log(`  avoided_foods:        ${p.nutrition.avoided_foods.join(", ")}`);
  console.log(`  training modalities:  ${p.training.preferred_modalities.join(", ")}`);
  console.log(`  equipment:            ${p.training.equipment_available}`);
  console.log(`  sessions/week:        ${p.training.sessions_per_week_target}`);
  console.log(`  decision_rules:       ${Object.keys(p.agent_preferences.decision_rules).join(", ")}`);
  console.log(`  frictions:            ${Object.keys(p.frictions).join(", ")}`);
  console.log(`  language:             ${p.agent_preferences.language}`);

  console.log("\n── Daily state read-back ──────────────────────────────────");
  console.log(`  date:                 ${s.date}`);
  console.log(`  sleep.hours:          ${s.sleep.hours}h`);
  console.log(`  sleep.quality:        ${s.sleep.quality_score}/5`);
  console.log(`  resting_hr:           ${s.recovery.resting_hr_bpm}bpm`);
  console.log(`  neck_soreness:        ${s.recovery.soreness.neck}`);
  console.log(`  energy_level:         ${s.subjective.energy_level}/5`);
  console.log(`  motivation:           ${s.subjective.motivation}/5`);
  console.log(`  notes:                "${s.subjective.notes}"`);

  console.log(`\n   User ID: ${RON_USER_ID}`);
  console.log("\n✅ Done.");
}

seed().catch(err => {
  console.error(err.message);
  process.exit(1);
});
