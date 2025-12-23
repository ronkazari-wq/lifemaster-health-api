/**
 * Withings API Client
 * Provides form POST utility for Withings API calls
 */

/**
 * Make a form POST request to Withings API
 * @param {string} url - The Withings API endpoint
 * @param {object} params - Request parameters
 * @param {string} accessToken - Bearer access token
 * @returns {Promise<object>} Parsed JSON response
 */
async function formPost(url, params, accessToken) {
  const body = new URLSearchParams(params);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body
  });

  return await response.json();
}

module.exports = {
  formPost
};

