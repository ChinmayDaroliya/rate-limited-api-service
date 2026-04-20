// Import rate limiting and queue services
const { checkRateLimit, MAX_REQUESTS, WINDOW_SECONDS } = require("../services/rateLimitService");
const {
  enqueueRequest,
  getQueueDepth,
  QueueFullError,
  QueueTimeoutError,
} = require("../services/queueService");

/**
 * Rate limiting middleware with optional queuing
 * @param {object} options
 * @param {boolean} options.useQueue - Queue requests instead of rejecting
 */
function rateLimiterMiddleware({ useQueue = process.env.USE_QUEUE === "true" } = {}) {
  return async function rateLimiter(req, res, next) {
    // Extract user_id from request
    const rawUserId = req.body?.user_id || req.query?.user_id;

    // Validate user_id presence and format
    if (!rawUserId) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: user_id",
      });
    }

    if (typeof rawUserId !== "string" || rawUserId.trim() === "") {
      return res.status(400).json({
        success: false,
        error: "user_id must be a non-empty string",
      });
    }

    const userId = rawUserId.trim();

    try {
      // Check rate limit for user
      const { allowed, requestCount, retryAfter, source } = await checkRateLimit(userId);

      if (allowed) {
        // Request allowed - attach metadata and continue
        req.userId        = userId;
        req.rateLimitInfo = { requestCount, source, queued: false };

        // Set rate limit headers
        res.set({
          "X-RateLimit-Limit":     MAX_REQUESTS,
          "X-RateLimit-Remaining": Math.max(0, MAX_REQUESTS - requestCount),
          "X-RateLimit-Source":    source,
        });

        return next();
      }

      // Queue handling if enabled
      if (useQueue) {
        // Get current queue depth for user
        const currentDepth = getQueueDepth(userId);

        try {
          // Attempt to enqueue request
          const queueResult = await enqueueRequest(userId);

          // Request queued successfully
          req.userId        = userId;
          req.rateLimitInfo = {
            requestCount: queueResult.requestCount,
            source:       queueResult.source,
            queued:       true,
          };

          // Set headers including queue position
          res.set({
            "X-RateLimit-Limit":     MAX_REQUESTS,
            "X-RateLimit-Remaining": Math.max(0, MAX_REQUESTS - queueResult.requestCount),
            "X-RateLimit-Source":    queueResult.source,
            "X-Queue-Position":      currentDepth + 1,
          });

          return next();

        } catch (queueErr) {
          // Handle queue-specific errors
          const isTimeout = queueErr instanceof QueueTimeoutError;
          const isFull    = queueErr instanceof QueueFullError;

          res.set({ "Retry-After": retryAfter });

          return res.status(429).json({
            success:    false,
            error:      "Rate limit exceeded",
            reason:     isTimeout ? "Queue wait timed out"
                      : isFull   ? "Queue is full"
                      :            "Unknown queue error",
            message:    `You can make ${MAX_REQUESTS} requests per ${WINDOW_SECONDS} seconds.`,
            retryAfter: `${retryAfter} second(s)`,
            requestCount,
          });
        }
      }

      // Direct rejection when queuing disabled
      res.set({
        "X-RateLimit-Limit":     MAX_REQUESTS,
        "X-RateLimit-Remaining": 0,
        "X-RateLimit-Reset":     Math.floor(Date.now() / 1000) + retryAfter,
        "Retry-After":           retryAfter,
      });

      return res.status(429).json({
        success:     false,
        error:       "Rate limit exceeded",
        message:     `You can make ${MAX_REQUESTS} requests per ${WINDOW_SECONDS} seconds.`,
        retryAfter:  `${retryAfter} second(s)`,
        requestCount,
      });

    } catch (err) {
      // Fail open: allow request if rate limiting fails
      console.error("[RateLimiter Middleware] Unexpected error:", err);

      req.userId = userId;
      return next();
    }
  };
}

module.exports = rateLimiterMiddleware;