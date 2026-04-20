// Import Redis client and memory fallback utilities
const { getRedisClient, getRedisStatus } = require("../config/redis");
const { getStatsMemory, getAllStatsMemory } = require("../utils/memoryStore");
const { WINDOW_SECONDS } = require("./rateLimitService");

/**
 * Records successful request for statistics
 * @param {string} userId
 */
async function recordRequest(userId) {
  // Skip if Redis unavailable
  if (!getRedisStatus()) return; 

  try {
    const client = getRedisClient();
    const statsKey = `stats:${userId}:total`;

    // Increment total request counter
    await client.incr(statsKey);
  } catch (err) {
    console.error("[Stats] Failed to record request:", err.message);
  }
}

/**
 * Retrieves statistics for a single user
 * @param {string} userId
 * @returns {Promise<{ total: number, requestsInLastMinute: number, source: string }>}
 */
async function getUserStats(userId) {
  // Try Redis first if available
  if (getRedisStatus()) {
    try {
      const client = getRedisClient();
      const statsKey = `stats:${userId}:total`;
      // Construct key for user's rate limit
      const rlKey    = `rl:${userId}`;
      // Calculate time cutoff for recent requests
      const now      = Date.now();
      const cutoff   = now - WINDOW_SECONDS * 1000;

      // Use pipeline for efficient Redis operations
      const pipeline = client.pipeline();
      // Get total count and recent requests in one pipeline
      pipeline.get(statsKey);                                        
      pipeline.zcount(rlKey, cutoff, '+inf');                        

      // Execute pipeline and parse results
      const [[, totalRaw], [, recentRaw]] = await pipeline.exec();

      return {
        userId,
        total: parseInt(totalRaw || "0", 10),
        requestsInLastMinute: parseInt(recentRaw || "0", 10),
        source: "redis",
      };
    } catch (err) {
      console.error("[Stats] Redis error, falling back to memory:", err.message);
    }
  }

  // Fallback to memory store
  const memStats = getStatsMemory(userId, WINDOW_SECONDS);
  return { userId, ...memStats, source: "memory" };
}

/**
 * Retrieves statistics for all users
 * NOTE: Production would paginate this for millions of users
 * @returns {Promise<{ users: object, source: string }>}
 */
async function getAllStats() {
  // Try Redis first
  if (getRedisStatus()) {
    try {
      // Get Redis client instance
      const client = getRedisClient();

      // Scan for all user stat keys
      const totalKeys = await scanKeys(client, "stats:*:total");

      if (totalKeys.length === 0) {
        return { users: {}, source: "redis" };
      }

      // Calculate time cutoff for recent requests
      const now    = Date.now();
      const cutoff = now - WINDOW_SECONDS * 1000;

      // Build pipeline for all users
      const pipeline = client.pipeline();
      const userIds  = [];

      for (const key of totalKeys) {
        // Extract userId from key format: "stats:{userId}:total"
        const userId = key.split(":")[1];
        userIds.push(userId);
        pipeline.get(key);
        pipeline.zcount(`rl:${userId}`, cutoff, "+inf");
      }

      // Execute all operations in one round-trip
      const results = await pipeline.exec();
      const users   = {};

      // Parse pipeline results
      for (let i = 0; i < userIds.length; i++) {
        const userId  = userIds[i];
        const total   = parseInt(results[i * 2]?.[1]  || "0", 10);
        const recent  = parseInt(results[i * 2 + 1]?.[1] || "0", 10);
        users[userId] = { total, requestsInLastMinute: recent };
      }

      return { users, source: "redis" };
    } catch (err) {
      console.error("[Stats] Redis error in getAllStats, falling back:", err.message);
    }
  }

  // Fallback to memory store
  const users = getAllStatsMemory(WINDOW_SECONDS);
  return { users, source: "memory" };
}

/**
 * Scans Redis keys using cursor-based iteration
 * @param {object} client - Redis client
 * @param {string} pattern - Key pattern to match
 * @returns {Promise<string[]>} Array of matching keys
 */
async function scanKeys(client, pattern) {
  const keys   = [];
  let cursor    = "0";

  do {
    // Scan batch of keys
    const [newCursor, batch] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = newCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  return keys;
}

// Export stats service functions
module.exports = { recordRequest, getUserStats, getAllStats };