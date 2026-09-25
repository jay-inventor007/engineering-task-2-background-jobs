import { config } from '../config.js';

// How long to wait before the next attempt, after `attempts` attempts have failed.
//
// Exponential: each wait is double the last (2s, 4s, 8s, 16s with the default base of 2s), so a
// struggling dependency gets more and more room to recover.
//
// Jitter: a random extra of up to maxJitterMs. Without it, 100 jobs that failed at the same moment
// would all retry at exactly the same moment and hit the struggling dependency together again.
export function backoffDelayMs(attempts: number): number {
  const exponential = config.retry.baseDelayMs * 2 ** (attempts - 1);
  const jitter = Math.random() * config.retry.maxJitterMs;
  return Math.round(exponential + jitter);
}
