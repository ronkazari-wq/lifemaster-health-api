const { supabase } = require('./supabaseClient');

/**
 * Save Withings tokens to Supabase
 */
async function saveTokens(accessToken, refreshToken, expiresIn) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  
  try {
    const { error } = await supabase
      .from('withings_tokens')
      .upsert({
        id: 'main',
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt
      });
    
    if (error) {
      console.error('Error saving tokens to Supabase:', error.message);
      return false;
    }
    
    console.log('Tokens saved successfully to Supabase');
    return true;
  } catch (error) {
    console.error('Error saving tokens:', error.message);
    return false;
  }
}

/**
 * Get stored Withings tokens from Supabase
 */
async function getTokens() {
  try {
    const { data, error } = await supabase
      .from('withings_tokens')
      .select('access_token, refresh_token, expires_at')
      .eq('id', 'main')
      .maybeSingle();
    
    if (error) {
      console.error('Error reading tokens from Supabase:', error.message);
      return null;
    }
    
    if (!data) {
      return null;
    }
    
    // Convert expires_at from ISO string to timestamp for compatibility
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(data.expires_at).getTime()
    };
  } catch (error) {
    console.error('Error reading tokens:', error.message);
    return null;
  }
}

/**
 * Check if the stored access token is expired
 */
async function isTokenExpired() {
  const tokens = await getTokens();
  if (!tokens) return true;
  
  return Date.now() >= tokens.expires_at;
}

/**
 * Get a valid access token, refreshing if necessary
 * @returns {Promise<string>} Valid access token
 * @throws {Error} If no tokens found or refresh fails
 */
async function getValidAccessToken() {
  const tokens = await getTokens();
  
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
    
    // Save new tokens to Supabase
    const saved = await saveTokens(
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

