const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, 'tokens.json');

/**
 * Save Withings tokens to persistent storage
 */
function saveTokens(accessToken, refreshToken, expiresIn) {
  const expiresAt = Date.now() + (expiresIn * 1000);
  
  const tokenData = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    updated_at: new Date().toISOString()
  };

  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), 'utf8');
    console.log('Tokens saved successfully');
    return true;
  } catch (error) {
    console.error('Error saving tokens:', error);
    return false;
  }
}

/**
 * Get stored Withings tokens
 */
function getTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) {
      return null;
    }
    
    const data = fs.readFileSync(TOKEN_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading tokens:', error);
    return null;
  }
}

/**
 * Check if the stored access token is expired
 */
function isTokenExpired() {
  const tokens = getTokens();
  if (!tokens) return true;
  
  return Date.now() >= tokens.expires_at;
}

module.exports = {
  saveTokens,
  getTokens,
  isTokenExpired
};

