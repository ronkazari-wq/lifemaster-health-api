const express = require('express');
const app = express();
const tokenStore = require('./tokenStore');

// GET endpoint at /health/daily
app.get('/health/daily', (req, res) => {
  const healthSnapshot = {
    date: new Date().toISOString().split('T')[0], // Current date in YYYY-MM-DD format
    sleep_score: 85,
    sleep_duration_minutes: 420,
    resting_hr: 58,
    hrv: 45,
    spo2: 98,
    weight: 75.5
  };

  res.status(200).json(healthSnapshot);
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
      summary: Get daily health snapshot
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required:
                  - date
                  - sleep_score
                  - sleep_duration_minutes
                  - resting_hr
                  - hrv
                  - spo2
                  - weight
                properties:
                  date:
                    type: string
                  sleep_score:
                    type: integer
                  sleep_duration_minutes:
                    type: integer
                  resting_hr:
                    type: integer
                  hrv:
                    type: integer
                  spo2:
                    type: integer
                  weight:
                    type: number
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
  const saved = tokenStore.saveTokens(
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
  const tokens = tokenStore.getTokens();
  
  if (!tokens) {
    return res.status(401).json({ error: "No tokens found. Please authenticate first." });
  }

  // Check if token is expired
  if (tokenStore.isTokenExpired()) {
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
      
      // Calculate actual weight value (value * 10^unit)
      const weightKg = weightMeasure.value * Math.pow(10, weightMeasure.unit);
      
      return {
        weight_kg: weightKg,
        timestamp: group.date,
        date: new Date(group.date * 1000).toISOString(),
        category: group.category
      };
    }).filter(m => m !== null);

    // Return all measurements
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

