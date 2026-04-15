/**
 * Consumer Pool
 * Tracks one session consumer per active session
 * Prevents multiple streams from opening on same session
 */

const sessionConsumers = new Map();

/**
 * Start a consumer for a session if not already running
 */
function startConsumer(sessionId, userId, Consumer, triggerType = 'manual') {
  if (sessionConsumers.has(sessionId)) {
    console.log(`[POOL] Consumer already running for session ${sessionId}`);
    return { status: 'already_running', sessionId };
  }

  console.log(`[POOL] Starting consumer for session ${sessionId}`);
  const consumer = new Consumer(sessionId, userId, triggerType);
  sessionConsumers.set(sessionId, consumer);

  // Start consumer in background (non-blocking)
  consumer.start().catch(err => {
    console.error(`[POOL] Consumer error for session ${sessionId}:`, err.message);
    sessionConsumers.delete(sessionId);
  });

  return { status: 'started', sessionId };
}

/**
 * Unregister a consumer (called when consumer completes or errors)
 */
function unregisterConsumer(sessionId) {
  if (sessionConsumers.has(sessionId)) {
    console.log(`[POOL] Unregistering consumer for session ${sessionId}`);
    sessionConsumers.delete(sessionId);
  }
}

/**
 * Check if consumer is active for a session
 */
function isConsumerActive(sessionId) {
  return sessionConsumers.has(sessionId);
}

module.exports = {
  startConsumer,
  unregisterConsumer,
  isConsumerActive,
};
