const { checkRateLimit } = require("./rateLimitService");

const QUEUE_CONFIG = {
  maxQueueSizePerUser: 10,       
  maxWaitMs:          10_000,    
  initialRetryMs:     200,       
  maxRetryMs:         2_000,     
  backoffMultiplier:  1.5,       
};

const queues = new Map();

function getQueueDepth(userId) {
  return queues.get(userId)?.length ?? 0;
}

/**
 * Attempts to enqueue a request that was rejected by the rate limiter.
 *
 * Returns a Promise that resolves with rate-limit info when a slot opens,
 * or rejects with an error if the timeout expires or the queue is full.
 *
 * @param {string} userId
 * @returns {Promise<{ requestCount: number, source: string }>}
 */
function enqueueRequest(userId) {
  
  if (!queues.has(userId)) {
    queues.set(userId, []);
  }

  const queue = queues.get(userId);

  if (queue.length >= QUEUE_CONFIG.maxQueueSizePerUser) {
    return Promise.reject(
      new QueueFullError(
        `Queue full for user "${userId}". ` +
        `Max ${QUEUE_CONFIG.maxQueueSizePerUser} requests can wait simultaneously.`
      )
    );
  }

  return new Promise((resolve, reject) => {
    const enqueuedAt = Date.now();

    const timer = setTimeout(() => {
      const idx = queue.indexOf(item);
      if (idx !== -1) queue.splice(idx, 1);
      if (queue.length === 0) queues.delete(userId);

      reject(new QueueTimeoutError(
        `Request for user "${userId}" timed out after ${QUEUE_CONFIG.maxWaitMs}ms in queue.`
      ));
    }, QUEUE_CONFIG.maxWaitMs);

    const item = { resolve, reject, enqueuedAt, timer };
    queue.push(item);

    scheduleRetry(userId, QUEUE_CONFIG.initialRetryMs);
  });
}

/**
 * Schedules a retry attempt for the next waiting item in a user's queue.
 *
 * Uses exponential backoff:
 *   attempt 1: wait 200ms
 *   attempt 2: wait 300ms (200 × 1.5)
 *   attempt 3: wait 450ms (300 × 1.5)
 *   ...
 *   max wait:  2000ms
 *
 * @param {string} userId
 * @param {number} delayMs - how long to wait before this retry
 */
function scheduleRetry(userId, delayMs) {
  setTimeout(async () => {
    const queue = queues.get(userId);
    if (!queue || queue.length === 0) return; // nothing waiting

    const item = queue[0];

    const elapsed = Date.now() - item.enqueuedAt;
    if (elapsed >= QUEUE_CONFIG.maxWaitMs) {
      return;
    }

    try {
      const result = await checkRateLimit(userId);

      if (result.allowed) {
        queue.shift(); 
        clearTimeout(item.timer);

        if (queue.length === 0) {
          queues.delete(userId); 
        }

        item.resolve({ requestCount: result.requestCount, source: result.source });

        if (queue.length > 0) {
          scheduleRetry(userId, QUEUE_CONFIG.initialRetryMs);
        }
      } else {
        const nextDelay = Math.min(delayMs * QUEUE_CONFIG.backoffMultiplier, QUEUE_CONFIG.maxRetryMs);
        scheduleRetry(userId, nextDelay);
      }
    } catch (err) {
      queue.shift();
      clearTimeout(item.timer);
      if (queue.length === 0) queues.delete(userId);
      item.reject(err);
    }
  }, delayMs);
}


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

module.exports = {
  enqueueRequest,
  getQueueDepth,
  QueueFullError,
  QueueTimeoutError,
  QUEUE_CONFIG,
};