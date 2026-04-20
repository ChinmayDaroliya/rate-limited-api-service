const mockCheckRateLimit = jest.fn();

jest.mock("../src/services/rateLimitService", () => ({
  checkRateLimit:   mockCheckRateLimit,
  MAX_REQUESTS:     3,
  WINDOW_SECONDS:   60,
}));

const {
  enqueueRequest,
  getQueueDepth,
  QueueFullError,
  QueueTimeoutError,
  QUEUE_CONFIG,
} = require("../src/services/queueService");

describe("queueService — enqueueRequest", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockCheckRateLimit.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });


  it("resolves when rate limit clears on the first retry", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: true, requestCount: 3, source: "memory",
    });

    const promise = enqueueRequest("resolve-user");

    await jest.advanceTimersByTimeAsync(QUEUE_CONFIG.initialRetryMs + 50);

    const result = await promise;
    expect(result.requestCount).toBe(3);
    expect(result.source).toBe("memory");
  });

  it("retries multiple times before succeeding", async () => {
    let callCount = 0;

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

    await jest.advanceTimersByTimeAsync(4_000);

    const result = await promise;
    expect(result.requestCount).toBe(3);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });


  it("rejects with QueueTimeoutError if never resolved within maxWaitMs", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false, requestCount: 3, retryAfter: 60, source: "memory",
    });

    const promise = enqueueRequest("timeout-user");

    const captured = promise.catch((err) => err);

    await jest.advanceTimersByTimeAsync(QUEUE_CONFIG.maxWaitMs + 500);

    const result = await captured;
    expect(result).toBeInstanceOf(QueueTimeoutError);
  });

  it("rejects with QueueFullError when queue is at capacity", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false, requestCount: 3, retryAfter: 60, source: "memory",
    });

    const userId = "full-queue-user";
    const pending = [];

    for (let i = 0; i < QUEUE_CONFIG.maxQueueSizePerUser; i++) {
      const p = enqueueRequest(userId);
      pending.push(p.catch((e) => e)); 
    }

    const overflowResult = await enqueueRequest(userId).catch((e) => e);
    expect(overflowResult).toBeInstanceOf(QueueFullError);

    await jest.advanceTimersByTimeAsync(QUEUE_CONFIG.maxWaitMs + 500);
    await Promise.allSettled(pending);
  });


  it("getQueueDepth returns the correct number of waiting requests", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false, requestCount: 3, retryAfter: 60, source: "memory",
    });

    const userId = "depth-user";

    expect(getQueueDepth(userId)).toBe(0);

    const p1 = enqueueRequest(userId).catch((e) => e);
    expect(getQueueDepth(userId)).toBe(1);

    const p2 = enqueueRequest(userId).catch((e) => e);
    expect(getQueueDepth(userId)).toBe(2);

    await jest.advanceTimersByTimeAsync(QUEUE_CONFIG.maxWaitMs + 500);
    await Promise.allSettled([p1, p2]);

    expect(getQueueDepth(userId)).toBe(0);
  });

  it("processes queued requests in FIFO order", async () => {
    const resolveOrder = [];
    let callCount = 0;

    mockCheckRateLimit.mockImplementation(async () => {
      callCount++;
      return { allowed: callCount > 2, requestCount: 3, source: "memory" };
    });

    const userId = "fifo-user";
    const p1 = enqueueRequest(userId).then(() => resolveOrder.push("first"));
    const p2 = enqueueRequest(userId).catch((e) => resolveOrder.push("second-error:" + e.name));

    await jest.advanceTimersByTimeAsync(5_000);
    await Promise.allSettled([p1, p2]);
    expect(resolveOrder[0]).toBe("first");
  });
});