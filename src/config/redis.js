const Redis = require("ioredis");

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === "true" ? {} : undefined,

  retryStrategy(times) {
    if (times > 5) {
      console.error("[Redis] Max retries reached. Giving up.");
      return null; 
    }
    const delay = Math.min(times * 200, 2000); 
    console.warn(`[Redis] Retrying connection in ${delay}ms... (attempt ${times})`);
    return delay;
  },

  enableOfflineQueue: false,
  lazyConnect: true, 
};

let redisClient = null;
let isRedisAvailable = false;

async function connectRedis() {
  redisClient = new Redis(REDIS_CONFIG);

  redisClient.on("connect", () => {
    console.log("[Redis] Connected successfully ✓");
    isRedisAvailable = true;
  });

  redisClient.on("error", (err) => {
    console.error("[Redis] Connection error:", err.message);
    isRedisAvailable = false;
  });

  redisClient.on("close", () => {
    console.warn("[Redis] Connection closed.");
    isRedisAvailable = false;
  });

  try {
    await redisClient.connect();
  } catch (err) {
    console.error("[Redis] Failed to connect on startup:", err.message);
    console.warn("[Redis] Falling back to in-memory rate limiting.");
    isRedisAvailable = false;
  }

  return redisClient;
}

function getRedisClient() {
  return redisClient;
}

function getRedisStatus() {
  return isRedisAvailable;
}

module.exports = { connectRedis, getRedisClient, getRedisStatus };