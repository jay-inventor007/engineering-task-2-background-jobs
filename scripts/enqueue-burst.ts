// Sends N enqueue requests at the same time. Every job gets an idempotency key starting with the
// same run prefix, so `npm run report -- concurrency <prefix>` can look at just these jobs.
//
//   npm run burst -- 50

const count = Number(process.argv[2] ?? 50);
const apiUrl = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const prefix = `burst-${Date.now()}`;

const payload = (i: number) => ({
  title: `Burst test listing #${i + 1}`,
  priceMinor: (1_000_000 + i * 50_000) * 100,
  currency: 'NGN',
  address: `${i + 1} Test Street, Lekki, Lagos`,
  bedrooms: (i % 5) + 1,
});

const started = Date.now();
const statuses = await Promise.all(
  Array.from({ length: count }, (_, i) =>
    fetch(`${apiUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${prefix}-${i}` },
      body: JSON.stringify({ type: 'listing_flyer', payload: payload(i) }),
    }).then((r) => r.status),
  ),
);

const tally: Record<number, number> = {};
for (const s of statuses) tally[s] = (tally[s] ?? 0) + 1;
console.log(`enqueued ${count} jobs in ${Date.now() - started}ms, responses:`, tally);
console.log(`run prefix: ${prefix}`);
