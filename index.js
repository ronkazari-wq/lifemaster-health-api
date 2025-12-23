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

// Start server on port from environment or default to 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

