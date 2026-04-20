// Load environment variables first
require("dotenv").config(); 

const express = require("express");
const { connectRedis } = require("./config/redis");
const routes           = require("./routes");

// Initialize Express app
const app  = express();
const PORT = process.env.PORT || 3000;

// Middleware: JSON parsing and URL encoding
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Request logging middleware with performance metrics
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const userId   = req.body?.user_id || req.query?.user_id || "-";
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.path} ` +
      `user=${userId} status=${res.statusCode} ${duration}ms`
    );
  });
  next();
});

// Route handler
app.use("/", routes);

// Global error handler middleware
app.use((err, req, res, _next) => {
  console.error("[GlobalErrorHandler]", err.stack || err.message);
  res.status(500).json({
    success: false,
    error:   "An unexpected error occurred",
    ...(process.env.NODE_ENV === "development" && { details: err.message }),
  });
});

// Server startup with Redis connection
async function startServer() {
  console.log("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
  console.log("   Rate-Limited API Service");
  console.log("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

  // Establish Redis connection
  await connectRedis();

  // Start Express server
  app.listen(PORT, () => {
    console.log(`[Server] Listening on http://localhost:${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`[Server] Rate limit: ${process.env.RATE_LIMIT_MAX_REQUESTS || 5} req / ${process.env.RATE_LIMIT_WINDOW_SECONDS || 60}s`);
    console.log("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
  });
}

// Process-level error handling
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Process] Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("SIGTERM", () => {
  console.log("[Process] SIGTERM received. Shutting down gracefully...");
  process.exit(0);
});

// Start server with error handling
startServer().catch((err) => {
  console.error("[Server] Failed to start:", err);
  process.exit(1);
});

// Export Express app
module.exports = app; 