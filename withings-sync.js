/**
 * Withings Sync
 * Pulls last night's sleep summary + morning measurements from Withings
 * and writes them into user_daily_state for today.
 *
 * Called by cron at 07:30 every morning (before the agent runs at 08:00).
 */

const tokenStore  = require("./tokenStore");
const { formPost } = require("./withingsClient");
const { supabase } = require("./supabaseClient");

// ── Withings API helpers ──────────────────────────────────────────────────────

/**
 * Fetch today's activity summary (steps, calories, active minutes).
 */
async function fetchActivity(accessToken, dateToday) {
  const data = await formPost(
    "https://wbsapi.withings.net/v2/measure",
    {
      action: "getactivity",
      startdateymd: dateToday,
      enddateymd: dateToday,
      data_fields: [
        "steps",
        "calories",
        "totalcalories",
        "active",       // active calories
        "distance",     // meters
        "soft",         // light activity seconds
        "moderate",     // moderate activity seconds
        "intense",      // intense activity seconds
        "hr_average",
        "hr_min",
        "hr_max",
      ].join(","),
    },
    accessToken
  );

  if (data.status !== 0) {
    throw new Error(`Withings activity API error: status ${data.status}`);
  }

  const activities = data.body?.activities;
  if (!activities || activities.length === 0) return null;

  // Return the record for today
  return activities.find(a => a.date === dateToday) || activities[0];
}

/**
 * Fetch last night's sleep summary.
 * Returns the most recent sleep record or null if none found.
 */
async function fetchSleepSummary(accessToken, dateToday) {
  // Ask for yesterday → today window to capture last night's sleep
  const yesterday = new Date(dateToday);
  yesterday.setDate(yesterday.getDate() - 1);
  const startdateymd = yesterday.toISOString().split("T")[0];

  const data = await formPost(
    "https://wbsapi.withings.net/v2/sleep",
    {
      action: "getsummary",
      startdateymd,
      enddateymd: dateToday,
      data_fields: [
        "total_sleep_time",
        "wakeupcount",
        "sleep_score",
        "sleep_efficiency",
        "hr_average",
        "hr_min",
        "sdnn_1",   // HRV (SDNN) in ms
        "rmssd",    // HRV (RMSSD) in ms
      ].join(","),
    },
    accessToken
  );

  if (data.status !== 0) {
    throw new Error(`Withings sleep API error: status ${data.status}`);
  }

  const series = data.body?.series;
  if (!series || series.length === 0) return null;

  // Return the most recent record
  return series.sort((a, b) => b.enddate - a.enddate)[0];
}

/**
 * Fetch latest weight and resting HR measurements.
 */
async function fetchMeasurements(accessToken) {
  // meastype 1 = weight, 11 = resting HR
  const data = await formPost(
    "https://wbsapi.withings.net/measure",
    {
      action: "getmeas",
      meastypes: "1,11",
      category: 1,
      lastupdate: Math.floor(Date.now() / 1000) - 86400, // last 24h
    },
    accessToken
  );

  if (data.status !== 0) {
    throw new Error(`Withings measure API error: status ${data.status}`);
  }

  const groups = data.body?.measuregrps || [];
  const result = { weight_kg: null, resting_hr_bpm: null };

  for (const group of groups) {
    for (const m of group.measures) {
      const value = m.value * Math.pow(10, m.unit);
      if (m.type === 1 && result.weight_kg === null) {
        result.weight_kg = Math.round(value * 10) / 10;
      }
      if (m.type === 11 && result.resting_hr_bpm === null) {
        result.resting_hr_bpm = Math.round(value);
      }
    }
  }

  return result;
}

// ── Sleep score → quality (1–5) ───────────────────────────────────────────────

function sleepScoreToQuality(score) {
  if (!score) return null;
  if (score >= 85) return 5;
  if (score >= 70) return 4;
  if (score >= 55) return 3;
  if (score >= 40) return 2;
  return 1;
}

// ── Main sync function ────────────────────────────────────────────────────────

/**
 * Sync Withings data for one user into user_daily_state.
 * Merges with any existing row (does not overwrite manual entries).
 */
async function syncUserWithings(userId) {
  const today = new Date().toISOString().split("T")[0];
  console.log(`   [WITHINGS-SYNC] Syncing ${userId} for ${today}`);

  // 1. Get valid access token (auto-refreshes if expired)
  let accessToken;
  try {
    accessToken = await tokenStore.getValidAccessToken(userId);
  } catch (err) {
    console.warn(`   [WITHINGS-SYNC] No valid token for ${userId}: ${err.message}`);
    return { ok: false, reason: "no_token" };
  }

  // 2. Fetch data in parallel
  const [sleep, measures, activity] = await Promise.all([
    fetchSleepSummary(accessToken, today).catch(err => {
      console.warn(`   [WITHINGS-SYNC] Sleep fetch failed: ${err.message}`);
      return null;
    }),
    fetchMeasurements(accessToken).catch(err => {
      console.warn(`   [WITHINGS-SYNC] Measure fetch failed: ${err.message}`);
      return null;
    }),
    fetchActivity(accessToken, today).catch(err => {
      console.warn(`   [WITHINGS-SYNC] Activity fetch failed: ${err.message}`);
      return null;
    }),
  ]);

  // 3. Build update payload — only include fields we actually got
  const update = { user_id: userId, date: today };

  if (sleep) {
    const totalSleepHours = sleep.data?.total_sleep_time
      ? Math.round((sleep.data.total_sleep_time / 3600) * 10) / 10
      : null;

    const hrv = sleep.data?.sdnn_1 || sleep.data?.rmssd || null;

    update.sleep = {
      hours:         totalSleepHours,
      quality_score: sleepScoreToQuality(sleep.data?.sleep_score),
      disruptions:   sleep.data?.wakeupcount ?? null,
      source:        "withings",
    };

    // HRV goes into recovery
    if (hrv) {
      update.recovery = {
        hrv_ms:  Math.round(hrv),
        source:  "withings",
      };
    }
  }

  if (measures) {
    if (measures.resting_hr_bpm) {
      update.recovery = {
        ...(update.recovery || {}),
        resting_hr_bpm: measures.resting_hr_bpm,
        source: "withings",
      };
    }
    if (measures.weight_kg) {
      update.metrics = { weight_kg: measures.weight_kg };
    }
  }

  if (activity) {
    update.activity = {
      steps:               activity.steps      || 0,
      calories_active:     Math.round(activity.active      || 0),
      calories_total:      Math.round(activity.totalcalories || activity.calories || 0),
      distance_m:          Math.round(activity.distance    || 0),
      duration_light_min:  Math.round((activity.soft     || 0) / 60),
      duration_moderate_min: Math.round((activity.moderate || 0) / 60),
      duration_intense_min:  Math.round((activity.intense  || 0) / 60),
      hr_average:          activity.hr_average || null,
      source:              "withings",
      synced_at:           new Date().toISOString(),
    };
  }

  // 4. Upsert — merges with existing row if present
  const { error } = await supabase
    .from("user_daily_state")
    .upsert(update, { onConflict: "user_id,date" });

  if (error) {
    console.error(`   [WITHINGS-SYNC] DB write failed for ${userId}: ${error.message}`);
    return { ok: false, reason: error.message };
  }

  console.log(`   [WITHINGS-SYNC] ✅ ${userId} — sleep: ${update.sleep?.hours}h, HRV: ${update.recovery?.hrv_ms}ms, HR: ${update.recovery?.resting_hr_bpm}bpm, steps: ${update.activity?.steps}, calories: ${update.activity?.calories_total}`);
  return { ok: true };
}

/**
 * Sync all users who have Withings tokens.
 */
async function syncAllUsers() {
  console.log("\n[WITHINGS-SYNC] Starting morning sync...");

  const { data: tokens, error } = await supabase
    .from("withings_tokens")
    .select("user_id");

  if (error) {
    console.error("[WITHINGS-SYNC] Failed to fetch token list:", error.message);
    return;
  }

  console.log(`[WITHINGS-SYNC] ${tokens.length} users to sync`);

  for (const { user_id } of tokens) {
    await syncUserWithings(user_id).catch(err =>
      console.error(`[WITHINGS-SYNC] Unexpected error for ${user_id}:`, err.message)
    );
  }

  console.log("[WITHINGS-SYNC] Done.");
}

module.exports = { syncAllUsers, syncUserWithings };
