// Every number the job system depends on lives here. Each one can be overridden with an
// environment variable, which is how the break-it tests switch on 100% failure or slow jobs
// without editing code.

function setting(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

export const config = {
  port: setting('PORT', 3000),

  db: {
    // Kept small: Supabase's session pooler allows a limited number of connections in total.
    poolSize: setting('DB_POOL_SIZE', 4),
  },

  worker: {
    // The most jobs one worker process runs at the same time.
    concurrency: setting('WORKER_CONCURRENCY', 5),
    // How long the worker waits before looking for new jobs when it has nothing to do.
    pollIntervalMs: setting('POLL_INTERVAL_MS', 1000),
  },

  retry: {
    // Copied onto each job when it is created.
    maxAttempts: setting('MAX_ATTEMPTS', 5),
    // Wait before retry number n: baseDelayMs × 2^(n-1), plus up to maxJitterMs of randomness.
    baseDelayMs: setting('BACKOFF_BASE_MS', 2000),
    maxJitterMs: setting('BACKOFF_JITTER_MS', 1000),
  },

  stuck: {
    // A job in processing for longer than this is assumed to belong to a dead worker.
    // Must be comfortably longer than the slowest real job, or live jobs get taken away.
    timeoutMs: setting('STUCK_JOB_TIMEOUT_MS', 60_000),
    // How often each worker checks for stuck jobs.
    sweepIntervalMs: setting('SWEEP_INTERVAL_MS', 10_000),
  },

  // Rendering a flyer really takes well under a second, and never fails. These settings make it
  // behave like slow, unreliable work, so the retry, concurrency, and crash tests have
  // something to catch.
  simulation: {
    minWorkMs: setting('SIM_MIN_WORK_MS', 2000),
    maxWorkMs: setting('SIM_MAX_WORK_MS', 4000),
    // Chance (0 to 1) that an attempt fails. 1 means every attempt fails.
    failureRate: setting('SIM_FAILURE_RATE', 0.2),
  },
};
