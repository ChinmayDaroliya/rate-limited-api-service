// Mock rate limit service for testing
const mockCheckRateLimit = jest.fn();

// Mock rate limit service module
jest.mock("../src/services/rateLimitService", () => ({
  checkRateLimit:   mockCheckRateLimit,
  MAX_REQUESTS:     3,
  WINDOW_SECONDS:   60,
}));

// Import queue service functions for testing
const {
  enqueueRequest,
  getQueueDepth,
  QueueFullError,
  QueueTimeoutError,
  QUEUE_CONFIG,
} = require("../src/services/queueService");

// Test suite for request queuing
describe("queueService — enqueueRequest", () => {
  beforeEach(() => {
    // Use fake timers for deterministic timing
    jest.useFakeTimers();
    mockCheckRateLimit.mockReset();
  });

  afterEach(() => {
    // Restore real timers after each test
    jest.useRealTimers();
  });

  // Test case: resolves when rate limit clears on the first retry
  it("resolves when rate limit clears on the first retry", async () => {
    // Mock rate limit allowing request
    mockCheckRateLimit.mockResolvedValue({
      allowed: true, requestCount: 3, source: "memory",
    });

    // Enqueue request
    const promise = enqueueRequest("resolve-user");

    // Advance time past initial retry delay
    await jest.advanceTimersByTimeAsync(QUEUE_CONFIG.initialRetryMs + 50);

    // Verify request resolved successfully
    const result = await promise;
    expect(result.requestCount).toBe(3);
    expect(result.source).toBe("memory");
  });

  // Test case: retries multiple times before succeeding
  it("retries multiple times before succeeding", async () => {
    let callCount = 0;

    // Mock rate limit allowing request after 3 attempts
    mockCheckRateLimit.mockImplementation(async () => {
      callCount++;
      return {
        allowed:      callCount >= 3, 
        requestCount: 3,
        retryAfter:   5,
        source:       "memory",
      };
    });

    const promise = enqueueRequest("retry-multi-user");

    // Advance time to allow multiple retries
    await jest.advanceTimersByTimeAsync(4_000);

    const result = await promise;
    expect(result.requestCount).toBe(3);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  // Test case: timeout when queue never resolves
  it("rejects with QueueTimeoutError if never resolved within maxWaitMs", async () => {
    // Mock rate limit always rejecting
    mockCheckRateLimit.mockResolvedValue({
      allowed: false, requestCount: 3, retryAfter: 60, source: "memory",
    });

    const promise = enqueueRequest("timeout-user");

    // Capture error for assertion
    const captured = promise.catch((err) => err);

    // Advance time past max wait
    await jest.advanceTimersByTimeAsync(QUEUE_CONFIG.maxWaitMs + 500);

    const result = await captured;
    expect(result).toBeInstanceOf(QueueTimeoutError);
  });

  // Test case: queue capacity enforcement
  it("rejects with QueueFullError when queue is at capacity", async () => {
    // Mock rate limit always rejecting to keep requests in queue
    mockCheckRateLimit.mockResolvedValue({
      allowed: false, requestCount: 3, retryAfter: 60, source: "memory",
    });

    const userId = "full-queue-user";
    const pending = [];

    // Fill queue to capacity
    for (let i = 0; i < QUEUE_CONFIG.maxQueueSizePerUser; i++) {
      const p = enqueueRequest(userId);
      pending.push(p.catch((e) => e)); 
    }

    // Next request should be rejected
    const overflowResult = await enqueueRequest(userId).catch((e) => e);
    expect(overflowResult).toBeInstanceOf(QueueFullError);

    // Clean up pending requests
    await jest.advanceTimersByTimeAsync(QUEUE_CONFIG.maxWaitMs + 500);
    await Promise.allSettled(pending);
  });

  // Test case: queue depth tracking
  it("getQueueDepth returns the correct number of waiting requests", async () => {
    // Mock rate limit always rejecting
    mockCheckRateLimit.mockResolvedValue({
      allowed: false, requestCount: 3, retryAfter: 60, source: "memory",
    });

    const userId = "depth-user";

    // Initially empty queue
    expect(getQueueDepth(userId)).toBe(0);

    // Add first request
    const p1 = enqueueRequest(userId).catch((e) => e);
    expect(getQueueDepth(userId)).toBe(1);

    // Add second request
    const p2 = enqueueRequest(userId).catch((e) => e);
    expect(getQueueDepth(userId)).toBe(2);

    // Clean up and verify empty
    await jest.advanceTimersByTimeAsync(QUEUE_CONFIG.maxWaitMs + 500);
    await Promise.allSettled([p1, p2]);

    expect(getQueueDepth(userId)).toBe(0);
  });

  // Test case: FIFO queue processing
  it("processes queued requests in FIFO order", async () => {
    const resolveOrder = [];
    let callCount = 0;

    // Mock rate limit allowing after 2 calls
    mockCheckRateLimit.mockImplementation(async () => {
      callCount++;
      return { allowed: callCount > 2, requestCount: 3, source: "memory" };
    });

    const userId = "fifo-user";
    // Track resolution order
    const p1 = enqueueRequest(userId).then(() => resolveOrder.push("first"));
    const p2 = enqueueRequest(userId).catch((e) => resolveOrder.push("second-error:" + e.name));

    // Allow time for processing
    await jest.advanceTimersByTimeAsync(5_000);
    await Promise.allSettled([p1, p2]);
    
    // Verify FIFO order
    expect(resolveOrder[0]).toBe("first");
  });
});