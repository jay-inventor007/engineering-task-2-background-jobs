import pg from 'pg';
import { config } from './config.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);

export const pool = new pg.Pool({
  connectionString,
  // Supabase requires TLS. Its certificate is not in Node's default CA bundle, so the chain is
  // not verified; the connection is still encrypted.
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: config.db.poolSize,
});
