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

// Start server on port from environment or default to 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

