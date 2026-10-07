import { Router } from "express";
import { z } from "zod";
import { HttpError, q, tx } from "../db";
import { configCols, type FlagConfig } from "../evaluate";
import { requireRole } from "../tenancy";

const newFlag = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, "Use lowercase letters, digits, dots, dashes and underscores"),
  description: z.string().trim().max(500).default(""),
});

const configSchema = z.object({
  enabled: z.boolean(),
  rolloutPercentage: z.number().int().min(0).max(100),
  targetedUsers: z
    .array(z.string().trim().min(1).max(200))
    .max(10_000)
    .transform((users) => [...new Set(users)]),
});

// One row per flag, with `configs` keyed by environment id.
const flagSelect = `select f.id, f.key, f.description, f.project_id as "projectId",
    coalesce(json_object_agg(e.id, json_build_object(
      'enabled', coalesce(c.enabled, false),
      'rolloutPercentage', coalesce(c.rollout_percentage, 0),
      'targetedUsers', coalesce(c.targeted_users, '{}'::text[])
    )) filter (where e.id is not null), '{}') as configs
  from flags f
  left join environments e on e.project_id = f.project_id
  left join flag_configs c on c.flag_id = f.id and c.environment_id = e.id`;

/**
 * The only writer of flag_configs. Config change and its audit row commit together,
 * and the flag row lock keeps concurrent edits from recording a stale `before`.
 */
async function setConfig(flagId: string, environmentId: string, config: FlagConfig, actorId: string, action: string) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `select p.org_id, p.id as project_id, f.key, ${configCols}
       from flags f
       join projects p on p.id = f.project_id
       join environments e on e.project_id = p.id and e.id = $2
       left join flag_configs c on c.flag_id = f.id and c.environment_id = e.id
       where f.id = $1 for update of f`,
      [flagId, environmentId],
    );
    if (!rows[0]) throw new HttpError(404, "Not found");
    const { org_id, project_id, key, ...before } = rows[0];
    await c.query(
      `insert into flag_configs (flag_id, environment_id, enabled, rollout_percentage, targeted_users)
       values ($1, $2, $3, $4, $5)
       on conflict (flag_id, environment_id) do update set enabled = excluded.enabled,
         rollout_percentage = excluded.rollout_percentage, targeted_users = excluded.targeted_users, updated_at = now()`,
      [flagId, environmentId, config.enabled, config.rolloutPercentage, config.targetedUsers],
    );
    await c.query(
      `insert into audit_log (org_id, project_id, flag_id, flag_key, environment_id, actor_user_id, action, before, after)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [org_id, project_id, flagId, key, environmentId, actorId, action, before, config],
    );
    return config;
  });
}

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
  });
  res.json({});
});

flags.put("/flags/:flagId/environments/:environmentId", requireRole("editor", "flag"), async (req, res) => {
  const config = configSchema.parse(req.body);
  res.json(await setConfig(req.params.flagId as string, req.params.environmentId as string, config, res.locals.user.id, "config.updated"));
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
  const config = configSchema.parse(entry.before);
  res.json(await setConfig(entry.flag_id, entry.environment_id, config, res.locals.user.id, "config.reverted"));
});
