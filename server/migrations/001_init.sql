-- Enum order matters: role comparisons (role >= 'editor') rely on it.
create type role as enum ('viewer', 'editor', 'owner');

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users on delete cascade,
  expires_at timestamptz not null
);

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table memberships (
  org_id uuid not null references orgs on delete cascade,
  user_id uuid not null references users on delete cascade,
  role role not null,
  primary key (org_id, user_id)
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table environments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  name text not null,
  sdk_key_hash text not null unique,
  sdk_key_prefix text not null,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

create table flags (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  key text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  unique (project_id, key)
);

-- A missing row means defaults: disabled, 0 %, nobody targeted.
create table flag_configs (
  flag_id uuid not null references flags on delete cascade,
  environment_id uuid not null references environments on delete cascade,
  enabled boolean not null default false,
  rollout_percentage int not null default 0 check (rollout_percentage between 0 and 100),
  targeted_users text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (flag_id, environment_id)
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  project_id uuid not null references projects on delete cascade,
  flag_id uuid references flags on delete set null,
  flag_key text not null,
  environment_id uuid references environments on delete set null,
  actor_user_id uuid references users on delete set null,
  action text not null,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create index on audit_log (project_id, created_at desc);
