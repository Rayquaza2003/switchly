import { Router } from "express";
import { z } from "zod";
import { conditionsSchema, configSchema, getConfig, notify } from "../config";
import { HttpError, pool, q, tx } from "../db";
import { applyChange, rolloutCols, rolloutSchema, startRollout } from "../releases";
import { requireRole } from "../tenancy";

const segmentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Segments cannot refer to other segments: keeps evaluation free of cycles.
  conditions: conditionsSchema.refine((cs) => cs.every((c) => !c.op.endsWith("segment")), "A segment cannot refer to another segment"),
});

const changeSchema = z
  .object({
    config: configSchema.optional(),
    rollout: rolloutSchema.optional(),
    scheduledAt: z.coerce.date().optional(),
    note: z.string().trim().max(500).default(""),
  })
  .refine((b) => !!b.config !== !!b.rollout, "Send either config or rollout");

const changeSelect = `select cr.id, cr.flag_id as "flagId", f.key as "flagKey", cr.environment_id as "environmentId",
    e.name as environment, cr.config, cr.rollout, cr.note, cr.scheduled_at as "scheduledAt", cr.status,
    u.email as "requestedBy", cr.requested_by = $2 as mine, cr.created_at as "createdAt"
  from change_requests cr
  join flags f on f.id = cr.flag_id
  join environments e on e.id = cr.environment_id
  left join users u on u.id = cr.requested_by
  where cr.status in ('pending_approval', 'scheduled')`;

export const releases = Router();

// --- Environment guards ---

releases.patch("/environments/:environmentId", requireRole("owner", "environment"), async (req, res) => {
  const body = z.object({ requiresApproval: z.boolean().optional(), frozen: z.boolean().optional() }).parse(req.body);
  const [env] = await q(
    `update environments set requires_approval = coalesce($2, requires_approval), frozen = coalesce($3, frozen)
     where id = $1 returning id, name, requires_approval as "requiresApproval", frozen`,
    [req.params.environmentId, body.requiresApproval ?? null, body.frozen ?? null],
  );
  res.json(env);
});

// --- Segments ---

releases.get("/projects/:projectId/segments", requireRole("viewer", "project"), async (req, res) => {
  res.json(await q("select id, name, conditions from segments where project_id = $1 order by name", [req.params.projectId]));
});

releases.post("/projects/:projectId/segments", requireRole("editor", "project"), async (req, res) => {
  const body = segmentSchema.parse(req.body);
  const [segment] = await q(
    "insert into segments (project_id, name, conditions) values ($1, $2, $3) returning id, name, conditions",
    [req.params.projectId, body.name, JSON.stringify(body.conditions)],
  );
  res.status(201).json(segment);
});

releases.put("/segments/:segmentId", requireRole("editor", "segment"), async (req, res) => {
  const body = segmentSchema.parse(req.body);
  const [segment] = await q(
    "update segments set name = $2, conditions = $3 where id = $1 returning id, name, conditions, project_id",
    [req.params.segmentId, body.name, JSON.stringify(body.conditions)],
  );
  await notify(pool, segment.project_id);
  res.json(segment);
});

// Rules still pointing at a deleted segment match nobody.
releases.delete("/segments/:segmentId", requireRole("editor", "segment"), async (req, res) => {
  const [segment] = await q("delete from segments where id = $1 returning project_id", [req.params.segmentId]);
  await notify(pool, segment.project_id);
  res.json({});
});

// --- Stepped rollouts ---

releases.post("/flags/:flagId/environments/:environmentId/rollout", requireRole("editor", "flag"), async (req, res) => {
  const plan = rolloutSchema.parse(req.body);
  const rollout = await tx((c) =>
    startRollout(c, {
      flagId: req.params.flagId as string,
      environmentId: req.params.environmentId as string,
      plan,
      actorId: res.locals.user.id,
      by: "user",
    }),
  );
  res.status(201).json(rollout);
});

// Stops stepping. The flag keeps the percentage it has reached.
releases.post("/rollouts/:rolloutId/cancel", requireRole("editor", "rollout"), async (req, res) => {
  await q("update rollouts set status = 'cancelled', finished_at = now() where id = $1 and status = 'running'", [
    req.params.rolloutId,
  ]);
  res.json({});
});

// --- Change requests: approval and scheduling ---

releases.get("/projects/:projectId/changes", requireRole("viewer", "project"), async (req, res) => {
  res.json(await q(`${changeSelect} and cr.project_id = $1 order by cr.created_at`, [req.params.projectId, res.locals.user.id]));
});

releases.post("/flags/:flagId/environments/:environmentId/changes", requireRole("editor", "flag"), async (req, res) => {
  const body = changeSchema.parse(req.body);
  const ctx = await getConfig(pool, req.params.flagId as string, req.params.environmentId as string);
  if (!ctx.requiresApproval && !body.scheduledAt) {
    throw new HttpError(400, "Nothing to wait for: this environment needs no approval and no time was set");
  }
  const [change] = await q(
    `insert into change_requests (org_id, project_id, flag_id, environment_id, config, rollout, note, scheduled_at, status, requested_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id, status`,
    [
      ctx.orgId, ctx.projectId, req.params.flagId, req.params.environmentId,
      body.config ?? null, body.rollout ?? null, body.note, body.scheduledAt ?? null,
      ctx.requiresApproval ? "pending_approval" : "scheduled",
      res.locals.user.id,
    ],
  );
  res.status(201).json(change);
});

releases.post("/changes/:changeId/approve", requireRole("editor", "change"), async (req, res) => {
  const status = await tx(async (c) => {
    const { rows } = await c.query(
      "select *, scheduled_at > now() as later from change_requests where id = $1 and status = 'pending_approval' for update",
      [req.params.changeId],
    );
    const change = rows[0];
    if (!change) throw new HttpError(409, "This change is no longer waiting for approval");
    if (change.requested_by === res.locals.user.id) throw new HttpError(403, "Someone else must approve your change");
    await c.query("update change_requests set decided_by = $2 where id = $1", [change.id, res.locals.user.id]);
    if (change.later) {
      await c.query("update change_requests set status = 'scheduled' where id = $1", [change.id]);
      return "scheduled";
    }
    await applyChange(c, change);
    return "applied";
  });
  res.json({ status });
});

// Also how a requester withdraws their own change, and how a scheduled change is called off.
releases.post("/changes/:changeId/reject", requireRole("editor", "change"), async (req, res) => {
  const rows = await q(
    `update change_requests set status = 'rejected', decided_by = $2
     where id = $1 and status in ('pending_approval', 'scheduled') returning id`,
    [req.params.changeId, res.locals.user.id],
  );
  if (!rows.length) throw new HttpError(409, "This change is no longer open");
  res.json({});
});

// --- Everything the flag page shows beside the config itself ---

releases.get("/flags/:flagId/environments/:environmentId/overview", requireRole("viewer", "flag"), async (req, res) => {
  const pair = [req.params.flagId, req.params.environmentId];
  const [[rollout], changes, [stats]] = await Promise.all([
    q(`select ${rolloutCols} from rollouts where flag_id = $1 and environment_id = $2 order by created_at desc limit 1`, pair),
    q(`${changeSelect} and cr.flag_id = $1 and cr.environment_id = $3 order by cr.created_at`, [pair[0], res.locals.user.id, pair[1]]),
    q(
      `select coalesce(sum(on_count), 0)::int as "on", coalesce(sum(off_count), 0)::int as "off",
         coalesce(sum(ok), 0)::int as ok, coalesce(sum(failed), 0)::int as failed
       from flag_stats where flag_id = $1 and environment_id = $2 and minute > now() - interval '24 hours'`,
      pair,
    ),
  ]);
  res.json({ rollout: rollout ?? null, changes, stats });
});
