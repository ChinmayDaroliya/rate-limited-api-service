const { checkRateLimit, MAX_REQUESTS, WINDOW_SECONDS } = require("../services/rateLimitService");
const {
  enqueueRequest,
  getQueueDepth,
  QueueFullError,
  QueueTimeoutError,
} = require("../services/queueService");

/**
 * @param {object}  options
 * @param {boolean} options.useQueue - If true, queue rate-limited requests instead of
 *                                     rejecting immediately. Defaults to USE_QUEUE env var.
 */
function rateLimiterMiddleware({ useQueue = process.env.USE_QUEUE === "true" } = {}) {
  return async function rateLimiter(req, res, next) {
    
    const rawUserId = req.body?.user_id || req.query?.user_id;

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
      const { allowed, requestCount, retryAfter, source } = await checkRateLimit(userId);

      if (allowed) {
        req.userId        = userId;
        req.rateLimitInfo = { requestCount, source, queued: false };

        res.set({
          "X-RateLimit-Limit":     MAX_REQUESTS,
          "X-RateLimit-Remaining": Math.max(0, MAX_REQUESTS - requestCount),
          "X-RateLimit-Source":    source,
        });

        return next();
      }

      if (useQueue) {
        
        const currentDepth = getQueueDepth(userId);

        try {
          const queueResult = await enqueueRequest(userId);

          req.userId        = userId;
          req.rateLimitInfo = {
            requestCount: queueResult.requestCount,
            source:       queueResult.source,
            queued:       true,
          };

          res.set({
            "X-RateLimit-Limit":     MAX_REQUESTS,
            "X-RateLimit-Remaining": Math.max(0, MAX_REQUESTS - queueResult.requestCount),
            "X-RateLimit-Source":    queueResult.source,
            "X-Queue-Position":      currentDepth + 1,
          });

          return next();

        } catch (queueErr) {
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
      console.error("[RateLimiter Middleware] Unexpected error:", err);

      req.userId = userId;
      return next();
    }
  };
}

module.exports = rateLimiterMiddleware;