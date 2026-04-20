// Import memory store functions for testing
const {
  checkAndIncrementMemory,
  getStatsMemory,
  getAllStatsMemory,
} = require("../src/utils/memoryStore");

// Helper to reset in-memory store between tests
function resetStore() {
  const mod = require("../src/utils/memoryStore");
  // Clear all stored data
  mod.clearAll();
}

// Test suite for memory store rate limiting
describe("memoryStore — checkAndIncrementMemory", () => {
  beforeEach(() => {
    resetStore();
  });

  it("allows requests up to the limit", () => {
    const userId = "test-allow-" + Date.now();
    const MAX = 3;
    const WINDOW = 60;

    // Make requests up to limit
    const r1 = checkAndIncrementMemory(userId, MAX, WINDOW);
    const r2 = checkAndIncrementMemory(userId, MAX, WINDOW);
    const r3 = checkAndIncrementMemory(userId, MAX, WINDOW);

    // Verify all requests allowed
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r3.requestCount).toBe(3);
  });

  it("blocks the request when limit is exceeded", () => {
    const userId = "test-block-" + Date.now();
    const MAX = 2;
    const WINDOW = 60;

    // Make requests up to limit
    checkAndIncrementMemory(userId, MAX, WINDOW);
    checkAndIncrementMemory(userId, MAX, WINDOW);

    // Next request should be blocked
    const r3 = checkAndIncrementMemory(userId, MAX, WINDOW);

    expect(r3.allowed).toBe(false);
    expect(r3.requestCount).toBe(MAX);
    expect(r3.retryAfter).toBeGreaterThan(0);
  });

  it("correctly increments requestCount", () => {
    const userId = "test-count-" + Date.now();
    const MAX = 5;
    const WINDOW = 60;

    // Make sequential requests
    const r1 = checkAndIncrementMemory(userId, MAX, WINDOW);
    const r2 = checkAndIncrementMemory(userId, MAX, WINDOW);

    // Verify request count increments
    expect(r1.requestCount).toBe(1);
    expect(r2.requestCount).toBe(2);
  });

  it("different users have independent limits", () => {
    const MAX = 1;
    const WINDOW = 60;
    const userA = "user-a-" + Date.now();
    const userB = "user-b-" + Date.now();

    // User A makes 2 requests (should be blocked on second)
    checkAndIncrementMemory(userA, MAX, WINDOW);
    const rA2 = checkAndIncrementMemory(userA, MAX, WINDOW);

    // User B makes 1 request (should be allowed)
    const rB1 = checkAndIncrementMemory(userB, MAX, WINDOW);

    // Verify independent rate limiting
    expect(rA2.allowed).toBe(false);
    expect(rB1.allowed).toBe(true);
  });

  it("allows requests again after the window expires", () => {
    // Use fake timers to control time
    jest.useFakeTimers(); 

    const userId = "test-window-" + Date.now();
    const MAX = 2;
    const WINDOW = 60; 

    // Fill rate limit
    checkAndIncrementMemory(userId, MAX, WINDOW);
    checkAndIncrementMemory(userId, MAX, WINDOW);

    // Next request should be blocked
    const blocked = checkAndIncrementMemory(userId, MAX, WINDOW);
    expect(blocked.allowed).toBe(false);

    // Advance time past window expiry
    jest.setSystemTime(Date.now() + 61_000);

    // Request should now be allowed
    const afterExpiry = checkAndIncrementMemory(userId, MAX, WINDOW);
    expect(afterExpiry.allowed).toBe(true);

    // Restore real timers
    jest.useRealTimers();
  });

  it("returns a positive retryAfter when blocked", () => {
    const userId = "test-retry-" + Date.now();
    const MAX = 1;
    const WINDOW = 60;

    // Fill rate limit
    checkAndIncrementMemory(userId, MAX, WINDOW);
    const r = checkAndIncrementMemory(userId, MAX, WINDOW);

    // Verify retry time is calculated
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(r.retryAfter).toBeLessThanOrEqual(WINDOW);
  });
});

// Test suite for statistics retrieval
describe("memoryStore — getStatsMemory", () => {
  it("returns zero stats for unknown user", () => {
    const stats = getStatsMemory("unknown-user-xyz", 60);
    expect(stats.total).toBe(0);
    expect(stats.requestsInLastMinute).toBe(0);
  });

  it("returns correct total and recent counts", () => {
    const userId = "stats-test-" + Date.now();
    // Make requests
    checkAndIncrementMemory(userId, 10, 60);
    checkAndIncrementMemory(userId, 10, 60);

    const stats = getStatsMemory(userId, 60);
    expect(stats.total).toBe(2);
    expect(stats.requestsInLastMinute).toBe(2);
  });

  it("excludes expired entries from requestsInLastMinute", () => {
    jest.useFakeTimers();

    const userId = "stats-expire-" + Date.now();
    // Make requests
    checkAndIncrementMemory(userId, 10, 60);
    checkAndIncrementMemory(userId, 10, 60);

    // Advance time past window
    jest.setSystemTime(Date.now() + 61_000);

    const stats = getStatsMemory(userId, 60);
    // Total should persist, recent should be 0
    expect(stats.total).toBe(2);
    expect(stats.requestsInLastMinute).toBe(0);

    jest.useRealTimers();
  });
});

// Test suite for all-user statistics
describe("memoryStore — getAllStatsMemory", () => {
  it("returns stats for all users who have made requests", () => {
    const u1 = "all-stats-user1-" + Date.now();
    const u2 = "all-stats-user2-" + Date.now();

    // User 1 makes 1 request
    checkAndIncrementMemory(u1, 10, 60);
    // User 2 makes 2 requests
    checkAndIncrementMemory(u2, 10, 60);
    checkAndIncrementMemory(u2, 10, 60);

    const allStats = getAllStatsMemory(60);

    // Verify both users are included with correct counts
    expect(allStats[u1]).toBeDefined();
    expect(allStats[u1].total).toBe(1);
    expect(allStats[u2]).toBeDefined();
    expect(allStats[u2].total).toBe(2);
  });
});