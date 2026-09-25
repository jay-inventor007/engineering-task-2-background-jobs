import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import type { Job } from './queue.js';

// What a listing_flyer job needs as input. Checked by the API before the job is created.
export const listingFlyerPayload = z.strictObject({
  title: z.string().trim().min(1).max(120),
  priceMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), // kobo
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter currency code like NGN'),
  address: z.string().trim().min(1).max(200),
  bedrooms: z.number().int().min(0).max(50),
});
export type ListingFlyerPayload = z.infer<typeof listingFlyerPayload>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

// The work. Safe to run more than once for the same job: see steps 1 and 4.
export async function generateListingFlyer(job: Job): Promise<void> {
  // 1. Has an earlier run of this job already made the flyer? That happens when a worker made it
  //    but crashed before marking the job succeeded. If so, there is nothing left to do.
  const existing = await pool.query('select 1 from flyers where job_id = $1', [job.id]);
  if (existing.rowCount) return;

  const payload = listingFlyerPayload.parse(job.payload);

  // 2. Behave like slow, unreliable work (see config.simulation).
  const { minWorkMs, maxWorkMs, failureRate } = config.simulation;
  await sleep(randomBetween(minWorkMs, maxWorkMs));
  if (Math.random() < failureRate) {
    throw new Error(`Simulated rendering failure (SIM_FAILURE_RATE=${failureRate})`);
  }

  // 3. Make the PDF.
  const pdf = await renderFlyerPdf(payload);

  // 4. Save it, keyed on the job id. If two runs of the same job both got this far at the same
  //    time, the primary key on job_id lets only the first insert through; the second does nothing.
  await pool.query(
    'insert into flyers (job_id, pdf, size_bytes) values ($1, $2, $3) on conflict (job_id) do nothing',
    [job.id, pdf, pdf.length],
  );
}

export function renderFlyerPdf(listing: ListingFlyerPayload): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A5', margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // PDFKit's built-in fonts have no naira sign, so the currency code is written instead.
  const price = `${listing.currency} ${new Intl.NumberFormat('en-NG').format(listing.priceMinor / 100)}`;
  const rooms = listing.bedrooms === 0 ? 'Land / no bedrooms' : `${listing.bedrooms} bedroom${listing.bedrooms === 1 ? '' : 's'}`;

  doc.fontSize(9).fillColor('#666666').text('PROPERTY FLYER');
  doc.moveDown(0.5);
  doc.fontSize(20).fillColor('#111111').text(listing.title);
  doc.moveDown(0.5);
  doc.fontSize(16).fillColor('#0a6b3b').text(price);
  doc.moveDown(1);
  doc.fontSize(11).fillColor('#111111').text(listing.address);
  doc.text(rooms);
  doc.end();

  return finished;
}
