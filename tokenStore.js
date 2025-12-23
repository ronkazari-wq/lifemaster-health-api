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

/**
 * Get a valid access token, refreshing if necessary
 * @returns {Promise<string>} Valid access token
 * @throws {Error} If no tokens found or refresh fails
 */
async function getValidAccessToken() {
  const tokens = getTokens();
  
  if (!tokens) {
    throw new Error('No tokens found. Please authenticate first.');
  }
  
  // If token is still valid, return it
  if (Date.now() < tokens.expires_at) {
    return tokens.access_token;
  }
  
  // Token expired, need to refresh
  console.log('Access token expired, refreshing...');
  
  const tokenUrl = 'https://wbsapi.withings.net/v2/oauth2';
  const params = new URLSearchParams({
    action: 'requesttoken',
    grant_type: 'refresh_token',
    client_id: process.env.WITHINGS_CLIENT_ID,
    client_secret: process.env.WITHINGS_CLIENT_SECRET,
    refresh_token: tokens.refresh_token
  });
  
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    
    const data = await response.json();
    
    if (data.status !== 0) {
      throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
    }
    
    // Save new tokens
    const saved = saveTokens(
      data.body.access_token,
      data.body.refresh_token,
      data.body.expires_in
    );
    
    if (!saved) {
      throw new Error('Failed to save refreshed tokens');
    }
    
    console.log('Token refreshed successfully');
    return data.body.access_token;
    
  } catch (error) {
    console.error('Token refresh error:', error.message);
    throw error;
  }
}

module.exports = {
  saveTokens,
  getTokens,
  isTokenExpired,
  getValidAccessToken
};

