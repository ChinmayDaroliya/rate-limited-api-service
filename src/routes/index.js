const { Router } = require("express");
const rateLimiterMiddleware  = require("../middleware/rateLimiter");
const { handleRequest, handleStats } = require("../controllers/requestController");

const router = Router();

router.get("/health", (req, res) => {
  res.status(200).json({
    status:    "ok",
    timestamp: new Date().toISOString(),
    uptime:    `${Math.floor(process.uptime())}s`,
  });
});

router.post("/request", rateLimiterMiddleware(), handleRequest);

router.get("/stats", handleStats);

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

module.exports = router;