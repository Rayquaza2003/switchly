// Creates the Switchly project for the demo shop and saves its SDK keys to instances.env.
// Run once: node setup.mjs   (Switchly must be running on SWITCHLY_URL)
import { existsSync, writeFileSync } from "node:fs";

const api = process.env.SWITCHLY_URL ?? "http://localhost:3000";
const credentials = {
  email: process.env.SWITCHLY_EMAIL ?? "demo@example.com",
  password: process.env.SWITCHLY_PASSWORD ?? "demo-password",
};
const keysFile = new URL("./instances.env", import.meta.url);

if (existsSync(keysFile)) {
  console.log("instances.env already exists: project is set up. Delete the file to create a fresh project.");
  process.exit(0);
}

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
const project = await must("POST", `/api/orgs/${org.id}/projects`, { name: "Corner Coffee shop" });

for (const [key, description] of [
  ["free-shipping-banner", "Green banner at the top of the shop (on main)"],
  ["new-checkout", "One-page checkout (branch feature/new-checkout)"],
  ["recommendations", "You-may-also-like row (branch feature/recommendations)"],
]) {
  await must("POST", `/api/projects/${project.id}/flags`, { key, description });
}

// SDK keys are shown only at creation, so keep them here for deploy.sh.
writeFileSync(keysFile, project.environments.map((e) => `SDK_KEY_${e.name}=${e.sdkKey}\n`).join(""));
console.log(`Created project "${project.name}" in "${org.name}" with 3 flags. Keys saved to instances.env.`);
console.log(`Dashboard login: ${credentials.email}`);
