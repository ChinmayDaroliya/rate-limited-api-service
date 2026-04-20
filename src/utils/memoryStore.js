// In-memory storage for rate limiting fallback
const store = new Map();

// Get or create user record
function getUserRecord(userId) {
  if (!store.has(userId)) {
    store.set(userId, { timestamps: [], total: 0 });
  }
  return store.get(userId);
}

/**
 * Sliding window rate limiter for in-memory fallback
 * @returns {{ allowed: boolean, requestCount: number, retryAfter: number }}
 */
function checkAndIncrementMemory(userId, maxRequests, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const record = getUserRecord(userId);

  // Remove timestamps outside sliding window
  record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);

  // Check rate limit
  if (record.timestamps.length >= maxRequests) {
    const oldestTs = record.timestamps[0];
    const retryAfterMs = windowMs - (now - oldestTs);
    return {
      allowed: false,
      requestCount: record.timestamps.length,
      retryAfter: Math.ceil(retryAfterMs / 1000),
    };
  }

  // Allow request: add timestamp and update counters
  record.timestamps.push(now);
  record.total += 1;

  return {
    allowed: true,
    requestCount: record.timestamps.length,
    retryAfter: 0,
  };
}

// Get statistics for specific user from memory
function getStatsMemory(userId, windowSeconds) {
  // Get user record
  const record = store.get(userId);
  if (!record) {
    // Return default stats if user record not found
    return { total: 0, requestsInLastMinute: 0 };
  }

  // Get current timestamp
  const now = Date.now();
  // Calculate sliding window in milliseconds
  const windowMs = windowSeconds * 1000;
  // Filter timestamps within sliding window
  const recentTimestamps = record.timestamps.filter((ts) => now - ts < windowMs);

  // Return user statistics
  return {
    total: record.total,
    requestsInLastMinute: recentTimestamps.length,
  };
}

// Get statistics for all users from memory
function getAllStatsMemory(windowSeconds) {
  // Get current timestamp
  const now = Date.now();
  // Calculate sliding window in milliseconds
  const windowMs = windowSeconds * 1000;
  // Initialize result object
  const result = {};

  // Iterate over user records
  for (const [userId, record] of store.entries()) {
    // Filter timestamps within sliding window
    const recent = record.timestamps.filter((ts) => now - ts < windowMs);
    // Add user statistics to result
    result[userId] = {
      total: record.total,
      requestsInLastMinute: recent.length,
    };
  }

  // Return statistics for all users
  return result;
}

// Export memory store functions
module.exports = {
  checkAndIncrementMemory,
  getStatsMemory,
  getAllStatsMemory,
};