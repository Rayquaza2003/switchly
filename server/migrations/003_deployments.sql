-- One row per deploy of a branch (at a commit) to an environment's instance.
create table deployments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  environment_id uuid not null references environments on delete cascade,
  branch text not null,
  commit_sha text not null,
  commit_subject text not null default '',
  status text not null default 'progressing' check (status in ('progressing', 'succeeded', 'failed')),
  log text not null default '',
  triggered_by uuid references users on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index on deployments (environment_id, created_at desc);
-- At most one deploy in flight per environment.
create unique index on deployments (environment_id) where status = 'progressing';
