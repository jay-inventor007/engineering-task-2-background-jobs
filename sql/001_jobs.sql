-- Background job system: schema.

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table jobs (
  id              uuid primary key default gen_random_uuid(),
  type            text not null check (type in ('listing_flyer')),
  payload         jsonb not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'processing', 'succeeded', 'failed', 'dead')),
  attempts        integer not null default 0 check (attempts >= 0),
  max_attempts    integer not null check (max_attempts >= 1),
  last_error      text,
  run_at          timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  locked_by       text,
  -- Unique: two requests with the same key cannot create two jobs, even if they arrive at the
  -- same instant. The database refuses the second insert; the API then returns the first job.
  idempotency_key text not null unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  check (attempts <= max_attempts),
  -- A job being worked on must say who is working on it and since when.
  check (status <> 'processing' or (locked_by is not null and started_at is not null)),
  -- A failed or dead job must say why.
  check (status not in ('failed', 'dead') or last_error is not null)
);

-- The worker's claim query looks for jobs that are ready to run. This partial index only
-- contains those rows, so the lookup stays fast however many finished jobs pile up.
create index jobs_ready_to_run on jobs (run_at) where status in ('pending', 'failed');
-- The stuck-job sweep looks for jobs in processing that started too long ago.
create index jobs_processing_since on jobs (started_at) where status = 'processing';
-- The dead letter view lists dead jobs.
create index jobs_dead on jobs (updated_at) where status = 'dead';

create trigger jobs_updated_at before update on jobs for each row execute function set_updated_at();

-- One row per attempt: which worker ran it, when, and how it ended. This is the history the
-- dead letter view shows, and the evidence that no attempt was ever run by two workers.
create table job_attempts (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references jobs(id) on delete cascade,
  attempt     integer not null check (attempt >= 1),
  worker_id   text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  outcome     text check (outcome in ('succeeded', 'failed', 'abandoned')),
  error       text,
  -- Attempt number N of a job can only ever be recorded once.
  unique (job_id, attempt)
);

-- The work's output. job_id is unique, so however many times a job runs, it can only ever
-- produce one flyer. This is what makes running the same job twice safe.
create table flyers (
  job_id     uuid primary key references jobs(id) on delete cascade,
  pdf        bytea not null,
  size_bytes integer not null check (size_bytes > 0),
  created_at timestamptz not null default now()
);
