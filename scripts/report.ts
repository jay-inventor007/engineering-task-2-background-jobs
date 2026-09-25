// Reads the jobs tables and prints what happened. Used to produce the evidence in the README.
//
//   npm run report                          status counts and the most recent jobs
//   npm run report -- timeline <job id>     every attempt of one job, with the gap between them
//   npm run report -- concurrency <prefix>  peak jobs-at-once per worker, and double-claim checks

import { pool } from '../src/db.js';

const [command, arg] = process.argv.slice(2);

const short = (id: string) => id.slice(0, 8);
const clock = (d: Date | null) => (d ? d.toISOString().slice(11, 23) : '—');

async function overview() {
  const counts = await pool.query(`select status, count(*)::int as jobs from jobs group by status order by status`);
  console.log('Jobs by status:');
  console.table(counts.rows);

  const recent = await pool.query(
    `select id, status, attempts, max_attempts, run_at, locked_by, left(coalesce(last_error, ''), 60) as last_error
       from jobs order by updated_at desc limit 20`,
  );
  console.log('Most recently changed jobs:');
  console.table(
    recent.rows.map((j) => ({
      id: short(j.id),
      status: j.status,
      attempts: `${j.attempts}/${j.max_attempts}`,
      run_at: clock(j.run_at),
      locked_by: j.locked_by ?? '',
      last_error: j.last_error,
    })),
  );
}

async function timeline(jobId: string) {
  const job = await pool.query(`select id, status, attempts, max_attempts, created_at from jobs where id::text like $1 || '%'`, [jobId]);
  if (!job.rows[0]) throw new Error(`no job ${jobId}`);
  const { id, status, attempts, max_attempts, created_at } = job.rows[0];
  console.log(`Job ${id}: ${status}, ${attempts}/${max_attempts} attempts, created ${clock(created_at)}`);

  const { rows } = await pool.query(
    `select attempt, worker_id, started_at, finished_at, outcome, left(coalesce(error, ''), 70) as error
       from job_attempts where job_id = $1 order by attempt`,
    [id],
  );
  console.table(
    rows.map((a, i) => ({
      attempt: a.attempt,
      worker: a.worker_id,
      started: clock(a.started_at),
      finished: clock(a.finished_at),
      // The wait between the end of the previous attempt and the start of this one.
      'wait before (s)': i === 0 ? '' : ((a.started_at - rows[i - 1].finished_at) / 1000).toFixed(1),
      outcome: a.outcome ?? 'running',
      error: a.error,
    })),
  );
}

async function concurrency(prefix: string) {
  // Peak number of attempts running at the same moment, per worker. Every start is +1 and every
  // finish is -1; a running total over time gives how many were in flight at each moment.
  const peaks = await pool.query(
    `with scoped as (
       select a.* from job_attempts a join jobs j on j.id = a.job_id where j.idempotency_key like $1 || '%'
     ), events as (
       select worker_id, started_at as at, 1 as change from scoped
       union all
       select worker_id, finished_at, -1 from scoped where finished_at is not null
     ), totals as (
       select worker_id, sum(change) over (partition by worker_id order by at, change rows unbounded preceding) as in_flight
         from events
     )
     select worker_id, max(in_flight)::int as peak_at_once,
            (select count(*)::int from scoped s where s.worker_id = totals.worker_id) as attempts_run
       from totals group by worker_id order by worker_id`,
    [prefix],
  );
  console.log(`Per worker, for jobs in run ${prefix}:`);
  console.table(peaks.rows);

  const statuses = await pool.query(
    `select status, count(*)::int as jobs from jobs where idempotency_key like $1 || '%' group by status order by status`,
    [prefix],
  );
  console.log('Job statuses for this run:');
  console.table(statuses.rows);

  // Two attempts of the same job whose running times overlap = the same job being worked on by
  // two workers at once. Must be zero.
  const overlaps = await pool.query(
    `select count(*)::int as n from job_attempts a
       join job_attempts b on a.job_id = b.job_id and a.id < b.id
       join jobs j on j.id = a.job_id
      where j.idempotency_key like $1 || '%'
        and a.started_at < coalesce(b.finished_at, now()) and b.started_at < coalesce(a.finished_at, now())`,
    [prefix],
  );
  // A job that succeeded more than once = work done twice. Must be zero.
  const doubleSuccess = await pool.query(
    `select count(*)::int as n from (
       select a.job_id from job_attempts a join jobs j on j.id = a.job_id
        where j.idempotency_key like $1 || '%' and a.outcome = 'succeeded'
        group by a.job_id having count(*) > 1) x`,
    [prefix],
  );
  const flyers = await pool.query(
    `select count(*)::int as n from flyers f join jobs j on j.id = f.job_id where j.idempotency_key like $1 || '%'`,
    [prefix],
  );
  console.log(`Jobs worked on by two workers at the same time: ${overlaps.rows[0].n}`);
  console.log(`Jobs that succeeded more than once:             ${doubleSuccess.rows[0].n}`);
  console.log(`Flyers produced:                                ${flyers.rows[0].n}`);
}

try {
  if (command === 'timeline' && arg) await timeline(arg);
  else if (command === 'concurrency' && arg) await concurrency(arg);
  else await overview();
} finally {
  await pool.end();
}
