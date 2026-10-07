import type pg from "pg";
import { z } from "zod";
import { configSchema, getConfig, setConfig, type By } from "./config";
import { q, tx } from "./db";

export const rolloutSchema = z.object({
  steps: z
    .array(
      z.object({
        percentage: z.number().int().min(1).max(100),
        // How long to hold this percentage before the next step. Up to 30 days.
        waitMinutes: z.number().min(0).max(43_200),
      }),
    )
    .min(1)
    .max(20)
    .refine((steps) => steps.every((s, i) => i === 0 || s.percentage > steps[i - 1].percentage), "Each step must be larger than the one before"),
  maxErrorRate: z.number().min(0).max(100).nullable().default(null),
  minSamples: z.number().int().min(1).max(1_000_000).default(20),
});
export type RolloutPlan = z.infer<typeof rolloutSchema>;

export const rolloutCols = `id, steps, current_step as "currentStep", next_step_at as "nextStepAt",
  max_error_rate::float8 as "maxErrorRate", min_samples as "minSamples", status,
  created_at as "createdAt", finished_at as "finishedAt"`;

/** Switches the flag on at the first step and schedules the rest. Replaces any rollout already running. */
export async function startRollout(
  c: pg.PoolClient,
  args: { flagId: string; environmentId: string; plan: RolloutPlan; actorId: string | null; by: By },
) {
  const { flagId, environmentId, plan, actorId, by } = args;
  const { config } = await getConfig(c, flagId, environmentId);
  const [first] = plan.steps;
  await setConfig(c, {
    flagId, environmentId, actorId, by,
    config: { ...config, enabled: true, rolloutPercentage: first.percentage },
    action: "rollout.started",
  });
  const { rows } = await c.query(
    `insert into rollouts (flag_id, environment_id, steps, next_step_at, max_error_rate, min_samples, started_by)
     values ($1, $2, $3, now() + $4 * interval '1 minute', $5, $6, $7) returning ${rolloutCols}`,
    [flagId, environmentId, JSON.stringify(plan.steps), first.waitMinutes, plan.maxErrorRate, plan.minSamples, actorId],
  );
  return rows[0];
}

/** Carries out an approved or due change request. */
export async function applyChange(c: pg.PoolClient, change: any) {
  const base = { flagId: change.flag_id, environmentId: change.environment_id, actorId: change.requested_by, by: "approved" as const };
  if (change.rollout) await startRollout(c, { ...base, plan: rolloutSchema.parse(change.rollout) });
  else await setConfig(c, { ...base, config: configSchema.parse(change.config), action: "change.applied" });
  await c.query("update change_requests set status = 'applied', applied_at = now() where id = $1", [change.id]);
}

async function stepRollout(c: pg.PoolClient, id: string) {
  // Same lock order as a person's edit (flag, then rollout), so the two cannot deadlock.
  await c.query("select 1 from flags where id = (select flag_id from rollouts where id = $1) for update", [id]);
  const { rows } = await c.query(
    `select r.*, e.frozen, r.next_step_at <= now() as due
     from rollouts r join environments e on e.id = r.environment_id
     where r.id = $1 and r.status = 'running' for update of r skip locked`,
    [id],
  );
  const rollout = rows[0];
  if (!rollout) return;
  const base = { flagId: rollout.flag_id, environmentId: rollout.environment_id, actorId: null, by: "system" as const };
  const finish = (status: string) =>
    c.query("update rollouts set status = $2, finished_at = now() where id = $1", [id, status]);

  // Guard first: a failing feature must never be widened.
  if (rollout.max_error_rate !== null) {
    const { rows: [stats] } = await c.query(
      `select coalesce(sum(ok), 0)::int as ok, coalesce(sum(failed), 0)::int as failed from flag_stats
       where flag_id = $1 and environment_id = $2 and minute >= date_trunc('minute', $3::timestamptz)`,
      [rollout.flag_id, rollout.environment_id, rollout.created_at],
    );
    const total = stats.ok + stats.failed;
    if (total >= rollout.min_samples && (stats.failed / total) * 100 > Number(rollout.max_error_rate)) {
      const { config } = await getConfig(c, rollout.flag_id, rollout.environment_id);
      await setConfig(c, { ...base, config: { ...config, enabled: false }, action: "rollout.rolled_back" });
      await finish("rolled_back");
      return;
    }
  }

  // A frozen environment pauses the rollout; it resumes when unfrozen.
  if (!rollout.due || rollout.frozen) return;
  const next = rollout.steps[rollout.current_step + 1];
  if (!next) return void (await finish("completed"));
  const { config } = await getConfig(c, rollout.flag_id, rollout.environment_id);
  await setConfig(c, { ...base, config: { ...config, rolloutPercentage: next.percentage }, action: "rollout.advanced" });
  await c.query(
    `update rollouts set current_step = current_step + 1, next_step_at = now() + $2 * interval '1 minute' where id = $1`,
    [id, next.waitMinutes],
  );
}

/**
 * Runs every few seconds in each server process: applies scheduled changes that are due, then checks
 * and advances running rollouts. `skip locked` lets several processes run it without doing work twice.
 * ponytail: scans every running rollout each tick. Add a "next check at" column if thousands run at once.
 */
export async function tick() {
  const due = await q(
    `select cr.id from change_requests cr join environments e on e.id = cr.environment_id
     where cr.status = 'scheduled' and cr.scheduled_at <= now() and not e.frozen`,
  );
  for (const { id } of due) {
    await tx(async (c) => {
      const { rows } = await c.query(
        "select * from change_requests where id = $1 and status = 'scheduled' for update skip locked",
        [id],
      );
      if (!rows[0]) return;
      await c.query("savepoint apply");
      try {
        await applyChange(c, rows[0]);
      } catch (err) {
        // For example the flag's config no longer validates. Record why instead of retrying forever.
        await c.query("rollback to savepoint apply");
        await c.query("update change_requests set status = 'failed', error = $2 where id = $1", [id, (err as Error).message]);
      }
    });
  }
  for (const { id } of await q("select id from rollouts where status = 'running'")) {
    await tx((c) => stepRollout(c, id));
  }
}
