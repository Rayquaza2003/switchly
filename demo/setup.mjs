// Sets up the demo: a Switchly project for the shop, its SDK keys (instances.env), and the server's
// deploy config so the dashboard's Deploy tab can build and start the shop's branches.
// Safe to run again.   node setup.mjs   (Switchly must be running on SWITCHLY_URL)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const api = process.env.SWITCHLY_URL ?? "http://localhost:3000";
const credentials = {
  email: process.env.SWITCHLY_EMAIL ?? "demo@example.com",
  password: process.env.SWITCHLY_PASSWORD ?? "demo-password",
};
const PROJECT = "Corner Coffee shop";
const PORTS = { production: 4001, staging: 4002, development: 4003 };
const keysFile = new URL("./instances.env", import.meta.url);
const deployConfig = new URL("../server/deploy.config.json", import.meta.url);

let cookie = "";
async function call(method, path, body) {
  const res = await fetch(api + path, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body && JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}
async function must(method, path, body) {
  const res = await call(method, path, body);
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${res.data.error ?? ""}`);
  return res.data;
}

if (!(await call("POST", "/api/auth/login", credentials)).ok) await must("POST", "/api/auth/signup", credentials);

const orgs = await must("GET", "/api/orgs");
const org = orgs.find((o) => o.role === "owner") ?? (await must("POST", "/api/orgs", { name: "Corner Coffee Co" }));
let project = (await must("GET", `/api/orgs/${org.id}/projects`)).find((p) => p.name === PROJECT);

if (!project) {
  project = await must("POST", `/api/orgs/${org.id}/projects`, { name: PROJECT });
  for (const [key, description] of [
    ["free-shipping-banner", "Green banner at the top of the shop (on main)"],
    ["new-checkout", "One-page checkout (branch feature/new-checkout)"],
    ["recommendations", "You-may-also-like row (branch feature/recommendations)"],
  ]) {
    await must("POST", `/api/projects/${project.id}/flags`, { key, description });
  }
  // SDK keys are shown only at creation, so keep them for deploying.
  writeFileSync(keysFile, project.environments.map((e) => `SDK_KEY_${e.name}=${e.sdkKey}\n`).join(""));
  console.log(`Created project "${PROJECT}" in "${org.name}" with 3 flags. Keys saved to instances.env.`);
} else if (!existsSync(keysFile)) {
  throw new Error(`Project "${PROJECT}" exists but instances.env is missing. Rotate its keys in the dashboard and write them to instances.env.`);
}

const keys = Object.fromEntries(
  readFileSync(keysFile, "utf8").split("\n").filter(Boolean).map((line) => line.replace("SDK_KEY_", "").split("=")),
);
const existing = existsSync(deployConfig) ? JSON.parse(readFileSync(deployConfig, "utf8")) : {};
existing[project.id] = {
  repo: fileURLToPath(new URL("./shop", import.meta.url)),
  switchlyUrl: api,
  instances: Object.fromEntries(
    Object.entries(PORTS).map(([name, port]) => [name, { port, container: `shop-${name}`, sdkKey: keys[name] }]),
  ),
};
writeFileSync(deployConfig, JSON.stringify(existing, null, 2) + "\n");
console.log(`Deploy tab enabled for "${PROJECT}" (server/deploy.config.json).`);
console.log(`Dashboard login: ${credentials.email}`);
