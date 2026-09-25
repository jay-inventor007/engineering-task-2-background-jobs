// The worker: a separate process from the API. Start as many as you like; they share the jobs
// table safely because claiming a job is a single atomic statement (see claimNextJob).

import os from 'node:os';
import { config } from './config.js';
import { backoffDelayMs } from './jobs/backoff.js';
import { generateListingFlyer } from './jobs/listingFlyer.js';
import { claimNextJob, markFailed, markSucceeded, sweepStuckJobs, type Job, type JobType } from './jobs/queue.js';

const workerId = process.env.WORKER_ID ?? `${os.hostname()}-${process.pid}`;

// Which function does the work for each job type.
const handlers: Record<JobType, (job: Job) => Promise<void>> = {
  listing_flyer: generateListingFlyer,
};

let running = 0; // jobs this process is working on right now
let peak = 0; // the most it has ever worked on at once

function log(message: string) {
  console.log(`${new Date().toISOString()} [${workerId}] ${message}`);
}

async function runJob(job: Job) {
  running += 1;
  peak = Math.max(peak, running);
  const id = job.id.slice(0, 8);
  log(`start   ${id} attempt ${job.attempts}/${job.maxAttempts}  (running ${running}/${config.worker.concurrency}, peak ${peak})`);

  try {
    await handlers[job.type](job);
    const saved = await markSucceeded(job, workerId);
    log(saved ? `success ${id}` : `success ${id}, but the job was taken over by the stuck-job sweep; ignoring`);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const delayMs = backoffDelayMs(job.attempts);
    const result = await markFailed(job, workerId, message, delayMs / 1000);
    if (!result) log(`failed  ${id}, but the job was taken over by the stuck-job sweep; ignoring`);
    else if (result.status === 'dead') log(`DEAD    ${id} after ${job.attempts} attempts: ${message}`);
    else log(`failed  ${id} attempt ${job.attempts}, retry in ${(delayMs / 1000).toFixed(1)}s: ${message}`);
  } finally {
    running -= 1;
  }
}

// Claims jobs until this worker is at its concurrency limit or there is nothing ready.
async function fillFreeSlots() {
  while (running < config.worker.concurrency) {
    const job = await claimNextJob(workerId);
    if (!job) return;
    // Not awaited: the job runs in the background while the loop claims the next one.
    // If saving the result itself fails (database down), the job is left in processing and
    // the stuck-job sweep puts it back later.
    runJob(job).catch((err) => log(`could not record result for ${job.id}: ${err}`));
  }
}

async function sweep() {
  try {
    const swept = await sweepStuckJobs(config.stuck.timeoutMs / 1000);
    for (const job of swept) {
      log(`swept   ${job.id.slice(0, 8)} was stuck (worker ${job.previousWorker}), now ${job.status}`);
    }
  } catch (err) {
    log(`sweep error: ${err}`);
  }
}

async function main() {
  log(
    `worker started: concurrency ${config.worker.concurrency}, max attempts ${config.retry.maxAttempts}, ` +
      `stuck timeout ${config.stuck.timeoutMs / 1000}s, failure rate ${config.simulation.failureRate}`,
  );
  await sweep();
  setInterval(sweep, config.stuck.sweepIntervalMs);

  while (true) {
    try {
      await fillFreeSlots();
    } catch (err) {
      log(`claim error: ${err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.worker.pollIntervalMs));
  }
}

main();
