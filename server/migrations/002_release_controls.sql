-- Targeting rules: ordered list of { conditions: [{ attribute, op, values }], percentage }.
alter table flag_configs add column rules jsonb not null default '[]';

alter table environments
  add column requires_approval boolean not null default false,
  add column frozen boolean not null default false;

-- Reusable audience, for example "beta testers". Rules refer to segments by id.
create table segments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  name text not null,
  conditions jsonb not null,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

-- Stepped rollout: holds each percentage for its wait time, then moves to the next.
create table rollouts (
  id uuid primary key default gen_random_uuid(),
  flag_id uuid not null references flags on delete cascade,
  environment_id uuid not null references environments on delete cascade,
  steps jsonb not null,
  current_step int not null default 0,
  next_step_at timestamptz not null,
  -- Auto-rollback guard: switch the flag off when reported failures pass this share (percent).
  max_error_rate numeric check (max_error_rate between 0 and 100),
  min_samples int not null default 20,
  status text not null default 'running' check (status in ('running', 'completed', 'cancelled', 'rolled_back')),
  started_by uuid references users on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create unique index on rollouts (flag_id, environment_id) where status = 'running';

-- A change that waits: for a second person's approval, for a scheduled time, or both.
create table change_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  project_id uuid not null references projects on delete cascade,
  flag_id uuid not null references flags on delete cascade,
  environment_id uuid not null references environments on delete cascade,
  config jsonb,
  rollout jsonb,
  check (num_nonnulls(config, rollout) = 1),
  note text not null default '',
  scheduled_at timestamptz,
  status text not null check (status in ('pending_approval', 'scheduled', 'applied', 'rejected', 'failed')),
  error text,
  requested_by uuid references users on delete set null,
  decided_by uuid references users on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create index on change_requests (project_id, status);

-- Usage reported by SDKs, per minute: how often apps checked the flag and how the feature behaved.
create table flag_stats (
  flag_id uuid not null references flags on delete cascade,
  environment_id uuid not null references environments on delete cascade,
  minute timestamptz not null,
  on_count int not null default 0,
  off_count int not null default 0,
  ok int not null default 0,
  failed int not null default 0,
  primary key (flag_id, environment_id, minute)
);

create index on flag_stats (minute);
