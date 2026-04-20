process.env.PORT                    = "3099"; 
process.env.RATE_LIMIT_MAX_REQUESTS = "3";    
process.env.RATE_LIMIT_WINDOW_SECONDS = "60";

jest.mock("../src/config/redis", () => ({
  connectRedis:    jest.fn().mockResolvedValue(undefined),
  getRedisClient:  jest.fn().mockReturnValue(null),
  getRedisStatus:  jest.fn().mockReturnValue(false),
}));

const http    = require("http");
const app     = require("../src/app");

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
          resolve({
            status:  res.statusCode,
            headers: res.headers,
            body:    JSON.parse(data),
          });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function post(body) {
  return makeRequest({ method: "POST", path: "/request", body });
}

function getStats(userId) {
  const path = userId ? `/stats?user_id=${userId}` : "/stats";
  return makeRequest({ method: "GET", path });
}


describe("POST /request — Rate Limiting", () => {
  
  const makeUser = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it("accepts a valid request and returns 200", async () => {
    const r = await post({ user_id: makeUser("basic"), payload: "hello" });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.payloadReceived).toBe("hello");
  });

  it("allows exactly MAX_REQUESTS (3) per user before blocking", async () => {
    const userId = makeUser("limit");

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await post({ user_id: userId, payload: "test" }));
    }

    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[3].status).toBe(429); 
  });

  it("returns 429 with correct error body when rate limited", async () => {
    const userId = makeUser("429-body");

    for (let i = 0; i < 3; i++) {
      await post({ user_id: userId, payload: "x" });
    }

    const r = await post({ user_id: userId, payload: "over limit" });

    expect(r.status).toBe(429);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toBe("Rate limit exceeded");
    expect(r.body.retryAfter).toBeDefined();
    expect(r.body.requestCount).toBe(3);
  });

  it("sets X-RateLimit headers on successful requests", async () => {
    const userId = makeUser("headers");
    const r = await post({ user_id: userId, payload: "test" });

    expect(r.headers["x-ratelimit-limit"]).toBe("3");
    expect(r.headers["x-ratelimit-remaining"]).toBeDefined();
    const remaining = parseInt(r.headers["x-ratelimit-remaining"], 10);
    expect(remaining).toBe(2); // 3 - 1
  });

  it("sets Retry-After header on 429 response", async () => {
    const userId = makeUser("retry-after");
    for (let i = 0; i < 3; i++) await post({ user_id: userId, payload: "x" });

    const r = await post({ user_id: userId, payload: "x" });
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
    expect(parseInt(r.headers["retry-after"], 10)).toBeGreaterThan(0);
  });

  it("tracks users independently — different users don't share limits", async () => {
    const alice = makeUser("alice");
    const bob   = makeUser("bob");

    for (let i = 0; i < 3; i++) await post({ user_id: alice, payload: "x" });
    const aliceBlocked = await post({ user_id: alice, payload: "x" });

    const bobAllowed = await post({ user_id: bob, payload: "x" });

    expect(aliceBlocked.status).toBe(429);
    expect(bobAllowed.status).toBe(200);
  });

  it("returns 400 when user_id is missing", async () => {
    const r = await post({ payload: "no user" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/user_id/i);
  });

  it("returns 400 when payload is missing", async () => {
    const r = await post({ user_id: makeUser("no-payload") });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/payload/i);
  });

  it("handles concurrent requests correctly (no race conditions)", async () => {
    const userId = makeUser("concurrent");

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        post({ user_id: userId, payload: `concurrent_${i}` })
      )
    );

    const allowed = results.filter((r) => r.status === 200).length;
    const denied  = results.filter((r) => r.status === 429).length;

    expect(allowed).toBe(3);
    expect(denied).toBe(3);
  });
});


describe("GET /stats", () => {
  const makeUser = (label) => `stats-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it("returns stats for a single user", async () => {
    const userId = makeUser("single");
    await post({ user_id: userId, payload: "a" });
    await post({ user_id: userId, payload: "b" });

    const r = await getStats(userId);

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.userId).toBe(userId);
    expect(r.body.data.total).toBe(2);
    expect(r.body.data.requestsInLastMinute).toBe(2);
  });

  it("returns zero stats for a user who made no requests", async () => {
    const r = await getStats("completely-unknown-user-xyzxyz");
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBe(0);
    expect(r.body.data.requestsInLastMinute).toBe(0);
  });

  it("returns stats for all users when no user_id provided", async () => {
    const u1 = makeUser("all-1");
    const u2 = makeUser("all-2");
    await post({ user_id: u1, payload: "x" });
    await post({ user_id: u2, payload: "x" });

    const r = await getStats();

    expect(r.status).toBe(200);
    expect(r.body.data.users).toBeDefined();
    expect(r.body.data.totalUsers).toBeGreaterThanOrEqual(2);
  });
});


describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const r = await makeRequest({ method: "GET", path: "/health" });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(r.body.uptime).toBeDefined();
  });
});


describe("Unknown routes", () => {
  it("returns 404 for undefined endpoints", async () => {
    const r = await makeRequest({ method: "GET", path: "/does-not-exist" });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not found/i);
  });
});