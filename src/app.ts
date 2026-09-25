import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import { listingFlyerPayload } from './jobs/listingFlyer.js';
import { enqueueJob, getAttempts, getJob, listJobs, retryDeadJob, type Job } from './jobs/queue.js';

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

const createJobBody = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('listing_flyer'), payload: listingFlyerPayload }),
]);
const idempotencyKey = z.string().trim().min(1).max(200);
const listQuery = z.strictObject({
  status: z.enum(['pending', 'processing', 'succeeded', 'failed', 'dead']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// What the API shows for a job. locked_by and the idempotency key are internal.
function present(job: Job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    payload: job.payload,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
    // Only meaningful while waiting: when the next attempt is due.
    nextAttemptAt: job.status === 'pending' || job.status === 'failed' ? job.runAt : null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
    resultUrl: job.status === 'succeeded' ? `/api/jobs/${job.id}/flyer` : null,
  };
}

function parseId(raw: string | undefined): string {
  const result = z.uuid().safeParse(raw);
  if (!result.success) throw new ApiError(404, 'NOT_FOUND', 'Job not found');
  return result.data;
}

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

// Enqueue. Writes one row and returns immediately; it never does the work itself.
app.post('/api/jobs', async (req, res) => {
  const key = idempotencyKey.safeParse(req.get('Idempotency-Key'));
  if (!key.success) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (any unique string, e.g. a UUID)');
  }
  const body = createJobBody.safeParse(req.body ?? {});
  if (!body.success) {
    const details = body.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
    throw new ApiError(422, 'VALIDATION_FAILED', 'The request body failed validation', details);
  }

  const result = await enqueueJob(body.data.type, body.data.payload, key.data, config.retry.maxAttempts);
  if (result.outcome === 'key_reused') {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
  }
  // 202 Accepted: "I have taken this on, it is not done yet". A repeat of the same request gets
  // 200 and the job that already exists.
  res
    .status(result.outcome === 'created' ? 202 : 200)
    .location(`/api/jobs/${result.job.id}`)
    .json({ data: present(result.job) });
});

// Dead letter view and general listing: GET /api/jobs?status=dead
app.get('/api/jobs', async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'INVALID_QUERY', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const jobs = await listJobs(parsed.data.status, parsed.data.limit);
  res.json({ data: jobs.map(present) });
});

// Status endpoint. The client that enqueued the job polls this.
app.get('/api/jobs/:id', async (req, res) => {
  const job = await getJob(parseId(req.params.id));
  if (!job) throw new ApiError(404, 'NOT_FOUND', 'Job not found');
  res.json({ data: present(job) });
});

// Every attempt of one job: which worker, when, and how it ended.
app.get('/api/jobs/:id/attempts', async (req, res) => {
  const id = parseId(req.params.id);
  if (!(await getJob(id))) throw new ApiError(404, 'NOT_FOUND', 'Job not found');
  res.json({ data: await getAttempts(id) });
});

// Manual retry from the dead letter view. Only dead jobs can be retried this way.
app.post('/api/jobs/:id/retry', async (req, res) => {
  const id = parseId(req.params.id);
  const job = await retryDeadJob(id, config.retry.maxAttempts);
  if (job) return res.json({ data: present(job) });
  const existing = await getJob(id);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Job not found');
  throw new ApiError(409, 'NOT_DEAD', `Only dead jobs can be retried; this one is ${existing.status}`);
});

// The finished flyer.
app.get('/api/jobs/:id/flyer', async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await pool.query<{ pdf: Buffer }>('select pdf from flyers where job_id = $1', [id]);
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'No flyer for this job (yet)');
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="flyer-${id}.pdf"`);
  res.send(rows[0].pdf);
});

app.use((req, _res, next) => next(new ApiError(404, 'NOT_FOUND', `No endpoint for ${req.method} ${req.path}`)));

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let error = err instanceof ApiError ? err : null;
  if (!error && err?.type === 'entity.parse.failed') error = new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (!error) {
    console.error(err);
    error = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong on our side');
  }
  res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
};
app.use(errorHandler);
