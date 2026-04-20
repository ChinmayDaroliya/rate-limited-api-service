// Import stats service functions
const { recordRequest } = require("../services/statsService");
const { getUserStats, getAllStats } = require("../services/statsService");

// Handle POST /request endpoint
async function handleRequest(req, res) {
  // Extract user ID and payload from request body
  const { user_id, payload } = req.body;
  const userId               = req.userId; // From rate limiter middleware

  // Validate required payload field
  if (payload === undefined || payload === null) {
    return res.status(400).json({
      success: false,
      error:   "Missing required field: payload",
    });
  }

  try {
    // Record request in statistics
    await recordRequest(userId);

    // Return success response with metadata
    return res.status(200).json({
      success:    true,
      message:    "Request accepted",
      data: {
        userId,
        payloadReceived: payload,
        processedAt:     new Date().toISOString(),
        requestCount:    req.rateLimitInfo?.requestCount,
        rateLimitSource: req.rateLimitInfo?.source,
      },
    });
  } catch (err) {
    console.error("[RequestController] handleRequest error:", err);
    return res.status(500).json({
      success: false,
      error:   "Internal server error while processing request",
    });
  }
}

// Handle GET /stats endpoint
async function handleStats(req, res) {
  // Extract user ID from query parameters
  const { user_id } = req.query;

  try {
    if (user_id) {
      // Get stats for specific user
      const userId = String(user_id).trim();
      const stats  = await getUserStats(userId);

      return res.status(200).json({
        success: true,
        data:    stats,
      });
    }

    // Get stats for all users
    const { users, source } = await getAllStats();

    return res.status(200).json({
      success:    true,
      data: {
        users,
        totalUsers: Object.keys(users).length,
        source,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[RequestController] handleStats error:", err);
    return res.status(500).json({
      success: false,
      error:   "Internal server error while fetching stats",
    });
  }
}

// Export controller functions
module.exports = { handleRequest, handleStats };