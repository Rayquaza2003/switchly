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

const flags = createClient({
  sdkKey: "sw_…",
  userId: currentUser.id,
  baseUrl: "http://localhost:3000",
  attributes: { country: "IN", plan: "pro", appVersion: "2.4.0" }, // optional, for targeting rules
});
await flags.ready();

if (flags.isEnabled("new-checkout")) {
  try {
    runNewCheckout();
    flags.report("new-checkout", true);
  } catch (err) {
    flags.report("new-checkout", false); // feeds the automatic switch-off
    throw err;
  }
}
```

The SDK keeps a stream open, so changes arrive within a second; it falls back to polling every 10 seconds when the stream drops. It also reports how often each flag is checked, which the dashboard shows and uses to spot flags no app asks about any more.

Or without the SDK:

```sh
curl -H "Authorization: sw_…" "http://localhost:3000/sdk/flags?userId=user-123"
# {"flags":{"new-checkout":true}}

# with attributes (URL-encoded JSON), and as a live stream:
curl -G -H "Authorization: sw_…" "http://localhost:3000/sdk/flags" \
  --data-urlencode "userId=user-123" --data-urlencode 'attributes={"country":"IN"}'
curl -N -H "Authorization: sw_…" "http://localhost:3000/sdk/stream?userId=user-123"
```

## How a flag is decided

Per environment, in this order:

1. Flag switched off: off for everyone.
2. User id is in the selected users list: on.
3. First targeting rule whose conditions all match the user's attributes: on for that rule's share of matching users. Conditions compare an attribute (`is`, `is not`, `contains`, `starts with`, `ends with`, `is at least`, `is at most`) or test membership of a segment. `userId` is always available as an attribute.
4. Otherwise on for a stable `rolloutPercentage` share of users. A user keeps the same slot per flag, so raising the percentage only adds users.

Every change is recorded in the flag's history, and any entry can be undone from there.

## Release controls

- **Segments**: named groups of users (for example "Beta testers: email ends with @acme.com") that any flag's rules can use.
- **Stepped rollout**: a plan such as 5, 25, 50, 100 with a hold time per step. Switchly widens the flag on schedule. Any manual change stops the rollout.
- **Automatic switch-off**: give a rollout a failure limit. When the share of `report(key, false)` calls passes it, the flag switches off by itself.
- **Approval**: an owner can mark an environment "Needs approval". Changes there become requests that a second editor or owner approves.
- **Scheduling**: any change can be set to apply at a later time.
- **Freeze**: an owner can freeze an environment. Rollouts and scheduled changes pause until it is unfrozen.

Switching a flag off is never blocked: not by approval, not by a freeze.

The server checks rollouts and scheduled changes every 5 seconds, so those act within 5 seconds of their time.

## Deploying branches to instances

A project can get a **Deploy** tab: pick a branch per environment, deploy it as a Docker container, watch status and log, roll back to the previous good commit. Editors and owners can deploy; a frozen environment refuses deploys.

Deploying runs `git` and `docker` on the machine the Switchly server runs on, so it is switched on per project by whoever runs the server, in `server/deploy.config.json` (path overridable with `DEPLOY_CONFIG`), never from the dashboard:

```json
{
  "<project id>": {
    "repo": "/absolute/path/to/git/repository",
    "switchlyUrl": "http://localhost:3000",
    "instances": {
      "staging": { "port": 4002, "container": "shop-staging", "sdkKey": "sw_…" }
    }
  }
}
```

The repository needs a `Dockerfile` at its root whose container listens on port 8080 (`containerPort` to change). Each container is started with `SWITCHLY_SDK_KEY`, `SWITCHLY_URL`, `ENVIRONMENT`, `BRANCH` and `PORT` set. Only committed code is deployed. `demo/` holds a working example; see `demo/README.md`.

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