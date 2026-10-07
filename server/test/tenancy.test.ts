import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { migrate, pool } from "../src/db";

// This file truncates every table. Refuse to run against anything but a test database.
assert.match(process.env.DATABASE_URL ?? "", /_test$/, "DATABASE_URL must point at a *_test database");

let base = "";
let server: ReturnType<typeof app.listen>;

/** A separate signed-in browser: keeps its own session cookie. */
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
let orgId = "", projectId = "", envId = "", sdkKey = "", flagId = "";

const evaluateFor = async (userId: string, key = sdkKey) =>
  anonymous("GET", `/sdk/flags?userId=${userId}`, undefined, { authorization: key });
const setConfig = (who: typeof alice, config: object) => who("PUT", `/api/flags/${flagId}/environments/${envId}`, config);

before(async () => {
  await migrate();
  await pool.query("truncate users, orgs cascade");
  server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  await alice("POST", "/api/auth/signup", { email: "alice@example.com", password: "correct horse" });
  await bob("POST", "/api/auth/signup", { email: "bob@example.com", password: "battery staple" });
  orgId = (await alice("POST", "/api/orgs", { name: "Acme" })).body.id;
  await bob("POST", "/api/orgs", { name: "Bob Co" });
  const project = (await alice("POST", `/api/orgs/${orgId}/projects`, { name: "Checkout" })).body;
  projectId = project.id;
  ({ id: envId, sdkKey } = project.environments.find((e: any) => e.name === "production"));
  flagId = (await alice("POST", `/api/projects/${projectId}/flags`, { key: "new-checkout" })).body.id;
});

after(async () => {
  server.close();
  await pool.end();
});

test("signed-out requests are rejected", async () => {
  assert.equal((await anonymous("GET", "/api/orgs")).status, 401);
});

test("login rejects a wrong password and accepts the right one", async () => {
  const c = client();
  assert.equal((await c("POST", "/api/auth/login", { email: "alice@example.com", password: "wrong password" })).status, 401);
  assert.equal((await c("POST", "/api/auth/login", { email: "alice@example.com", password: "correct horse" })).status, 200);
  assert.equal((await c("GET", "/api/auth/me")).body.email, "alice@example.com");
});

test("another tenant's resources look like they do not exist", async () => {
  const e = { enabled: true, rolloutPercentage: 100, targetedUsers: [] };
  assert.equal((await bob("GET", `/api/orgs/${orgId}/projects`)).status, 404);
  assert.equal((await bob("GET", `/api/orgs/${orgId}/members`)).status, 404);
  assert.equal((await bob("GET", `/api/projects/${projectId}`)).status, 404);
  assert.equal((await bob("GET", `/api/projects/${projectId}/flags`)).status, 404);
  assert.equal((await bob("GET", `/api/projects/${projectId}/audit`)).status, 404);
  assert.equal((await bob("GET", `/api/flags/${flagId}`)).status, 404);
  assert.equal((await setConfig(bob, e)).status, 404);
  assert.equal((await bob("DELETE", `/api/flags/${flagId}`)).status, 404);
  assert.equal((await bob("POST", `/api/environments/${envId}/rotate-key`)).status, 404);
  assert.equal((await bob("GET", "/api/projects/not-a-uuid")).status, 404);
});

test("a flag cannot be configured through another project's environment", async () => {
  const other = (await alice("POST", `/api/orgs/${orgId}/projects`, { name: "Search" })).body;
  const res = await alice("PUT", `/api/flags/${flagId}/environments/${other.environments[0].id}`, {
    enabled: true, rolloutPercentage: 100, targetedUsers: [],
  });
  assert.equal(res.status, 404);
});

test("targeting, rollout, kill switch and revert reach the SDK endpoint", async () => {
  assert.equal((await evaluateFor("u1", "sw_wrong")).status, 401);
  assert.deepEqual((await evaluateFor("u1")).body, { flags: { "new-checkout": false } });

  // Selected users only.
  assert.equal((await setConfig(alice, { enabled: true, rolloutPercentage: 0, targetedUsers: ["u1"] })).status, 200);
  assert.equal((await evaluateFor("u1")).body.flags["new-checkout"], true);
  assert.equal((await evaluateFor("u2")).body.flags["new-checkout"], false);

  // Full rollout.
  await setConfig(alice, { enabled: true, rolloutPercentage: 100, targetedUsers: ["u1"] });
  assert.equal((await evaluateFor("u2")).body.flags["new-checkout"], true);

  // Kill switch: off for everyone, including targeted users, on the very next request.
  await setConfig(alice, { enabled: false, rolloutPercentage: 100, targetedUsers: ["u1"] });
  assert.equal((await evaluateFor("u1")).body.flags["new-checkout"], false);

  // Revert the "full rollout" change: back to targeted-only.
  const audit = (await alice("GET", `/api/projects/${projectId}/audit?flagId=${flagId}`)).body;
  const fullRollout = audit.find((a: any) => a.after?.rolloutPercentage === 100 && a.after.enabled);
  assert.equal((await alice("POST", `/api/audit/${fullRollout.id}/revert`)).status, 200);
  assert.equal((await evaluateFor("u1")).body.flags["new-checkout"], true);
  assert.equal((await evaluateFor("u2")).body.flags["new-checkout"], false);

  // Other environments were never touched.
  const flag = (await alice("GET", `/api/flags/${flagId}`)).body;
  const others = Object.entries(flag.configs).filter(([id]) => id !== envId);
  assert.equal(others.length, 2);
  for (const [, config] of others) assert.equal((config as any).enabled, false);
});

test("invalid config is rejected", async () => {
  assert.equal((await setConfig(alice, { enabled: true, rolloutPercentage: 101, targetedUsers: [] })).status, 400);
  assert.equal((await setConfig(alice, { enabled: "yes", rolloutPercentage: 5, targetedUsers: [] })).status, 400);
});

test("viewer can read but not change; owner-only actions stay owner-only", async () => {
  const add = await alice("POST", `/api/orgs/${orgId}/members`, { email: "bob@example.com", role: "viewer" });
  assert.equal(add.status, 200);
  assert.equal((await bob("GET", `/api/projects/${projectId}/flags`)).status, 200);
  assert.equal((await setConfig(bob, { enabled: true, rolloutPercentage: 100, targetedUsers: [] })).status, 403);
  assert.equal((await bob("POST", `/api/projects/${projectId}/flags`, { key: "x" })).status, 403);

  await alice("POST", `/api/orgs/${orgId}/members`, { email: "bob@example.com", role: "editor" });
  assert.equal((await setConfig(bob, { enabled: true, rolloutPercentage: 10, targetedUsers: [] })).status, 200);
  assert.equal((await bob("POST", `/api/orgs/${orgId}/projects`, { name: "Nope" })).status, 403);
  assert.equal((await bob("POST", `/api/environments/${envId}/rotate-key`)).status, 403);
  assert.equal((await bob("POST", `/api/orgs/${orgId}/members`, { email: "bob@example.com", role: "owner" })).status, 403);
});

test("an organization cannot lose its last owner", async () => {
  const me = (await alice("GET", "/api/auth/me")).body;
  assert.equal((await alice("DELETE", `/api/orgs/${orgId}/members/${me.id}`)).status, 400);
  assert.equal((await alice("POST", `/api/orgs/${orgId}/members`, { email: me.email, role: "viewer" })).status, 400);
  assert.equal((await alice("GET", `/api/orgs/${orgId}/members`)).status, 200);
});

test("rotating an SDK key invalidates the old one", async () => {
  const rotated = (await alice("POST", `/api/environments/${envId}/rotate-key`)).body;
  assert.equal((await evaluateFor("u1")).status, 401);
  assert.equal((await evaluateFor("u1", rotated.sdkKey)).status, 200);
});

test("cross-origin mutations are blocked", async () => {
  const res = await alice("POST", "/api/orgs", { name: "Evil" }, { "sec-fetch-site": "cross-site" });
  assert.equal(res.status, 403);
});
