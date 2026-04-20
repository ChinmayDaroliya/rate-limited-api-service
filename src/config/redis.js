// Import Redis client library
const Redis = require("ioredis");

// Redis connection configuration with environment fallbacks
const REDIS_CONFIG = {
  // Hostname or IP address of Redis server
  host: process.env.REDIS_HOST || "127.0.0.1",
  // Port number of Redis server
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  // Authentication password for Redis server
  password: process.env.REDIS_PASSWORD || undefined,
  // TLS encryption configuration for secure connections
  tls: process.env.REDIS_TLS === "true" ? {} : undefined,

  // Exponential backoff retry strategy for connection failures
  retryStrategy(times) {
    if (times > 5) {
      console.error("[Redis] Max retries reached. Giving up.");
      return null; 
    }
    const delay = Math.min(times * 200, 2000); 
    console.warn(`[Redis] Retrying connection in ${delay}ms... (attempt ${times})`);
    return delay;
  },

  // Disable offline queue for immediate failure feedback
  enableOfflineQueue: false,
  // Connect only when first used to reduce unnecessary connections
  lazyConnect: true, 
};

// Global Redis client and availability state
let redisClient = null;
let isRedisAvailable = false;

// Establish Redis connection with event handlers
async function connectRedis() {
  redisClient = new Redis(REDIS_CONFIG);

  // Connection success event handler
  redisClient.on("connect", () => {
    console.log("[Redis] Connected successfully ✓");
    isRedisAvailable = true;
  });

  // Connection error event handler
  redisClient.on("error", (err) => {
    console.error("[Redis] Connection error:", err.message);
    isRedisAvailable = false;
  });

  // Connection close event handler
  redisClient.on("close", () => {
    console.warn("[Redis] Connection closed.");
    isRedisAvailable = false;
  });

  try {
    // Attempt to establish connection
    await redisClient.connect();
  } catch (err) {
    console.error("[Redis] Failed to connect on startup:", err.message);
    console.warn("[Redis] Falling back to in-memory rate limiting.");
    isRedisAvailable = false;
  }

  return redisClient;
}

// Get Redis client instance
function getRedisClient() {
  return redisClient;
}

// Get Redis connection status
function getRedisStatus() {
  return isRedisAvailable;
}

// Export Redis connection functions
module.exports = { connectRedis, getRedisClient, getRedisStatus };