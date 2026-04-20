const { getRedisClient, getRedisStatus } = require("../config/redis");
const { getStatsMemory, getAllStatsMemory } = require("../utils/memoryStore");
const { WINDOW_SECONDS } = require("./rateLimitService");

/**
 * Records a successful request in the stats counter.
 * Called after a request is allowed through the rate limiter.
 *
 * @param {string} userId
 */
async function recordRequest(userId) {
  if (!getRedisStatus()) return; 

  try {
    const client = getRedisClient();
    const statsKey = `stats:${userId}:total`;

    await client.incr(statsKey);
  } catch (err) {
    console.error("[Stats] Failed to record request:", err.message);
  }
}

/**
 * Returns stats for a single user.
 *
 * @param {string} userId
 * @returns {Promise<{ total: number, requestsInLastMinute: number, source: string }>}
 */
async function getUserStats(userId) {
  if (getRedisStatus()) {
    try {
      const client = getRedisClient();
      const statsKey = `stats:${userId}:total`;
      const rlKey    = `rl:${userId}`;
      const now      = Date.now();
      const cutoff   = now - WINDOW_SECONDS * 1000;

      const pipeline = client.pipeline();
      pipeline.get(statsKey);                                        
      pipeline.zcount(rlKey, cutoff, '+inf');                        

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

  // Fallback to memory
  const memStats = getStatsMemory(userId, WINDOW_SECONDS);
  return { userId, ...memStats, source: "memory" };
}

/**
 * Returns stats for all users who have made at least one request.
 *
 * NOTE: In a real production system with millions of users, you would NOT
 * return all users at once — you'd paginate. This is fine for our scope.
 *
 * @returns {Promise<{ users: object, source: string }>}
 */
async function getAllStats() {
  if (getRedisStatus()) {
    try {
      const client = getRedisClient();

      const totalKeys = await scanKeys(client, "stats:*:total");

      if (totalKeys.length === 0) {
        return { users: {}, source: "redis" };
      }

      const now    = Date.now();
      const cutoff = now - WINDOW_SECONDS * 1000;

      const pipeline = client.pipeline();
      const userIds  = [];

      for (const key of totalKeys) {
        // key format: "stats:{userId}:total"
        const userId = key.split(":")[1];
        userIds.push(userId);
        pipeline.get(key);
        pipeline.zcount(`rl:${userId}`, cutoff, "+inf");
      }

      const results = await pipeline.exec();
      const users   = {};

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

  const users = getAllStatsMemory(WINDOW_SECONDS);
  return { users, source: "memory" };
}

async function scanKeys(client, pattern) {
  const keys   = [];
  let cursor    = "0";

  do {
    
    const [newCursor, batch] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = newCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  return keys;
}

module.exports = { recordRequest, getUserStats, getAllStats };