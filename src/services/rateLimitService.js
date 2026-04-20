// Import Redis client and memory fallback
const { getRedisClient, getRedisStatus } = require("../config/redis");
const { checkAndIncrementMemory } = require("../utils/memoryStore");

// Rate limit configuration from environment
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "5", 10);
const WINDOW_SECONDS = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || "60", 10);

// Atomic Redis Lua script for sliding window rate limiting
const SLIDING_WINDOW_SCRIPT = `
  local key       = KEYS[1]
  local now       = tonumber(ARGV[1])
  local window_ms = tonumber(ARGV[2])
  local max_req   = tonumber(ARGV[3])
  local cutoff    = now - window_ms

  -- Remove entries outside sliding window
  redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

  -- Count current requests in window
  local count = redis.call('ZCARD', key)

  if count >= max_req then
    -- Rate limit exceeded
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local oldest_ts = oldest[2] and tonumber(oldest[2]) or now
    return {0, count, oldest_ts}
  end

  -- Allow request: add timestamp to sorted set
  redis.call('ZADD', key, now, now .. '-' .. count)
  redis.call('EXPIRE', key, math.ceil(window_ms / 1000) + 1)

  -- Return 1 (allowed), new count, and 0 (no retry time)
  local new_count = redis.call('ZCARD', key)
  return {1, new_count, 0}
`;

/**
 * Rate limit checker with Redis primary and memory fallback
 * @param {string} userId
 * @returns {Promise<{ allowed: boolean, requestCount: number, retryAfter: number, source: string }>}
 */
async function checkRateLimit(userId) {
  // Construct Redis key for user
  const redisKey = `rl:${userId}`;
  // Get current timestamp in milliseconds
  const nowMs = Date.now();
  // Calculate window duration in milliseconds
  const windowMs = WINDOW_SECONDS * 1000;

  // Try Redis first if available
  if (getRedisStatus()) {
    try {
      // Get Redis client instance
      const client = getRedisClient();

      // Execute atomic Lua script
      const result = await client.eval(
        SLIDING_WINDOW_SCRIPT,
        1,           // Number of keys
        redisKey,    // Redis key
        nowMs,       // Current timestamp
        windowMs,    // Window duration
        MAX_REQUESTS // Max requests
      );

      // Parse result from Lua script
      const [allowed, count, oldestTs] = result.map(Number);

      // Calculate retry time if rate limited
      let retryAfter = 0;
      if (!allowed) {
        retryAfter = Math.ceil((windowMs - (nowMs - oldestTs)) / 1000);
        retryAfter = Math.max(1, retryAfter); 
      }

      // Return result with Redis as source
      return {
        allowed: allowed === 1,
        requestCount: count,
        retryAfter,
        source: "redis",
      };
    } catch (err) {
      // Log error and fallback to memory if Redis eval fails
      console.error("[RateLimit] Redis eval error, falling back to memory:", err.message);
    }
  }

  // Fallback to in-memory rate limiting
  const memResult = checkAndIncrementMemory(userId, MAX_REQUESTS, WINDOW_SECONDS);
  return { ...memResult, source: "memory" };
}

// Export rate limit checker and configuration
module.exports = { checkRateLimit, MAX_REQUESTS, WINDOW_SECONDS };