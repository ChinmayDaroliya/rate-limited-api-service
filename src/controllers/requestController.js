const { recordRequest } = require("../services/statsService");
const { getUserStats, getAllStats } = require("../services/statsService");

async function handleRequest(req, res) {
  const { user_id, payload } = req.body;
  const userId               = req.userId; 

  
  if (payload === undefined || payload === null) {
    return res.status(400).json({
      success: false,
      error:   "Missing required field: payload",
    });
  }

  try {
    await recordRequest(userId);

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

async function handleStats(req, res) {
  const { user_id } = req.query;

  try {
    if (user_id) {
      const userId = String(user_id).trim();
      const stats  = await getUserStats(userId);

      return res.status(200).json({
        success: true,
        data:    stats,
      });
    }

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

module.exports = { handleRequest, handleStats };