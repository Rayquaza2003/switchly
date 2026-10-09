import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createClient } from "../../sdk/src/index";
import { app } from "../src/app";
import { migrate, pool } from "../src/db";
import { tick } from "../src/releases";
import { stopListening } from "../src/routes/sdk";

// This file truncates every table. Refuse to run against anything but a test database.
assert.match(process.env.DATABASE_URL ?? "", /_test$/, "DATABASE_URL must point at a *_test database");

let base = "";
let server: ReturnType<typeof app.listen>;

function client() {
  let cookie = "";
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const alice = client();
const bob = client();
const anonymous = client();
let projectId = "";
let envs: Record<string, { id: string; sdkKey: string }> = {};
let flagId = "";

const off = { enabled: false, rolloutPercentage: 0, targetedUsers: [], rules: [] };
const everyone = { ...off, enabled: true, rolloutPercentage: 100 };
const put = (who: typeof alice, env: string, config: object) => who("PUT", `/api/flags/${flagId}/environments/${envs[env].id}`, config);
const config = async (env: string) => (await alice("GET", `/api/flags/${flagId}`)).body.configs[envs[env].id];
const overview = async (env: string) => (await alice("GET", `/api/flags/${flagId}/environments/${envs[env].id}/overview`)).body;
const sdk = (env: string, userId: string, attributes?: object) =>
  anonymous(
    "GET",
    `/sdk/flags?userId=${userId}${attributes ? `&attributes=${encodeURIComponent(JSON.stringify(attributes))}` : ""}`,
    undefined,
    { authorization: envs[env].sdkKey },
  );
const actions = async () =>
  (await alice("GET", `/api/projects/${projectId}/audit?flagId=${flagId}`)).body.map((a: any) => a.action);

before(async () => {
  await migrate();
  await pool.query("truncate users, orgs cascade");
  server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  await alice("POST", "/api/auth/signup", { email: "alice@example.com", password: "correct horse" });
  await bob("POST", "/api/auth/signup", { email: "bob@example.com", password: "battery staple" });
  const orgId = (await alice("POST", "/api/orgs", { name: "Acme" })).body.id;
  await alice("POST", `/api/orgs/${orgId}/members`, { email: "bob@example.com", role: "editor" });
  const project = (await alice("POST", `/api/orgs/${orgId}/projects`, { name: "Checkout" })).body;
  projectId = project.id;
  envs = Object.fromEntries(project.environments.map((e: any) => [e.name, e]));
  flagId = (await alice("POST", `/api/projects/${projectId}/flags`, { key: "new-checkout" })).body.id;
});

after(async () => {
  await stopListening();
  server.closeAllConnections();
  server.close();
  await pool.end();
});

test("rules target by attribute and by segment", async () => {
  const segment = await alice("POST", `/api/projects/${projectId}/segments`, {
    name: "Staff",
    conditions: [{ attribute: "email", op: "ends_with", values: ["@acme.com"] }],
  });
  assert.equal(segment.status, 201);
  const saved = await put(alice, "development", {
    ...off,
    enabled: true,
    rules: [
      { conditions: [{ op: "in_segment", values: [segment.body.id] }], percentage: 100 },
      { conditions: [{ attribute: "country", op: "is", values: ["IN"] }, { attribute: "appVersion", op: "gte", values: ["2.0.0"] }], percentage: 100 },
    ],
  });
  assert.equal(saved.status, 200);
  const on = async (attributes?: object) => (await sdk("development", "u1", attributes)).body.flags["new-checkout"];
  assert.equal(await on({ email: "kim@acme.com" }), true);
  assert.equal(await on({ country: "IN", appVersion: "2.10.0" }), true);
  assert.equal(await on({ country: "IN", appVersion: "1.9.0" }), false);
  assert.equal(await on({ country: "US", appVersion: "3.0.0" }), false);
  assert.equal(await on(), false);

  // Editing the segment changes who the rule reaches; deleting it leaves the rule matching nobody.
  await alice("PUT", `/api/segments/${segment.body.id}`, { name: "Staff", conditions: [{ attribute: "email", op: "ends_with", values: ["@other.com"] }] });
  assert.equal(await on({ email: "kim@acme.com" }), false);
  assert.equal((await alice("DELETE", `/api/segments/${segment.body.id}`)).status, 200);
  assert.equal(await on({ email: "kim@other.com" }), false);

  assert.equal((await sdk("development", "u1")).status, 200);
  assert.equal((await anonymous("GET", "/sdk/flags?userId=u1&attributes=nope", undefined, { authorization: envs.development.sdkKey })).status, 400);
  // A segment may not refer to a segment, and a rule needs at least one condition.
  assert.equal((await alice("POST", `/api/projects/${projectId}/segments`, { name: "Loop", conditions: [{ op: "in_segment", values: ["x"] }] })).status, 400);
  assert.equal((await put(alice, "development", { ...off, rules: [{ conditions: [], percentage: 50 }] })).status, 400);
});

test("a stepped rollout advances on schedule and a manual edit takes over", async () => {
  await put(alice, "development", off);
  const steps = [{ percentage: 10, waitMinutes: 0 }, { percentage: 50, waitMinutes: 0 }, { percentage: 100, waitMinutes: 0 }];
  const started = await alice("POST", `/api/flags/${flagId}/environments/${envs.development.id}/rollout`, { steps });
  assert.equal(started.status, 201);
  assert.deepEqual([(await config("development")).enabled, (await config("development")).rolloutPercentage], [true, 10]);

  await tick();
  assert.equal((await config("development")).rolloutPercentage, 50);
  await tick();
  assert.equal((await config("development")).rolloutPercentage, 100);
  await tick();
  assert.equal((await overview("development")).rollout.status, "completed");

  // Steps that are not due yet stay put.
  await put(alice, "development", off);
  await alice("POST", `/api/flags/${flagId}/environments/${envs.development.id}/rollout`, {
    steps: [{ percentage: 5, waitMinutes: 60 }, { percentage: 100, waitMinutes: 0 }],
  });
  await tick();
  assert.equal((await config("development")).rolloutPercentage, 5);

  // A person editing the flag ends the rollout, so the scheduler never overrides them.
  await put(alice, "development", { ...off, enabled: true, rolloutPercentage: 20 });
  assert.equal((await overview("development")).rollout.status, "cancelled");
  await pool.query("update rollouts set next_step_at = now() - interval '1 hour'");
  await tick();
  assert.equal((await config("development")).rolloutPercentage, 20);

  const bad = await alice("POST", `/api/flags/${flagId}/environments/${envs.development.id}/rollout`, {
    steps: [{ percentage: 50, waitMinutes: 1 }, { percentage: 20, waitMinutes: 1 }],
  });
  assert.equal(bad.status, 400);
});

test("a rollout switches the flag off when reported failures pass the limit", async () => {
  await put(alice, "development", off);
  await alice("POST", `/api/flags/${flagId}/environments/${envs.development.id}/rollout`, {
    steps: [{ percentage: 10, waitMinutes: 60 }, { percentage: 100, waitMinutes: 60 }],
    maxErrorRate: 20,
    minSamples: 10,
  });
  const report = (events: object) => anonymous("POST", "/sdk/events", { events }, { authorization: envs.development.sdkKey });

  // Too few samples: no decision yet.
  assert.equal((await report({ "new-checkout": { ok: 2, failed: 3 }, "no-such-flag": { failed: 99 } })).status, 202);
  await tick();
  assert.equal((await config("development")).enabled, true);

  // 4 of 15 failed: above 20 %.
  await report({ "new-checkout": { ok: 9, failed: 1, on: 12, off: 30 } });
  await tick();
  assert.equal((await config("development")).enabled, false);
  const view = await overview("development");
  assert.equal(view.rollout.status, "rolled_back");
  assert.deepEqual(view.stats, { on: 12, off: 30, ok: 11, failed: 4 });
  assert.equal((await actions())[0], "rollout.rolled_back");
  assert.equal((await anonymous("POST", "/sdk/events", { events: {} }, { authorization: "sw_wrong" })).status, 401);
});

test("an environment that needs approval takes changes only through a second person", async () => {
  const env = envs.production.id;
  assert.equal((await bob("PATCH", `/api/environments/${env}`, { requiresApproval: true })).status, 403);
  assert.equal((await alice("PATCH", `/api/environments/${env}`, { requiresApproval: true })).body.requiresApproval, true);

  assert.equal((await put(alice, "production", everyone)).status, 403);
  assert.equal((await alice("POST", `/api/flags/${flagId}/environments/${env}/rollout`, { steps: [{ percentage: 5, waitMinutes: 1 }] })).status, 403);

  const request = await alice("POST", `/api/flags/${flagId}/environments/${env}/changes`, { config: everyone, note: "Launch" });
  assert.deepEqual([request.status, request.body.status], [201, "pending_approval"]);
  assert.equal((await config("production")).enabled, false);
  assert.equal((await alice("POST", `/api/changes/${request.body.id}/approve`)).status, 403);
  assert.deepEqual((await bob("POST", `/api/changes/${request.body.id}/approve`)).body, { status: "applied" });
  assert.equal((await config("production")).rolloutPercentage, 100);
  assert.equal((await bob("POST", `/api/changes/${request.body.id}/approve`)).status, 409);

  // Rollback never waits for anyone.
  assert.equal((await put(alice, "production", { ...everyone, enabled: false })).status, 200);
  assert.equal((await config("production")).enabled, false);

  // A rollout can be requested too, and a rejected request changes nothing.
  const rollout = await bob("POST", `/api/flags/${flagId}/environments/${env}/changes`, { rollout: { steps: [{ percentage: 5, waitMinutes: 30 }] } });
  const rejected = await bob("POST", `/api/flags/${flagId}/environments/${env}/changes`, { config: everyone });
  assert.equal((await alice("GET", `/api/projects/${projectId}/changes`)).body.length, 2);
  assert.equal((await alice("POST", `/api/changes/${rejected.body.id}/reject`)).status, 200);
  assert.equal((await alice("POST", `/api/changes/${rollout.body.id}/approve`)).status, 200);
  assert.deepEqual([(await config("production")).enabled, (await config("production")).rolloutPercentage], [true, 5]);
  assert.equal((await overview("production")).rollout.status, "running");
  assert.equal((await alice("GET", `/api/projects/${projectId}/changes`)).body.length, 0);
});

test("a scheduled change applies when its time comes", async () => {
  const env = envs.staging.id;
  assert.equal((await alice("POST", `/api/flags/${flagId}/environments/${env}/changes`, { config: everyone })).status, 400);
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const change = await alice("POST", `/api/flags/${flagId}/environments/${env}/changes`, { config: everyone, scheduledAt: later });
  assert.equal(change.body.status, "scheduled");
  await tick();
  assert.equal((await config("staging")).enabled, false);

  await pool.query("update change_requests set scheduled_at = now() - interval '1 minute' where id = $1", [change.body.id]);
  await tick();
  assert.equal((await config("staging")).enabled, true);
  assert.equal((await actions())[0], "change.applied");
});

test("a frozen environment allows switching off and nothing else", async () => {
  const env = envs.staging.id;
  await alice("PATCH", `/api/environments/${env}`, { frozen: true });
  assert.equal((await put(alice, "staging", { ...everyone, rolloutPercentage: 50 })).status, 403);
  const change = await alice("POST", `/api/flags/${flagId}/environments/${env}/changes`, { config: off, scheduledAt: new Date(0).toISOString() });
  await tick();
  assert.equal((await config("staging")).rolloutPercentage, 100, "scheduled changes wait while frozen");
  assert.equal((await put(alice, "staging", { ...everyone, enabled: false })).status, 200);
  await alice("POST", `/api/changes/${change.body.id}/reject`);
  await alice("PATCH", `/api/environments/${env}`, { frozen: false });
  assert.equal((await put(alice, "staging", everyone)).status, 200);
});

test("the SDK receives changes over the stream and reports usage", async () => {
  await put(alice, "staging", off);
  const flags = createClient({
    sdkKey: envs.staging.sdkKey,
    userId: "u1",
    baseUrl: base,
    attributes: { country: "IN" },
    pollIntervalMs: 60_000, // so only the stream can deliver the change below
  });
  await flags.ready();
  assert.equal(flags.isEnabled("new-checkout"), false);
  assert.equal(flags.isEnabled("unknown-flag", true), true);

  const changed = new Promise<Record<string, boolean>>((resolve) => flags.onChange(resolve));
  // Give the stream a moment to connect, then change the flag for users in India only.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await put(alice, "staging", { ...off, enabled: true, rules: [{ conditions: [{ attribute: "country", op: "is", values: ["IN"] }], percentage: 100 }] });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no update within 3 s")), 3000));
  assert.deepEqual(await Promise.race([changed, timeout]), { "new-checkout": true });
  assert.equal(flags.isEnabled("new-checkout"), true);

  flags.report("new-checkout", true);
  flags.report("new-checkout", false);
  await flags.close();
  assert.deepEqual((await overview("staging")).stats, { on: 1, off: 1, ok: 1, failed: 1 });
  const listed = (await alice("GET", `/api/projects/${projectId}/flags`)).body[0];
  assert.ok(listed.lastCheckedAt, "flag list shows when an app last checked the flag");
});

test("deploying is off for projects the server operator has not configured", async () => {
  assert.deepEqual((await alice("GET", `/api/projects/${projectId}/pipeline`)).body, { enabled: false });
  assert.equal((await alice("POST", `/api/environments/${envs.staging.id}/deploy`, { branch: "main" })).status, 400);
  assert.equal((await alice("POST", `/api/environments/${envs.staging.id}/deploy`, {})).status, 400);
});

test("new routes keep other tenants out", async () => {
  const carol = client();
  await carol("POST", "/api/auth/signup", { email: "carol@example.com", password: "another pass" });
  assert.equal((await carol("GET", `/api/projects/${projectId}/segments`)).status, 404);
  assert.equal((await carol("GET", `/api/projects/${projectId}/changes`)).status, 404);
  assert.equal((await carol("GET", `/api/flags/${flagId}/environments/${envs.staging.id}/overview`)).status, 404);
  assert.equal((await carol("PATCH", `/api/environments/${envs.staging.id}`, { frozen: true })).status, 404);
  assert.equal((await carol("GET", `/api/projects/${projectId}/pipeline`)).status, 404);
  assert.equal((await carol("POST", `/api/environments/${envs.staging.id}/deploy`, { branch: "main" })).status, 404);
  assert.equal((await carol("POST", `/api/flags/${flagId}/environments/${envs.staging.id}/rollout`, { steps: [{ percentage: 5, waitMinutes: 1 }] })).status, 404);
});
