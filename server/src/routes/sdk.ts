import { EventEmitter } from "node:events";
import express, { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import pg from "pg";
import { z } from "zod";
import { sha256 } from "../auth";
import { evaluateEnvironment } from "../config";
import { HttpError, connectionString, q } from "../db";

export const sdk = Router();

// Called from customer apps on any origin. Auth is the SDK key, never cookies, so open CORS is safe.
sdk.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST",
  });
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

sdk.use(rateLimit({ windowMs: 60_000, limit: 600, message: { error: "Rate limit exceeded" } }));

async function environmentOf(req: Request) {
  const sdkKey = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const [env] = await q("select id, project_id from environments where sdk_key_hash = $1", [sha256(sdkKey)]);
  if (!env) throw new HttpError(401, "Invalid SDK key");
  return env as { id: string; project_id: string };
}

const attributesSchema = z.record(
  z.string().max(100),
  z.union([z.string().max(500), z.number(), z.boolean()]).transform(String),
);

/** User id plus optional attributes, sent as a JSON object in the `attributes` query parameter. */
function userOf(req: Request) {
  const query = z.object({ userId: z.string().min(1).max(200), attributes: z.string().max(4000).optional() }).parse(req.query);
  let raw: unknown = {};
  try {
    if (query.attributes) raw = JSON.parse(query.attributes);
  } catch {
    throw new HttpError(400, "attributes must be a JSON object");
  }
  return { userId: query.userId, attributes: attributesSchema.parse(raw) };
}

// ponytail: evaluates from the database on every request, no cache. That is what makes rollback
// land at once. Add a short per-environment cache when this query shows up in load.
sdk.get("/flags", async (req, res) => {
  const { userId, attributes } = userOf(req);
  res.json({ flags: await evaluateEnvironment(await environmentOf(req), userId, attributes) });
});

// --- Live updates ---

// Project id -> "something changed". Fed by Postgres NOTIFY, so a change made through any
// server process reaches streams held open by every other one.
const changes = new EventEmitter().setMaxListeners(0);
let listener: pg.Client | undefined;

async function listen() {
  if (listener) return;
  const client = (listener = new pg.Client({ connectionString }));
  client.on("notification", (message) => changes.emit(message.payload!));
  // Notifications may have been missed: drop every stream so clients reconnect and re-read.
  client.on("error", () => {
    listener = undefined;
    changes.emit("reset");
  });
  await client.connect();
  await client.query("listen switchly");
}

export const stopListening = () => listener?.end();

// Server-sent events: the full flag map for this user, sent again whenever it changes.
// ponytail: every change re-evaluates once per open stream of that project. Fine for thousands of
// streams; beyond that, evaluate once per distinct user or move streams to a dedicated service.
// A rotated SDK key keeps existing streams alive until they reconnect.
sdk.get("/stream", async (req, res) => {
  const env = await environmentOf(req);
  const { userId, attributes } = userOf(req);
  await listen();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  let last = "";
  const push = async () => {
    const data = JSON.stringify({ flags: await evaluateEnvironment(env, userId, attributes) });
    if (data !== last) res.write(`data: ${(last = data)}\n\n`);
  };
  const onChange = () => void push().catch(() => res.end());
  const onReset = () => res.end();
  // Comment lines keep proxies from closing an idle connection.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  changes.on(env.project_id, onChange).on("reset", onReset);
  req.on("close", () => {
    clearInterval(heartbeat);
    changes.off(env.project_id, onChange).off("reset", onReset);
  });
  await push();
});

// --- Usage reports ---

const count = z.number().int().min(0).max(1_000_000).default(0);
const eventsSchema = z.object({
  events: z
    .record(z.string().max(100), z.object({ on: count, off: count, ok: count, failed: count }))
    .refine((e) => Object.keys(e).length <= 500, "Too many flags in one report"),
});

// SDKs send counts every few seconds: how often the app checked each flag, and how the feature behaved.
// Unknown flag keys are ignored. Anyone holding an SDK key can report, so treat failure counts as a
// signal that can only switch a flag off, never on.
sdk.post("/events", express.json({ limit: "100kb" }), async (req, res) => {
  const env = await environmentOf(req);
  const { events } = eventsSchema.parse(req.body);
  const rows = Object.entries(events).map(([key, c]) => ({ key, on_count: c.on, off_count: c.off, ok: c.ok, failed: c.failed }));
  await q(
    `insert into flag_stats (flag_id, environment_id, minute, on_count, off_count, ok, failed)
     select f.id, $1, date_trunc('minute', now()), x.on_count, x.off_count, x.ok, x.failed
     from jsonb_to_recordset($3::jsonb) as x(key text, on_count int, off_count int, ok int, failed int)
     join flags f on f.project_id = $2 and f.key = x.key
     on conflict (flag_id, environment_id, minute) do update set
       on_count = flag_stats.on_count + excluded.on_count, off_count = flag_stats.off_count + excluded.off_count,
       ok = flag_stats.ok + excluded.ok, failed = flag_stats.failed + excluded.failed`,
    [env.id, env.project_id, JSON.stringify(rows)],
  );
  res.status(202).json({});
});
