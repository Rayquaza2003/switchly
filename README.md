# Switchly

Feature flag dashboard. Release a feature to selected users without a deploy, widen it by percentage, switch it off in one click.

## Run

Needs Node 22+ and Postgres 13+.

```sh
createdb switchly && createdb switchly_test
npm install
npm run dev        # API on :3000 (applies migrations at start), dashboard on :5173
npm test           # runs against switchly_test, which it truncates
```

Environment variables (server): `DATABASE_URL` (default `postgres://localhost/switchly`), `PORT` (default `3000`), `NODE_ENV=production` (marks the session cookie `Secure`), `TRUST_PROXY=1` (when behind a reverse proxy).

## Use a flag in an app

Create a project in the dashboard, copy the SDK key for an environment, then:

```ts
import { createClient } from "@switchly/sdk";

const flags = createClient({ sdkKey: "sw_…", userId: currentUser.id, baseUrl: "http://localhost:3000" });
await flags.ready();

if (flags.isEnabled("new-checkout")) {
  // new code path
}
```

Or without the SDK:

```sh
curl -H "Authorization: sw_…" "http://localhost:3000/sdk/flags?userId=user-123"
# {"flags":{"new-checkout":true}}
```

## How a flag is decided

Per environment, in this order:

1. Flag switched off: off for everyone.
2. User id is in the selected users list: on.
3. Otherwise on for a stable `rolloutPercentage` share of users. A user keeps the same slot per flag, so raising the percentage only adds users.

A change reaches SDK clients on their next poll (10 seconds by default). Every change is recorded in the flag's history, and any entry can be undone from there.

## Roles

- Viewer: read everything.
- Editor: create, change and delete flags.
- Owner: also manage members, projects, environments and SDK keys.

## Layout

- `server/`: Express API. `src/evaluate.ts` holds the decision rule, `src/tenancy.ts` the access check every dashboard route passes through.
- `web/`: React dashboard (Vite).
- `sdk/`: polling client, no dependencies.

Copy these SDK keys now. They are not shown again.
development
sw_adAE3a9dMOODZFKZxYuD_mBXiSmUu8Mc
staging
sw_IIMbLXUzLIZMsA0FNJJtanmwxYxlSBxC
production
sw_fXBn9hk9Av2J5IpEFXqD5dKZ2H1usx-x