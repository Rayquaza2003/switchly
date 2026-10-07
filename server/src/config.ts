import type pg from "pg";
import { z } from "zod";
import { HttpError, q } from "./db";
import { OPS, configCols, evaluate, type Attributes, type FlagConfig } from "./evaluate";

type Db = pg.Pool | pg.PoolClient;

const conditionSchema = z
  .object({
    attribute: z.string().trim().max(100).default(""),
    op: z.enum(OPS),
    values: z.array(z.string().trim().min(1).max(200)).min(1).max(1000),
  })
  .refine((c) => c.op.endsWith("segment") || c.attribute, "Each condition needs an attribute name");

export const conditionsSchema = z.array(conditionSchema).min(1).max(20);

// Key order here is the canonical order: setConfig compares configs as JSON.
export const configSchema = z.object({
  enabled: z.boolean(),
  rolloutPercentage: z.number().int().min(0).max(100),
  targetedUsers: z
    .array(z.string().trim().min(1).max(200))
    .max(10_000)
    .transform((users) => [...new Set(users)]),
  rules: z
    .array(z.object({ conditions: conditionsSchema, percentage: z.number().int().min(0).max(100) }))
    .max(50)
    .default([]),
});

/** Tells every server process that flag results in this project may have changed. Sent on commit. */
export const notify = (db: Db, projectId: string) => db.query("select pg_notify('switchly', $1)", [projectId]);

/** Current config plus what guards it. Locks the flag row, so call inside the transaction that will write. */
export async function getConfig(db: Db, flagId: string, environmentId: string) {
  const { rows } = await db.query(
    `select p.org_id, p.id as project_id, f.key, e.name as environment, e.frozen, e.requires_approval, ${configCols}
     from flags f
     join projects p on p.id = f.project_id
     join environments e on e.project_id = p.id and e.id = $2
     left join flag_configs c on c.flag_id = f.id and c.environment_id = e.id
     where f.id = $1 for update of f`,
    [flagId, environmentId],
  );
  if (!rows[0]) throw new HttpError(404, "Not found");
  const { org_id, project_id, key, environment, frozen, requires_approval, ...config } = rows[0];
  return {
    orgId: org_id as string,
    projectId: project_id as string,
    key: key as string,
    environment: environment as string,
    frozen: frozen as boolean,
    requiresApproval: requires_approval as boolean,
    config: configSchema.parse(config) as FlagConfig,
  };
}

/**
 * Who is making the change:
 * - "user": a person, directly. Subject to freeze and approval.
 * - "approved": a change request that has been approved or was scheduled. Subject to freeze only.
 * - "system": the scheduler advancing or rolling back a rollout.
 */
export type By = "user" | "approved" | "system";

/**
 * The only writer of flag_configs. Config change and its audit row commit together,
 * and the flag row lock keeps concurrent edits from recording a stale `before`.
 */
export async function setConfig(
  c: pg.PoolClient,
  args: { flagId: string; environmentId: string; config: FlagConfig; actorId: string | null; action: string; by: By },
) {
  const { flagId, environmentId, actorId, action, by } = args;
  const config = configSchema.parse(args.config) as FlagConfig;
  const ctx = await getConfig(c, flagId, environmentId);

  // Switching off is the rollback path: nothing may stand in its way.
  const onlyOff = JSON.stringify({ ...ctx.config, enabled: false }) === JSON.stringify(config);
  if (!onlyOff && by !== "system") {
    if (ctx.frozen) throw new HttpError(403, `${ctx.environment} is frozen. Only switching a flag off is allowed.`);
    if (ctx.requiresApproval && by === "user") {
      throw new HttpError(403, `${ctx.environment} needs approval. Request the change instead.`);
    }
  }
  // A person's edit takes over from a running rollout, so the two never fight over the percentage.
  if (by !== "system") {
    await c.query(
      `update rollouts set status = 'cancelled', finished_at = now()
       where flag_id = $1 and environment_id = $2 and status = 'running'`,
      [flagId, environmentId],
    );
  }
  await c.query(
    `insert into flag_configs (flag_id, environment_id, enabled, rollout_percentage, targeted_users, rules)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (flag_id, environment_id) do update set enabled = excluded.enabled,
       rollout_percentage = excluded.rollout_percentage, targeted_users = excluded.targeted_users,
       rules = excluded.rules, updated_at = now()`,
    [flagId, environmentId, config.enabled, config.rolloutPercentage, config.targetedUsers, JSON.stringify(config.rules)],
  );
  await c.query(
    `insert into audit_log (org_id, project_id, flag_id, flag_key, environment_id, actor_user_id, action, before, after)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [ctx.orgId, ctx.projectId, flagId, ctx.key, environmentId, actorId, action, ctx.config, config],
  );
  await notify(c, ctx.projectId);
  return config;
}

/** Every flag of the environment, decided for one user. */
export async function evaluateEnvironment(env: { id: string; project_id: string }, userId: string, attributes: Attributes) {
  const [flags, segments] = await Promise.all([
    q(
      `select f.key, ${configCols}
       from flags f left join flag_configs c on c.flag_id = f.id and c.environment_id = $2
       where f.project_id = $1 order by f.key`,
      [env.project_id, env.id],
    ),
    q("select id, conditions from segments where project_id = $1", [env.project_id]),
  ]);
  const segmentMap = Object.fromEntries(segments.map((s) => [s.id, s.conditions]));
  return Object.fromEntries(flags.map((f) => [f.key, evaluate(f.key, f, userId, attributes, segmentMap)]));
}
