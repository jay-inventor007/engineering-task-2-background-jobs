// Proves the work is idempotent: running the same job's work twice produces one flyer, not two.
//
// Two cases:
//   1. One after the other: a worker made the flyer, crashed before marking the job succeeded,
//      and the job ran again later.
//   2. At the same moment: the stuck-job sweep handed a slow job to a second worker while the
//      first was still running it.

// Settings must be in place before config.ts is loaded, so the imports below are dynamic.
process.env.SIM_FAILURE_RATE = '0';
process.env.SIM_MIN_WORK_MS = '500';
process.env.SIM_MAX_WORK_MS = '1000';

const { pool } = await import('../src/db.js');
const { generateListingFlyer } = await import('../src/jobs/listingFlyer.js');
const { getJob } = await import('../src/jobs/queue.js');

const payload = { title: 'Idempotency test listing', priceMinor: 150_000_000, currency: 'NGN', address: '1 Test Close, Ikeja, Lagos', bedrooms: 2 };

async function newJob(label: string) {
  // Inserted as already succeeded so no running worker picks it up; only this script runs it.
  const { rows } = await pool.query<{ id: string }>(
    `insert into jobs (type, payload, status, max_attempts, idempotency_key, finished_at)
     values ('listing_flyer', $1, 'succeeded', 5, $2, now()) returning id`,
    [JSON.stringify(payload), `idempotency-test-${label}-${Date.now()}`],
  );
  return (await getJob(rows[0]!.id))!;
}

const flyerCount = async (jobId: string) =>
  (await pool.query<{ n: number }>('select count(*)::int as n from flyers where job_id = $1', [jobId])).rows[0]!.n;

try {
  const sequential = await newJob('sequential');
  await generateListingFlyer(sequential);
  console.log(`Case 1, one after the other. Job ${sequential.id}`);
  console.log(`  after run 1: ${await flyerCount(sequential.id)} flyer(s)`);
  await generateListingFlyer(sequential);
  console.log(`  after run 2: ${await flyerCount(sequential.id)} flyer(s)`);

  const parallel = await newJob('parallel');
  await Promise.all([generateListingFlyer(parallel), generateListingFlyer(parallel)]);
  console.log(`Case 2, two runs at the same moment. Job ${parallel.id}`);
  console.log(`  after both runs: ${await flyerCount(parallel.id)} flyer(s)`);
} finally {
  await pool.end();
}
