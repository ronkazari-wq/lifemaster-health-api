/**
 * Tool Executor
 * Maps tool names to implementations, executes with user_id scope.
 * All tools return rich profile context so the agent has full information.
 */

const { supabase } = require("./supabaseClient");

/**
 * Execute a tool with user_id scope.
 * user_id comes only from session mapping, never from tool input.
 */
async function executeToolWithUserScope(toolName, toolInput, userId) {
  console.log(`   [EXECUTOR] ${toolName} for user ${userId}`);

  if (!userId) throw new Error("userId is required");

  const toolFunctions = {
    get_daily_health:   toolGetDailyHealth,
    get_meal_plan:      toolGetMealPlan,
    log_workout:        toolLogWorkout,
    get_recommendations: toolGetRecommendations,
    list_events:        toolListEvents,
  };

  const toolFn = toolFunctions[toolName];
  if (!toolFn) throw new Error(`Unknown tool: ${toolName}`);

  const result = await toolFn(toolInput, userId);

  if (typeof result === "string") return result;
  if (typeof result === "object") return JSON.stringify(result, null, 2);
  return String(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load full user profile (all new JSONB columns).
 */
async function loadProfile(userId) {
  const { data, error } = await supabase
    .from("user_profiles")
    .select(`
      user_id, full_name, birth_date, height_cm, weight_baseline_kg, timezone,
      goals, goals_structured, medical_constraints, recovery_profile,
      nutrition, training, schedule, shopping, agent_preferences, frictions
    `)
    .eq("user_id", userId)
    .single();

  if (error) throw new Error(`Failed to load profile: ${error.message}`);
  return data;
}

/**
 * Load user_daily_state for a specific date.
 * Returns null if no record exists yet.
 */
async function loadDailyState(userId, date) {
  const { data, error } = await supabase
    .from("user_daily_state")
    .select("*")
    .eq("user_id", userId)
    .eq("date", date)
    .single();

  if (error && error.code === "PGRST116") return null; // no row — normal
  if (error) throw new Error(`Failed to load daily state: ${error.message}`);
  return data;
}

/**
 * Evaluate which decision_rules are triggered by current daily state.
 * Returns an array of plain-text rule evaluations for the agent.
 */
function evaluateDecisionRules(profile, dailyState) {
  const rules = profile?.agent_preferences?.decision_rules;
  if (!rules || !dailyState) return [];

  const triggered = [];
  const hrv = dailyState.recovery?.hrv_ms;
  const hrvBaseline = profile?.recovery_profile?.hrv_baseline_ms;
  const sleep = dailyState.sleep?.hours;
  const sleepQuality = dailyState.sleep?.quality_score;
  const stress = dailyState.subjective?.stress_level;
  const restingHr = dailyState.recovery?.resting_hr_bpm;
  const hrBaseline = profile?.recovery_profile?.resting_hr_baseline_bpm;

  // Workout rules
  if (sleep !== undefined && (sleep < 6 || sleepQuality <= 2)) {
    triggered.push({
      rule: "sleep_floor",
      domain: "workout",
      triggered: true,
      action: "assign_recovery_day",
      reason: `Sleep was ${sleep}h (quality ${sleepQuality}/5) — below threshold (6h / quality > 2)`,
    });
  }

  if (hrv !== undefined && hrvBaseline) {
    const delta = (hrv - hrvBaseline) / hrvBaseline;
    const deltaPct = (delta * 100).toFixed(1);

    if (delta < -0.35) {
      triggered.push({
        rule: "hrv_recovery_threshold",
        domain: "workout",
        triggered: true,
        action: "assign_recovery_day",
        reason: `HRV ${hrv}ms is ${Math.abs(deltaPct)}% below baseline (${hrvBaseline}ms) — exceeds 35% threshold`,
      });
    } else if (delta < -0.20) {
      triggered.push({
        rule: "hrv_intensity_reduction",
        domain: "workout",
        triggered: true,
        action: "reduce_intensity_one_level",
        reason: `HRV ${hrv}ms is ${Math.abs(deltaPct)}% below baseline (${hrvBaseline}ms) — exceeds 20% threshold`,
      });
    } else {
      triggered.push({
        rule: "hrv_check",
        domain: "workout",
        triggered: false,
        action: "no_change",
        reason: `HRV ${hrv}ms is ${deltaPct}% vs baseline — within normal range`,
      });
    }
  }

  if (stress !== undefined && stress >= 4) {
    triggered.push({
      rule: "high_stress_downgrade",
      domain: "workout",
      triggered: true,
      action: "prefer_low_intensity",
      reason: `Stress level ${stress}/5 — prefer walking or yoga over structured training`,
    });
  }

  // Alert rules
  if (restingHr !== undefined && hrBaseline && restingHr > hrBaseline + 15) {
    triggered.push({
      rule: "hr_elevation_alert",
      domain: "alerts",
      triggered: true,
      action: "send_anomaly_alert",
      reason: `Resting HR ${restingHr}bpm is ${restingHr - hrBaseline}bpm above baseline (${hrBaseline}bpm)`,
    });
  }

  if (hrv !== undefined && hrvBaseline && hrv < hrvBaseline * 0.60) {
    triggered.push({
      rule: "hrv_crash_alert",
      domain: "alerts",
      triggered: true,
      action: "send_anomaly_alert",
      reason: `HRV ${hrv}ms is more than 40% below baseline — possible illness or overtraining`,
    });
  }

  return triggered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * get_daily_health(date)
 * Returns health events for the date + daily_state (sleep, recovery, subjective)
 * + recovery_profile baselines + evaluated decision rules.
 */
async function toolGetDailyHealth(input, userId) {
  const { date } = input;
  if (!date) throw new Error("date is required (YYYY-MM-DD)");

  const startOfDay = `${date}T00:00:00`;
  const endOfDay   = `${date}T23:59:59`;

  // Load events, profile, and daily state in parallel
  const [eventsResult, profile, dailyState] = await Promise.all([
    supabase
      .from("lifemaster_events")
      .select("title, event_type, source, metrics, occurred_at")
      .eq("user_id", userId)
      .gte("occurred_at", startOfDay)
      .lt("occurred_at", endOfDay)
      .order("occurred_at", { ascending: false }),
    loadProfile(userId),
    loadDailyState(userId, date),
  ]);

  if (eventsResult.error) throw new Error(`Failed to fetch events: ${eventsResult.error.message}`);

  const triggeredRules = evaluateDecisionRules(profile, dailyState);
  const hrvBaseline = profile?.recovery_profile?.hrv_baseline_ms;
  const hrv = dailyState?.recovery?.hrv_ms;
  const hrvDelta = (hrv && hrvBaseline)
    ? `${(((hrv - hrvBaseline) / hrvBaseline) * 100).toFixed(1)}%`
    : "unknown";

  return {
    date,
    logged_events: {
      count: eventsResult.data.length,
      items: eventsResult.data,
    },
    daily_state: dailyState
      ? {
          sleep: dailyState.sleep,
          recovery: {
            ...dailyState.recovery,
            hrv_vs_baseline: hrvDelta,
            hrv_baseline_ms: hrvBaseline,
          },
          subjective: dailyState.subjective,
          activity:   dailyState.activity || null,
          nutrition_today: dailyState.nutrition_today,
          daily_decision_already_set: Object.keys(dailyState.daily_decision || {}).length > 0,
        }
      : "No daily state recorded yet for this date",
    recovery_profile: profile?.recovery_profile,
    triggered_decision_rules: triggeredRules,
  };
}

/**
 * get_meal_plan()
 * Returns full nutrition profile + shopping config + cooking frictions.
 * This is what the agent uses for meal planning and shopping list generation.
 */
async function toolGetMealPlan(input, userId) {
  const profile = await loadProfile(userId);

  const nutrition  = profile?.nutrition;
  const shopping   = profile?.shopping;
  const frictions  = profile?.frictions;

  if (!nutrition || Object.keys(nutrition).length === 0) {
    return "No nutrition profile configured for this user.";
  }

  return {
    nutrition: {
      dietary_style:      nutrition.dietary_style,
      calories_target:    nutrition.calories_target,
      macros:             nutrition.macros,
      meals_per_day:      nutrition.meals_per_day,
      eating_window:      nutrition.eating_window,
      realistic_foods:    nutrition.realistic_foods,
      preferred_foods:    nutrition.preferred_foods,
      avoided_foods:      nutrition.avoided_foods,
      cuisine_preferences: nutrition.cuisine_preferences,
      meal_prep_style:    nutrition.meal_prep_style,
      supplement_stack:   nutrition.supplement_stack,
      hydration_target_l: nutrition.hydration_target_l,
    },
    shopping: {
      shopping_day:            shopping?.shopping_day,
      shopping_frequency:      shopping?.shopping_frequency,
      preferred_stores:        shopping?.preferred_stores,
      budget_per_week_ils:     shopping?.budget_per_week_ils,
      batch_cooking:           shopping?.batch_cooking,
      time_to_cook_weekday_minutes: shopping?.time_to_cook_weekday_minutes,
      time_to_cook_weekend_minutes: shopping?.time_to_cook_weekend_minutes,
      kitchen_equipment:       shopping?.kitchen_equipment,
      servings_per_household:  shopping?.servings_per_household,
      list_format:             shopping?.list_format,
    },
    cooking_frictions:   frictions?.cooking   || [],
    behavioral_frictions: frictions?.behavioral || [],
    shopping_frictions:  frictions?.shopping  || [],
  };
}

/**
 * log_workout(workout_type, duration_minutes, intensity)
 * Records completed workout in lifemaster_events.
 */
async function toolLogWorkout(input, userId) {
  const { workout_type, duration_minutes, intensity } = input;

  if (!workout_type || !duration_minutes) {
    throw new Error("workout_type and duration_minutes are required");
  }

  const { error } = await supabase
    .from("lifemaster_events")
    .insert({
      user_id:    userId,
      title:      `Workout: ${workout_type}`,
      event_type: "workout",
      source:     "agent",
      metrics: { workout_type, duration_minutes, intensity },
      occurred_at: new Date().toISOString(),
    });

  if (error) throw new Error(`Failed to log workout: ${error.message}`);

  return `Workout logged: ${workout_type} for ${duration_minutes} minutes (intensity: ${intensity || "not specified"})`;
}

/**
 * get_recommendations()
 * Returns the full user context: goals, constraints, recovery profile, training
 * preferences, schedule, decision rules, frictions, and today's daily state
 * with pre-evaluated rule triggers.
 *
 * This is the primary context tool. The agent should call this first on every
 * morning/evening cycle to understand who the user is and what rules apply today.
 */
async function toolGetRecommendations(input, userId) {
  const today = new Date().toISOString().split("T")[0];

  const [profile, dailyState] = await Promise.all([
    loadProfile(userId),
    loadDailyState(userId, today),
  ]);

  if (!profile) return "No profile found for this user.";

  const triggeredRules = evaluateDecisionRules(profile, dailyState);
  const hrvBaseline = profile?.recovery_profile?.hrv_baseline_ms;
  const hrv = dailyState?.recovery?.hrv_ms;

  // Determine today's day name for schedule context
  const dayName = new Date().toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
  const isRestDay = profile?.schedule?.fixed_rest_days?.includes(dayName);

  return {
    user: {
      name: profile.full_name,
      date: today,
      day_of_week: dayName,
    },
    goals: profile.goals_structured || profile.goals,
    medical_constraints: profile.medical_constraints,
    recovery_profile: {
      ...profile.recovery_profile,
      todays_hrv_ms: hrv,
      hrv_delta_pct: (hrv && hrvBaseline)
        ? `${(((hrv - hrvBaseline) / hrvBaseline) * 100).toFixed(1)}%`
        : null,
    },
    training_preferences: profile.training,
    schedule: {
      ...profile.schedule,
      today_is_fixed_rest_day: isRestDay,
      todays_workout_window: (() => {
        const windows = profile?.schedule?.workout_windows || [];
        if (isRestDay) return null;
        const isWeekend = ["saturday", "sunday"].includes(dayName);
        return windows.find(w => isWeekend ? w.days === "weekend" : w.days === "weekday") || null;
      })(),
    },
    // Nutrition essentials included here so meal decisions respect all constraints
    // without requiring a separate get_meal_plan call every morning
    nutrition: {
      dietary_style:   profile.nutrition?.dietary_style,
      realistic_foods: profile.nutrition?.realistic_foods,
      preferred_foods: profile.nutrition?.preferred_foods,
      avoided_foods:   profile.nutrition?.avoided_foods,   // HARD CONSTRAINT — never suggest these
      rules:           profile.nutrition?.rules,
      meal_prep_style: profile.nutrition?.meal_prep_style,
    },
    todays_daily_state: dailyState
      ? {
          sleep:      dailyState.sleep,
          recovery:   dailyState.recovery,
          subjective: dailyState.subjective,
          activity:   dailyState.activity || null,
        }
      : null,
    decision_rules: profile?.agent_preferences?.decision_rules,
    triggered_rules_today: triggeredRules,
    frictions: profile.frictions,
    agent_preferences: {
      autonomy_level:      profile.agent_preferences?.autonomy_level,
      communication_style: profile.agent_preferences?.communication_style,
      language:            profile.agent_preferences?.language,
      decision_mode:       profile.agent_preferences?.decision_mode,
    },
  };
}

/**
 * list_events(limit)
 * Lists recent health events in reverse chronological order.
 */
async function toolListEvents(input, userId) {
  const { limit = 10 } = input;

  const { data, error } = await supabase
    .from("lifemaster_events")
    .select("title, event_type, source, metrics, occurred_at")
    .eq("user_id", userId)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch events: ${error.message}`);

  if (!data || data.length === 0) {
    return "No health events logged yet. This user is new or has not started logging.";
  }

  return {
    count: data.length,
    events: data.map(e => ({
      title:      e.title,
      type:       e.event_type,
      occurred:   e.occurred_at,
      metrics:    e.metrics,
    })),
  };
}

module.exports = { executeToolWithUserScope };
