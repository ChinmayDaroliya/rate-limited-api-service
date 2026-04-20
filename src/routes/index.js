// Import Express router and middleware
const { Router } = require("express");
const rateLimiterMiddleware  = require("../middleware/rateLimiter");
const { handleRequest, handleStats } = require("../controllers/requestController");

// Initialize Express router
const router = Router();

// Health check endpoint
router.get("/health", (req, res) => {
  res.status(200).json({
    status:    "ok",
    timestamp: new Date().toISOString(),
    uptime:    `${Math.floor(process.uptime())}s`,
  });
});

// Request endpoint with rate limiting
router.post("/request", rateLimiterMiddleware(), handleRequest);

// Statistics endpoint
router.get("/stats", handleStats);

// 404 handler for unknown routes
router.use((req, res) => {
  res.status(404).json({
    success: false,
    error:   `Route not found: ${req.method} ${req.path}`,
    availableRoutes: [
      "GET  /health",
      "POST /request",
      "GET  /stats",
      "GET  /stats?user_id={id}",
    ],
  });
});

// Export router configuration
module.exports = router;