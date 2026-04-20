# Rate-Limited API Service

A production-grade API service with Redis-backed sliding window rate limiting, built with Node.js and Express.

---

## Overview

This service exposes two endpoints:

| Method | Endpoint    | Description                               |
|--------|-------------|-------------------------------------------|
| POST   | `/request`  | Accept a user request (rate limited)      |
| GET    | `/stats`    | View per-user request statistics          |
| GET    | `/health`   | Health check                              |

**Rate limit:** 5 requests per user per 60-second sliding window.  
Exceeding the limit returns **HTTP 429 Too Many Requests**.

---

## Architecture

```
src/
├── app.js                  # Entry point: server startup, global middleware
├── config/
│   └── redis.js            # Redis connection, retry logic, status tracking
├── controllers/
│   └── requestController.js # HTTP request/response handling
├── middleware/
│   └── rateLimiter.js      # Express middleware: rate limit enforcement
├── routes/
│   └── index.js            # Route definitions
├── services/
│   ├── rateLimitService.js  # Core rate limiting logic (Redis Lua script)
│   └── statsService.js      # Stats tracking and retrieval
└── utils/
    └── memoryStore.js       # In-memory fallback when Redis is unavailable
```

### Request Flow

```
Client Request
     │
     ▼
Express App (app.js)
     │
     ▼
rateLimiter Middleware
     │
     ├── [DENIED]  → HTTP 429 + Retry-After header
     │
     └── [ALLOWED] → Controller → recordRequest → HTTP 200
```

---

## Setup

### Prerequisites

- Node.js 18+
- Redis 6+ (or Docker)

### 1. Clone and install

```bash
git clone <repo-url>
cd rate-limited-api
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env if needed — defaults work out of the box for local development
```

### 3. Start Redis

**Option A — Docker (easiest):**
```bash
docker run -d -p 6379:6379 --name redis-local redis:7-alpine
```

**Option B — Local install:**
```bash
# macOS
brew install redis && brew services start redis

# Ubuntu/Debian
sudo apt install redis-server && sudo systemctl start redis
```

**No Redis?** The app automatically falls back to in-memory rate limiting.

### 4. Start the server

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

You should see:
```
─────────────────────────────────────────
   Rate-Limited API Service
─────────────────────────────────────────
[Redis] Connected successfully ✓
[Server] Listening on http://localhost:3000
[Server] Rate limit: 5 req / 60s
─────────────────────────────────────────
```

---

## API Usage

### POST /request

**Request:**
```bash
curl -X POST http://localhost:3000/request \
  -H "Content-Type: application/json" \
  -d '{"user_id": "alice", "payload": "hello world"}'
```

**Success response (200):**
```json
{
  "success": true,
  "message": "Request accepted",
  "data": {
    "userId": "alice",
    "payloadReceived": "hello world",
    "processedAt": "2024-01-15T10:30:00.000Z",
    "requestCount": 1,
    "rateLimitSource": "redis"
  }
}
```

**Rate limit exceeded (429):**
```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "message": "You can make 5 requests per 60 seconds.",
  "retryAfter": "45 second(s)",
  "requestCount": 5
}
```

Response headers on every request:
```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4
X-RateLimit-Reset: 1705312260
```

---

### GET /stats

**All users:**
```bash
curl http://localhost:3000/stats
```

```json
{
  "success": true,
  "data": {
    "users": {
      "alice": { "total": 12, "requestsInLastMinute": 3 },
      "bob":   { "total": 7,  "requestsInLastMinute": 5 }
    },
    "totalUsers": 2,
    "source": "redis",
    "generatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

**Single user:**
```bash
curl "http://localhost:3000/stats?user_id=alice"
```

```json
{
  "success": true,
  "data": {
    "userId": "alice",
    "total": 12,
    "requestsInLastMinute": 3,
    "source": "redis"
  }
}
```

---

## Testing

### Manual testing with curl

```bash
# Send 6 requests — 5th succeeds, 6th gets 429
for i in {1..6}; do
  echo "Request $i:"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" \
    -X POST http://localhost:3000/request \
    -H "Content-Type: application/json" \
    -d "{\"user_id\": \"testuser\", \"payload\": \"test\"}"
done
```

Expected output:
```
Request 1: HTTP 200
Request 2: HTTP 200
Request 3: HTTP 200
Request 4: HTTP 200
Request 5: HTTP 200
Request 6: HTTP 429
```

### Simulating concurrent requests (race condition test)

This is the most important test — it verifies atomicity under parallel load:

```bash
# Send 10 concurrent requests simultaneously for the same user
# Only 5 should succeed (rate limit = 5)
for i in {1..10}; do
  curl -s -o /dev/null -w "HTTP %{http_code}\n" \
    -X POST http://localhost:3000/request \
    -H "Content-Type: application/json" \
    -d '{"user_id": "concurrent_user", "payload": "parallel test"}' &
done
wait
```

**Expected:** Exactly 5 × `HTTP 200` and 5 × `HTTP 429` (in any order).  
If you see 6 or more 200s, there's a race condition — our Lua script prevents this.

### Testing with Postman

1. Open Postman → New Request
2. Set method to `POST`, URL to `http://localhost:3000/request`
3. Body → raw → JSON:
   ```json
   { "user_id": "alice", "payload": "test" }
   ```
4. Click **Send** 6 times rapidly — the 6th should return 429
5. Check the `X-RateLimit-*` headers in the response

---

## Test Cases

### **Basic Functionality Tests**

#### Test 1: Successful Request
```bash
# Request
curl -X POST http://localhost:3000/request \
  -H "Content-Type: application/json" \
  -d '{"user_id": "alice", "payload": "test message"}'

# Expected Response: HTTP 200
{
  "success": true,
  "message": "Request accepted",
  "data": {
    "userId": "alice",
    "payloadReceived": "test message",
    "processedAt": "2024-01-15T10:30:00.000Z",
    "requestCount": 1,
    "rateLimitSource": "redis"
  }
}
```

#### Test 2: Rate Limit Enforcement
```bash
# Send 6 requests rapidly (5 should succeed, 6th should fail)
for i in {1..6}; do
  echo "Request $i:"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" \
    -X POST http://localhost:3000/request \
    -H "Content-Type: application/json" \
    -d '{"user_id": "testuser", "payload": "rate limit test"}'
done

# Expected: 5 × HTTP 200, 1 × HTTP 429
```

#### Test 3: Stats Endpoint
```bash
# Get all user stats
curl http://localhost:3000/stats

# Get specific user stats
curl "http://localhost:3000/stats?user_id=alice"

# Expected Response: HTTP 200 with user statistics
```

### **Concurrency Tests**

#### Test 4: Concurrent Requests (Race Condition Test)
```bash
# Send 10 requests simultaneously for same user
# Only 5 should succeed (verifies atomic rate limiting)
for i in {1..10}; do
  curl -s -o /dev/null -w "HTTP %{http_code}\n" \
    -X POST http://localhost:3000/request \
    -H "Content-Type: application/json" \
    -d '{"user_id": "concurrent_user", "payload": "parallel test"}' &
done
wait

# Expected: Exactly 5 × HTTP 200 and 5 × HTTP 429
# If you see 6+ HTTP 200, there's a race condition
```

### **Error Handling Tests**

#### Test 5: Missing Required Fields
```bash
# Missing user_id
curl -X POST http://localhost:3000/request \
  -H "Content-Type: application/json" \
  -d '{"payload": "test"}'
# Expected: HTTP 400 - "Missing required field: user_id"

# Missing payload
curl -X POST http://localhost:3000/request \
  -H "Content-Type: application/json" \
  -d '{"user_id": "alice"}'
# Expected: HTTP 400 - "Missing required field: payload"

# Invalid user_id
curl -X POST http://localhost:3000/request \
  -H "Content-Type: application/json" \
  -d '{"user_id": "", "payload": "test"}'
# Expected: HTTP 400 - "user_id must be a non-empty string"
```

### **Fallback Tests**

#### Test 6: Redis Fallback
```bash
# Stop Redis and verify in-memory fallback
docker stop redis-local

# Send requests - should still work with in-memory rate limiting
curl -X POST http://localhost:3000/request \
  -H "Content-Type: application/json" \
  -d '{"user_id": "fallback_test", "payload": "memory test"}'

# Expected: HTTP 200 with "rateLimitSource": "memory"
```

### **Bonus Feature Tests**

#### Test 7: Request Queue (when USE_QUEUE=true)
```bash
# Set USE_QUEUE=true in .env and restart server
# Send 8 requests for same user (5 succeed, 3 queued)
for i in {1..8}; do
  curl -s -X POST http://localhost:3000/request \
    -H "Content-Type: application/json" \
    -d '{"user_id": "queue_test", "payload": "queue test"}' \
    -w "HTTP %{http_code} Queue-Pos: %{header_redirect}\n"
done

# Expected: First 5 return HTTP 200, next 3 return HTTP 200 after waiting
# Check X-Queue-Position headers for queued requests
```

---

## Design Decisions

### Why Sliding Window over Fixed Window?

A fixed window resets every 60 seconds. A user could send 5 requests at t=59s and 5 more at t=61s — effectively 10 requests in 2 seconds.

The sliding window always looks at the last 60 seconds from *right now*, preventing this burst exploit.

### Why a Lua Script for Redis?

Individual Redis commands are atomic, but a sequence of commands (remove old entries → count → add new entry) is not. Between any two commands, another request could sneak in and read a stale count — a **race condition**.

A Lua script executes server-side as a single atomic unit. Redis guarantees no other command runs while the script is executing.

### Why Pipeline for Stats?

Redis pipeline batches multiple commands into a single network round-trip. Fetching stats for 1000 users without pipelining would cost 2000 network round-trips. With pipelining: 1 round-trip.

### Fail Open vs Fail Closed

When Redis throws an unexpected error mid-request, we fail **open** (let the request through). This prioritizes availability over strict rate limiting — acceptable for most APIs. For security-critical APIs (payment processing etc.), you would fail **closed**.

---

## Limitations

- **Single-user stats scan:** `GET /stats` (all users) uses Redis `SCAN` — efficient but not instant with millions of users. Production would use pagination or a dedicated analytics store.
- **In-memory fallback is per-process:** If you run multiple server instances and Redis goes down, each instance tracks limits independently. Users could exceed limits across instances during an outage.
- **No authentication:** The `user_id` is user-supplied and not verified. Production would use JWT tokens or API keys.
- **No persistence:** Redis data is lost on Redis restart (unless persistence is configured). Total counts would reset.

---

## Future Improvements

- [ ] **Authentication:** JWT middleware to verify `user_id` matches the authenticated user
- [ ] **Configurable limits per user tier:** Premium users get 100 req/min, free users get 5
- [ ] **Request queue:** Instead of rejecting at 429, queue requests and process them when the window allows (using Bull/BullMQ)
- [ ] **Redis Cluster:** For high availability and horizontal scaling of Redis itself
- [ ] **Prometheus metrics:** Expose `/metrics` endpoint for monitoring rate limit hit rates
- [ ] **Redis persistence (AOF):** Survive Redis restarts without losing counters

---

## Deployment Notes

### Docker Compose (recommended for local dev)

```yaml
version: "3.9"
services:
  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - REDIS_HOST=redis
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

### Production (cloud)
- Use **Redis Cloud**, **AWS ElastiCache**, or **Upstash** (serverless Redis)
- Set `REDIS_PASSWORD` and `REDIS_TLS=true` in production environment
- Deploy the Node.js app to **Railway**, **Render**, **Fly.io**, or **AWS ECS**

---

## Tech Stack

| Technology | Purpose |
|------------|---------|
| Node.js    | Runtime |
| Express    | HTTP framework |
| ioredis    | Redis client |
| Redis      | Rate limit store (sliding window via sorted sets + Lua) |
| dotenv     | Environment variable management |