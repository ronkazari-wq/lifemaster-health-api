const express = require('express');
const app = express();

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

app.get("/auth/withings/callback", (req, res) => {
  res.status(200).send("Withings callback OK");
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
    `&scope=user.metrics,user.activity,user.sleep` +
    `&state=lifemaster`;

  res.redirect(authUrl);
});

// Start server on port from environment or default to 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

