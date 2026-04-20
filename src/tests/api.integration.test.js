// Configure test environment
process.env.PORT                    = "3099"; 
process.env.RATE_LIMIT_MAX_REQUESTS = "3";    
process.env.RATE_LIMIT_WINDOW_SECONDS = "60";

// Mock Redis to force in-memory rate limiting
jest.mock("../src/config/redis", () => ({
  connectRedis:    jest.fn().mockResolvedValue(undefined),
  getRedisClient:  jest.fn().mockReturnValue(null),
  getRedisStatus:  jest.fn().mockReturnValue(false),
}));

// Import HTTP module and app for integration testing
const http    = require("http");
const app     = require("../src/app");

// Helper function for making HTTP requests
function makeRequest({ method = "GET", path = "/", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options  = {
      hostname: "localhost",
      port:     3099,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(postData && { "Content-Length": Buffer.byteLength(postData) }),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          // Try to parse JSON response
          resolve({
            status:  res.statusCode,
            headers: res.headers,
            body:    JSON.parse(data),
          });
        } catch {
          // Return raw response if JSON parsing fails
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    // Handle request errors
    req.on("error", reject);
    // Write request data if present
    if (postData) req.write(postData);
    // End the request
    req.end();
  });
}

// Helper for POST requests
function post(body) {
  // Make a POST request to the /request endpoint
  return makeRequest({ method: "POST", path: "/request", body });
}

// Helper for GET stats requests
function getStats(userId) {
  // Determine the path based on the presence of a user ID
  const path = userId ? `/stats?user_id=${userId}` : "/stats";
  // Make a GET request to the stats endpoint
  return makeRequest({ method: "GET", path });
}

// Test suite for rate limiting endpoint
describe("POST /request - Rate Limiting", () => {
  // Helper to generate unique user IDs
  const makeUser = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Test case: basic request acceptance
  it("accepts a valid request and returns 200", async () => {
    // Make a POST request with a valid user ID and payload
    const r = await post({ user_id: makeUser("basic"), payload: "hello" });
    // Verify the response status and body
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.payloadReceived).toBe("hello");
  });

  // Test case: exact rate limit enforcement
  it("allows exactly MAX_REQUESTS (3) per user before blocking", async () => {
    // Create a user ID for testing
    const userId = makeUser("limit");

    // Initialize an array to store the results
    const results = [];
    // Make 4 requests (3 should be allowed, 1 blocked)
    for (let i = 0; i < 4; i++) {
      results.push(await post({ user_id: userId, payload: "test" }));
    }

    // Verify the rate limiting
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[3].status).toBe(429); 
  });

  // Test case: proper error response for rate limiting
  it("returns 429 with correct error body when rate limited", async () => {
    // Create a user ID for testing
    const userId = makeUser("429-body");

    // Fill the rate limit
    for (let i = 0; i < 3; i++) {
      await post({ user_id: userId, payload: "x" });
    }

    // Make a request that should be rate limited
    const r = await post({ user_id: userId, payload: "over limit" });

    // Verify the response status and body
    expect(r.status).toBe(429);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toBe("Rate limit exceeded");
    expect(r.body.retryAfter).toBeDefined();
    expect(r.body.requestCount).toBe(3);
  });

  // Test case: rate limit headers
  it("sets X-RateLimit headers on successful requests", async () => {
    // Create a user ID for testing
    const userId = makeUser("headers");
    // Make a POST request
    const r = await post({ user_id: userId, payload: "test" });

    // Verify the rate limit headers
    expect(r.headers["x-ratelimit-limit"]).toBe("3");
    expect(r.headers["x-ratelimit-remaining"]).toBeDefined();
    const remaining = parseInt(r.headers["x-ratelimit-remaining"], 10);
    expect(remaining).toBe(2); // 3 - 1
  });

  // Test case: retry header on rate limit
  it("sets Retry-After header on 429 response", async () => {
    // Create a user ID for testing
    const userId = makeUser("retry-after");
    // Fill the rate limit
    for (let i = 0; i < 3; i++) await post({ user_id: userId, payload: "x" });

    // Make a request that should be rate limited
    const r = await post({ user_id: userId, payload: "x" });
    // Verify the response status and retry header
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
    expect(parseInt(r.headers["retry-after"], 10)).toBeGreaterThan(0);
  });

  // Test case: independent user rate limiting
  it("tracks users independently - different users don't share limits", async () => {
    // Create user IDs for testing
    const alice = makeUser("alice");
    const bob   = makeUser("bob");

    // Fill Alice's rate limit
    for (let i = 0; i < 3; i++) await post({ user_id: alice, payload: "x" });
    // Make a request that should be rate limited for Alice
    const aliceBlocked = await post({ user_id: alice, payload: "x" });

    // Make a request for Bob
    const bobAllowed = await post({ user_id: bob, payload: "x" });

    // Verify the responses
    expect(aliceBlocked.status).toBe(429);
    expect(bobAllowed.status).toBe(200);
  });

  // Test case: validation errors
  it("returns 400 when user_id is missing", async () => {
    // Make a POST request without a user ID
    const r = await post({ payload: "no user" });
    // Verify the response status and error
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/user_id/i);
  });

  it("returns 400 when payload is missing", async () => {
    // Make a POST request without a payload
    const r = await post({ user_id: makeUser("no-payload") });
    // Verify the response status and error
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/payload/i);
  });

  // Test case: concurrent request handling
  it("handles concurrent requests correctly (no race conditions)", async () => {
    // Create a user ID for testing
    const userId = makeUser("concurrent");

    // Make 6 concurrent requests
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        post({ user_id: userId, payload: `concurrent_${i}` })
      )
    );

    // Verify exactly 3 allowed, 3 blocked
    const allowed = results.filter((r) => r.status === 200).length;
    const denied  = results.filter((r) => r.status === 429).length;

    expect(allowed).toBe(3);
    expect(denied).toBe(3);
  });
});

// Test suite for statistics endpoint
describe("GET /stats", () => {
  // Helper to generate unique user IDs
  const makeUser = (label) => `stats-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Test case: single user statistics
  it("returns stats for a single user", async () => {
    // Create a user ID for testing
    const userId = makeUser("single");
    // Make two requests for the user
    await post({ user_id: userId, payload: "a" });
    await post({ user_id: userId, payload: "b" });

    // Get the stats for the user
    const r = await getStats(userId);

    // Verify the response status and body
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.userId).toBe(userId);
    expect(r.body.data.total).toBe(2);
    expect(r.body.data.requestsInLastMinute).toBe(2);
  });

  // Test case: unknown user statistics
  it("returns zero stats for a user who made no requests", async () => {
    // Get the stats for an unknown user
    const r = await getStats("completely-unknown-user-xyzxyz");
    // Verify the response status and body
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBe(0);
    expect(r.body.data.requestsInLastMinute).toBe(0);
  });

  // Test case: all user statistics
  it("returns stats for all users when no user_id provided", async () => {
    // Create user IDs for testing
    const u1 = makeUser("all-1");
    const u2 = makeUser("all-2");
    // Make requests for the users
    await post({ user_id: u1, payload: "x" });
    await post({ user_id: u2, payload: "x" });

    // Get the stats for all users
    const r = await getStats();

    // Verify the response status and body
    expect(r.status).toBe(200);
    expect(r.body.data.users).toBeDefined();
    expect(r.body.data.totalUsers).toBeGreaterThanOrEqual(2);
  });
});

// Test suite for health endpoint
describe("GET /health", () => {
  // Test case: health check response
  it("returns 200 with status ok", async () => {
    // Make a GET request to the health endpoint
    const r = await makeRequest({ method: "GET", path: "/health" });
    // Verify the response status and body
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(r.body.uptime).toBeDefined();
  });
});

// Test suite for unknown routes
describe("Unknown routes", () => {
  // Test case: 404 for undefined endpoints
  it("returns 404 for undefined endpoints", async () => {
    // Make a GET request to an unknown endpoint
    const r = await makeRequest({ method: "GET", path: "/does-not-exist" });
    // Verify the response status and error
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not found/i);
  });
});