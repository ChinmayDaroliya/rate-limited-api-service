const store = new Map();

function getUserRecord(userId) {
  if (!store.has(userId)) {
    store.set(userId, { timestamps: [], total: 0 });
  }
  return store.get(userId);
}

/**
 * Checks and updates the rate limit for a user.
 *
 * Uses a SLIDING WINDOW approach:
 *   - We keep a list of timestamps for each request the user made
 *   - Before counting, we remove any timestamps older than 1 minute
 *   - If the remaining count >= limit, we reject
 *
 * This is more accurate than fixed windows (which can allow 10 requests
 * in 2 seconds if timed around a window boundary).
 *
 * @returns {{ allowed: boolean, requestCount: number, retryAfter: number }}
 */
function checkAndIncrementMemory(userId, maxRequests, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const record = getUserRecord(userId);

  record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);

  if (record.timestamps.length >= maxRequests) {

    const oldestTs = record.timestamps[0];
    const retryAfterMs = windowMs - (now - oldestTs);
    return {
      allowed: false,
      requestCount: record.timestamps.length,
      retryAfter: Math.ceil(retryAfterMs / 1000),
    };
  }

  record.timestamps.push(now);
  record.total += 1;

  return {
    allowed: true,
    requestCount: record.timestamps.length,
    retryAfter: 0,
  };
}

function getStatsMemory(userId, windowSeconds) {
  const record = store.get(userId);
  if (!record) {
    return { total: 0, requestsInLastMinute: 0 };
  }

  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const recentTimestamps = record.timestamps.filter((ts) => now - ts < windowMs);

  return {
    total: record.total,
    requestsInLastMinute: recentTimestamps.length,
  };
}

function getAllStatsMemory(windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const result = {};

  for (const [userId, record] of store.entries()) {
    const recent = record.timestamps.filter((ts) => now - ts < windowMs);
    result[userId] = {
      total: record.total,
      requestsInLastMinute: recent.length,
    };
  }

  return result;
}

module.exports = {
  checkAndIncrementMemory,
  getStatsMemory,
  getAllStatsMemory,
};