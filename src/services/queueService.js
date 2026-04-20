// Import rate limit checker for queue retries
const { checkRateLimit } = require("./rateLimitService");

// Queue configuration constants
const QUEUE_CONFIG = {
  maxQueueSizePerUser: 10,       // Max requests per user queue
  maxWaitMs:          10_000,    // Max wait time in ms
  initialRetryMs:     200,       // Initial retry delay
  maxRetryMs:         2_000,     // Max retry delay
  backoffMultiplier:  1.5,       // Exponential backoff factor
};

// In-memory queue storage per user
const queues = new Map();

// Get current queue depth for user
function getQueueDepth(userId) {
  return queues.get(userId)?.length ?? 0;
}

/**
 * Enqueues rate-limited request with exponential backoff retry
 * @param {string} userId
 * @returns {Promise<{ requestCount: number, source: string }>}
 */
function enqueueRequest(userId) {
  // Initialize queue for user if not exists
  if (!queues.has(userId)) {
    queues.set(userId, []);
  }

  const queue = queues.get(userId);

  // Check queue capacity
  if (queue.length >= QUEUE_CONFIG.maxQueueSizePerUser) {
    return Promise.reject(
      new QueueFullError(
        `Queue full for user "${userId}". ` +
        `Max ${QUEUE_CONFIG.maxQueueSizePerUser} requests can wait simultaneously.`
      )
    );
  }

  // Create promise for queued request
  return new Promise((resolve, reject) => {
    const enqueuedAt = Date.now();

    // Set timeout for max wait time
    const timer = setTimeout(() => {
      // Remove item from queue on timeout
      const idx = queue.indexOf(item);
      if (idx !== -1) queue.splice(idx, 1);
      if (queue.length === 0) queues.delete(userId);

      // Reject with timeout error
      reject(new QueueTimeoutError(
        `Request for user "${userId}" timed out after ${QUEUE_CONFIG.maxWaitMs}ms in queue.`
      ));
    }, QUEUE_CONFIG.maxWaitMs);

    const item = { resolve, reject, enqueuedAt, timer };
    queue.push(item);

    // Start retry process
    scheduleRetry(userId, QUEUE_CONFIG.initialRetryMs);
  });
}

/**
 * Schedules exponential backoff retry for queued requests
 * @param {string} userId
 * @param {number} delayMs - Retry delay in milliseconds
 */
function scheduleRetry(userId, delayMs) {
  // Schedule retry after delay
  setTimeout(async () => {
    const queue = queues.get(userId);
    if (!queue || queue.length === 0) return; // No items waiting

    const item = queue[0]; // Process first in queue

    // Check if request has timed out
    const elapsed = Date.now() - item.enqueuedAt;
    if (elapsed >= QUEUE_CONFIG.maxWaitMs) {
      return;
    }

    try {
      // Check if rate limit allows request now
      const result = await checkRateLimit(userId);

      if (result.allowed) {
        // Success: remove from queue and resolve
        queue.shift(); 
        clearTimeout(item.timer);

        if (queue.length === 0) {
          queues.delete(userId); 
        }

        item.resolve({ requestCount: result.requestCount, source: result.source });

        // Process next item if any
        if (queue.length > 0) {
          scheduleRetry(userId, QUEUE_CONFIG.initialRetryMs);
        }
      } else {
        // Rate limited: schedule next retry with exponential backoff
        const nextDelay = Math.min(delayMs * QUEUE_CONFIG.backoffMultiplier, QUEUE_CONFIG.maxRetryMs);
        scheduleRetry(userId, nextDelay);
      }
    } catch (err) {
      // Error: remove from queue and reject
      queue.shift();
      clearTimeout(item.timer);
      if (queue.length === 0) queues.delete(userId);
      item.reject(err);
    }
  }, delayMs);
}

// Custom error classes for queue operations
class QueueFullError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueueFullError";
    this.code = "QUEUE_FULL";
  }
}

class QueueTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueueTimeoutError";
    this.code = "QUEUE_TIMEOUT";
  }
}

// Export queue service functions and error classes
module.exports = {
  enqueueRequest,
  getQueueDepth,
  QueueFullError,
  QueueTimeoutError,
  QUEUE_CONFIG,
};