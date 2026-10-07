import { Router } from "express";
import { z } from "zod";
import { configSchema, notify, setConfig } from "../config";
import { HttpError, q, tx } from "../db";
import { requireRole } from "../tenancy";

const newFlag = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, "Use lowercase letters, digits, dots, dashes and underscores"),
  description: z.string().trim().max(500).default(""),
});

// One row per flag, with `configs` keyed by environment id.
// lastCheckedAt: last time any app reported checking the flag, in any environment.
const flagSelect = `select f.id, f.key, f.description, f.project_id as "projectId", f.created_at as "createdAt",
    (select max(s.minute) from flag_stats s where s.flag_id = f.id) as "lastCheckedAt",
    coalesce(json_object_agg(e.id, json_build_object(
      'enabled', coalesce(c.enabled, false),
      'rolloutPercentage', coalesce(c.rollout_percentage, 0),
      'targetedUsers', coalesce(c.targeted_users, '{}'::text[]),
      'rules', coalesce(c.rules, '[]'::jsonb)
    )) filter (where e.id is not null), '{}') as configs
  from flags f
  left join environments e on e.project_id = f.project_id
  left join flag_configs c on c.flag_id = f.id and c.environment_id = e.id`;

export const flags = Router();

flags.get("/projects/:projectId/flags", requireRole("viewer", "project"), async (req, res) => {
  res.json(await q(`${flagSelect} where f.project_id = $1 group by f.id order by f.key`, [req.params.projectId]));
});

flags.post("/projects/:projectId/flags", requireRole("editor", "project"), async (req, res) => {
  const body = newFlag.parse(req.body);
  const flag = await tx(async (c) => {
    const { rows } = await c.query(
      "insert into flags (project_id, key, description) values ($1, $2, $3) returning id, key, description",
      [req.params.projectId, body.key, body.description],
    );
    await c.query(
      `insert into audit_log (org_id, project_id, flag_id, flag_key, actor_user_id, action)
       values ($1, $2, $3, $4, $5, 'flag.created')`,
      [res.locals.orgId, req.params.projectId, rows[0].id, body.key, res.locals.user.id],
    );
    await notify(c, req.params.projectId as string);
    return rows[0];
  });
  res.status(201).json(flag);
});

flags.get("/flags/:flagId", requireRole("viewer", "flag"), async (req, res) => {
  const [flag] = await q(`${flagSelect} where f.id = $1 group by f.id`, [req.params.flagId]);
  res.json(flag);
});

flags.patch("/flags/:flagId", requireRole("editor", "flag"), async (req, res) => {
  const { description } = newFlag.pick({ description: true }).parse(req.body);
  await q("update flags set description = $1 where id = $2", [description, req.params.flagId]);
  res.json({});
});

flags.delete("/flags/:flagId", requireRole("editor", "flag"), async (req, res) => {
  await tx(async (c) => {
    const { rows } = await c.query("delete from flags where id = $1 returning project_id, key", [req.params.flagId]);
    await c.query(
      `insert into audit_log (org_id, project_id, flag_key, actor_user_id, action) values ($1, $2, $3, $4, 'flag.deleted')`,
      [res.locals.orgId, rows[0].project_id, rows[0].key, res.locals.user.id],
    );
    await notify(c, rows[0].project_id);
  });
  res.json({});
});

flags.put("/flags/:flagId/environments/:environmentId", requireRole("editor", "flag"), async (req, res) => {
  const config = configSchema.parse(req.body);
  res.json(
    await tx((c) =>
      setConfig(c, {
        flagId: req.params.flagId as string,
        environmentId: req.params.environmentId as string,
        config,
        actorId: res.locals.user.id,
        action: "config.updated",
        by: "user",
      }),
    ),
  );
});

flags.get("/projects/:projectId/audit", requireRole("viewer", "project"), async (req, res) => {
  const flagId = z.string().uuid().optional().parse(req.query.flagId);
  res.json(
    await q(
      `select a.id, a.action, a.flag_id as "flagId", a.flag_key as "flagKey", a.environment_id as "environmentId",
         e.name as environment, u.email as actor, a.before, a.after, a.created_at as "createdAt"
       from audit_log a
       left join environments e on e.id = a.environment_id
       left join users u on u.id = a.actor_user_id
       where a.project_id = $1 and ($2::uuid is null or a.flag_id = $2)
       order by a.created_at desc limit 100`,
      [req.params.projectId, flagId ?? null],
    ),
  );
});

// Restores the config as it was just before the given change.
flags.post("/audit/:auditId/revert", requireRole("editor", "audit"), async (req, res) => {
  const [entry] = await q("select flag_id, environment_id, before from audit_log where id = $1", [req.params.auditId]);
  if (!entry.flag_id || !entry.environment_id || !entry.before) {
    throw new HttpError(400, "This entry cannot be reverted");
  }
  res.json(
    await tx((c) =>
      setConfig(c, {
        flagId: entry.flag_id,
        environmentId: entry.environment_id,
        config: configSchema.parse(entry.before),
        actorId: res.locals.user.id,
        action: "config.reverted",
        by: "user",
      }),
    ),
  );
});
