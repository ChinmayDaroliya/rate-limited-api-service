const { getRedisClient, getRedisStatus } = require("../config/redis");
const { checkAndIncrementMemory } = require("../utils/memoryStore");

const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "5", 10);
const WINDOW_SECONDS = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || "60", 10);

const SLIDING_WINDOW_SCRIPT = `
  local key       = KEYS[1]
  local now       = tonumber(ARGV[1])
  local window_ms = tonumber(ARGV[2])
  local max_req   = tonumber(ARGV[3])
  local cutoff    = now - window_ms

  -- Remove all entries older than the window
  redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

  -- Count current entries in the window
  local count = redis.call('ZCARD', key)

  if count >= max_req then
    -- Rate limit exceeded: return { 0, count, oldest_timestamp }
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local oldest_ts = oldest[2] and tonumber(oldest[2]) or now
    return {0, count, oldest_ts}
  end

  -- Allow: add this request with timestamp as score
  -- Using now + count as a tiebreaker member name to avoid duplicate score collisions
  redis.call('ZADD', key, now, now .. '-' .. count)

  -- Set TTL so the key auto-expires after the window (cleanup)
  redis.call('EXPIRE', key, math.ceil(window_ms / 1000) + 1)

  local new_count = redis.call('ZCARD', key)
  return {1, new_count, 0}
`;

/**
 * Checks whether a user is within rate limits, and records the request if allowed.
 *
 * @param {string} userId
 * @returns {Promise<{ allowed: boolean, requestCount: number, retryAfter: number, source: string }>}
 */
async function checkRateLimit(userId) {
  const redisKey = `rl:${userId}`;
  const nowMs = Date.now();
  const windowMs = WINDOW_SECONDS * 1000;

  if (getRedisStatus()) {
    try {
      const client = getRedisClient();

      const result = await client.eval(
        SLIDING_WINDOW_SCRIPT,
        1,           
        redisKey,    
        nowMs,       
        windowMs,    
        MAX_REQUESTS 
      );

      const [allowed, count, oldestTs] = result.map(Number);

      let retryAfter = 0;
      if (!allowed) {
        retryAfter = Math.ceil((windowMs - (nowMs - oldestTs)) / 1000);
        retryAfter = Math.max(1, retryAfter); 
      }

      return {
        allowed: allowed === 1,
        requestCount: count,
        retryAfter,
        source: "redis",
      };
    } catch (err) {
      console.error("[RateLimit] Redis eval error, falling back to memory:", err.message);
    }
  }

  const memResult = checkAndIncrementMemory(userId, MAX_REQUESTS, WINDOW_SECONDS);
  return { ...memResult, source: "memory" };
}

module.exports = { checkRateLimit, MAX_REQUESTS, WINDOW_SECONDS };