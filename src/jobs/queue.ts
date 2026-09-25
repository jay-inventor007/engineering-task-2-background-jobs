// Every database operation on jobs lives in this file. Each function is a single SQL statement,
// so each one either happens completely or not at all.

import { pool } from '../db.js';

export type JobStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'dead';
export type JobType = 'listing_flyer';

export type Job = {
  id: string;
  type: JobType;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  lockedBy: string | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
};

const JOB_COLUMNS = `id, type, payload, status, attempts, max_attempts as "maxAttempts",
  last_error as "lastError", run_at as "runAt", started_at as "startedAt",
  finished_at as "finishedAt", locked_by as "lockedBy", idempotency_key as "idempotencyKey",
  created_at as "createdAt", updated_at as "updatedAt"`;

// ─── Enqueue ────────────────────────────────────────────────────────────────────────────────

export type EnqueueResult =
  | { outcome: 'created'; job: Job }
  | { outcome: 'existing'; job: Job }
  | { outcome: 'key_reused'; job: Job };

// Inserts a pending job. If a job with this idempotency key already exists, the unique
// constraint makes the insert do nothing, and the existing job is returned instead.
export async function enqueueJob(type: JobType, payload: unknown, idempotencyKey: string, maxAttempts: number): Promise<EnqueueResult> {
  const inserted = await pool.query<Job>(
    `insert into jobs (type, payload, max_attempts, idempotency_key)
     values ($1, $2, $3, $4)
     on conflict (idempotency_key) do nothing
     returning ${JOB_COLUMNS}`,
    [type, JSON.stringify(payload), maxAttempts, idempotencyKey],
  );
  if (inserted.rows[0]) return { outcome: 'created', job: inserted.rows[0] };

  // The key was used before. Same request → same job. Different request under the same key is
  // a client bug, reported rather than silently returning a job for different input.
  const existing = await pool.query<Job & { sameRequest: boolean }>(
    `select ${JOB_COLUMNS}, (type = $2 and payload = $3::jsonb) as "sameRequest"
       from jobs where idempotency_key = $1`,
    [idempotencyKey, type, JSON.stringify(payload)],
  );
  const { sameRequest, ...job } = existing.rows[0]!;
  return { outcome: sameRequest ? 'existing' : 'key_reused', job };
}

// ─── Claim ──────────────────────────────────────────────────────────────────────────────────

// Takes the next ready job and marks it as this worker's, in ONE statement.
//
// The inner SELECT finds the oldest ready job and locks that row. SKIP LOCKED means that if
// another worker has already locked a row, this worker skips it and takes the next one instead
// of waiting. The outer UPDATE then flips it to processing before the lock is released. There is
// no moment where a job has been "read" but not yet "taken", so two workers can never both win.
//
// It also records the attempt in job_attempts in the same statement.
export async function claimNextJob(workerId: string): Promise<Job | null> {
  const { rows } = await pool.query<Job>(
    `with claimed as (
       update jobs
          set status = 'processing', attempts = attempts + 1, started_at = now(), locked_by = $1
        where id = (
                select id from jobs
                 where status in ('pending', 'failed') and run_at <= now()
                 order by run_at
                 limit 1
                 for update skip locked
              )
          and status in ('pending', 'failed')
        returning *
     ), logged as (
       insert into job_attempts (job_id, attempt, worker_id)
       select id, attempts, $1 from claimed
     )
     select ${JOB_COLUMNS} from claimed`,
    [workerId],
  );
  return rows[0] ?? null;
}

// ─── Finish ─────────────────────────────────────────────────────────────────────────────────
//
// Both functions below only change the job if this worker still owns this attempt
// (same locked_by, same attempts number). If the stuck-job sweep has already taken the job away
// and handed it to another worker, the old worker's late result is ignored.

export async function markSucceeded(job: Job, workerId: string): Promise<boolean> {
  const result = await pool.query(
    `with done as (
       update jobs set status = 'succeeded', finished_at = now(), locked_by = null
        where id = $1 and status = 'processing' and locked_by = $2 and attempts = $3
        returning id, attempts
     )
     update job_attempts a set outcome = 'succeeded', finished_at = now()
       from done where a.job_id = done.id and a.attempt = done.attempts`,
    [job.id, workerId, job.attempts],
  );
  return (result.rowCount ?? 0) > 0;
}

// If attempts are left: status becomes failed and run_at moves into the future by delaySeconds.
// If not: status becomes dead and the job is never picked up again on its own.
export async function markFailed(job: Job, workerId: string, error: string, delaySeconds: number) {
  const { rows } = await pool.query<{ status: JobStatus; runAt: Date }>(
    `with failed as (
       update jobs set
         status      = case when attempts >= max_attempts then 'dead' else 'failed' end,
         last_error  = $4,
         run_at      = case when attempts >= max_attempts then run_at else now() + make_interval(secs => $5) end,
         finished_at = case when attempts >= max_attempts then now() else null end,
         locked_by   = null
        where id = $1 and status = 'processing' and locked_by = $2 and attempts = $3
        returning id, attempts, status, run_at
     ), logged as (
       update job_attempts a set outcome = 'failed', finished_at = now(), error = $4
         from failed where a.job_id = failed.id and a.attempt = failed.attempts
     )
     select status, run_at as "runAt" from failed`,
    [job.id, workerId, job.attempts, error, delaySeconds],
  );
  return rows[0] ?? null;
}

// ─── Stuck jobs ─────────────────────────────────────────────────────────────────────────────

// Any job that has been in processing for longer than timeoutSeconds belongs to a worker that
// died. It goes back to pending straight away (the attempt it used up still counts), or to dead
// if that was its last attempt.
export async function sweepStuckJobs(timeoutSeconds: number) {
  const { rows } = await pool.query<{ id: string; status: JobStatus; attempts: number; previousWorker: string }>(
    `with stuck as (
       select id, locked_by from jobs
        where status = 'processing' and started_at < now() - make_interval(secs => $1)
        for update skip locked
     ), swept as (
       update jobs j set
         status      = case when j.attempts >= j.max_attempts then 'dead' else 'pending' end,
         last_error  = 'Worker ' || stuck.locked_by || ' stopped responding: job was in processing for over '
                       || round($1)::int || 's',
         run_at      = now(),
         finished_at = case when j.attempts >= j.max_attempts then now() else null end,
         locked_by   = null
         from stuck where j.id = stuck.id
        returning j.id, j.status, j.attempts, j.last_error, stuck.locked_by as previous_worker
     ), logged as (
       update job_attempts a set outcome = 'abandoned', finished_at = now(), error = swept.last_error
         from swept where a.job_id = swept.id and a.attempt = swept.attempts and a.outcome is null
     )
     select id, status, attempts, previous_worker as "previousWorker" from swept`,
    [timeoutSeconds],
  );
  return rows;
}

// ─── Dead letter ────────────────────────────────────────────────────────────────────────────

// A person has looked at a dead job and wants it tried again. It gets a fresh set of attempts
// on top of the ones it already used, so attempt numbers in the history keep counting up.
export async function retryDeadJob(id: string, extraAttempts: number): Promise<Job | null> {
  const { rows } = await pool.query<Job>(
    `update jobs set status = 'pending', max_attempts = attempts + $2, run_at = now(), finished_at = null
      where id = $1 and status = 'dead'
      returning ${JOB_COLUMNS}`,
    [id, extraAttempts],
  );
  return rows[0] ?? null;
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────────

export async function getJob(id: string): Promise<Job | null> {
  const { rows } = await pool.query<Job>(`select ${JOB_COLUMNS} from jobs where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listJobs(status: JobStatus | undefined, limit: number): Promise<Job[]> {
  const { rows } = await pool.query<Job>(
    `select ${JOB_COLUMNS} from jobs
      where ($1::text is null or status = $1)
      order by updated_at desc
      limit $2`,
    [status ?? null, limit],
  );
  return rows;
}

export async function getAttempts(jobId: string) {
  const { rows } = await pool.query(
    `select attempt, worker_id as "workerId", started_at as "startedAt", finished_at as "finishedAt", outcome, error
       from job_attempts where job_id = $1 order by attempt`,
    [jobId],
  );
  return rows;
}
