// Applies every sql/NNN_*.sql file that has not been applied yet, in order, each inside its own
// transaction. Safe to run repeatedly: applied files are recorded in job_system_migrations.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql');

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists job_system_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )`);

    const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    const { rows } = await client.query<{ filename: string }>('select filename from job_system_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip    ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into job_system_migrations (filename) values ($1)', [file]);
        await client.query('commit');
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
