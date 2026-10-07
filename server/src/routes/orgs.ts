import { randomBytes } from "node:crypto";
import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import { sha256 } from "../auth";
import { HttpError, pool, q, tx } from "../db";
import { requireRole } from "../tenancy";

const name = z.object({ name: z.string().trim().min(1).max(100) });
const member = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["viewer", "editor", "owner"]),
});

function newSdkKey() {
  const sdkKey = `sw_${randomBytes(24).toString("base64url")}`;
  return { sdkKey, hash: sha256(sdkKey), sdkKeyPrefix: sdkKey.slice(0, 10) };
}

/** The raw SDK key is returned only here, at creation; afterwards only its prefix is readable. */
async function createEnvironment(db: pg.Pool | pg.PoolClient, projectId: string, envName: string) {
  const { sdkKey, hash, sdkKeyPrefix } = newSdkKey();
  const { rows } = await db.query(
    // clock_timestamp(), not now(): environments created in one transaction must keep their creation order.
    `insert into environments (project_id, name, sdk_key_hash, sdk_key_prefix, created_at)
     values ($1, $2, $3, $4, clock_timestamp())
     returning id, name, sdk_key_prefix as "sdkKeyPrefix"`,
    [projectId, envName, hash, sdkKeyPrefix],
  );
  return { ...rows[0], sdkKey };
}

/** Rolls the transaction back if a membership change would leave the org with no owner. */
async function assertHasOwner(db: pg.PoolClient, orgId: string) {
  const { rowCount } = await db.query("select 1 from memberships where org_id = $1 and role = 'owner' limit 1", [orgId]);
  if (!rowCount) throw new HttpError(400, "An organization needs at least one owner");
}

export const orgs = Router();

orgs.get("/orgs", async (_req, res) => {
  res.json(
    await q(
      `select o.id, o.name, m.role from orgs o join memberships m on m.org_id = o.id
       where m.user_id = $1 order by o.name`,
      [res.locals.user.id],
    ),
  );
});

orgs.post("/orgs", async (req, res) => {
  const body = name.parse(req.body);
  const org = await tx(async (c) => {
    const { rows } = await c.query("insert into orgs (name) values ($1) returning id, name", [body.name]);
    await c.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [rows[0].id, res.locals.user.id]);
    return rows[0];
  });
  res.status(201).json({ ...org, role: "owner" });
});

orgs.get("/orgs/:orgId/members", requireRole("viewer", "org"), async (req, res) => {
  res.json(
    await q(
      `select u.id, u.email, m.role from memberships m join users u on u.id = m.user_id
       where m.org_id = $1 order by u.email`,
      [req.params.orgId],
    ),
  );
});

// Adds an existing user, or changes their role if already a member.
orgs.post("/orgs/:orgId/members", requireRole("owner", "org"), async (req, res) => {
  const body = member.parse(req.body);
  const [user] = await q("select id, email from users where email = $1", [body.email]);
  if (!user) throw new HttpError(404, "No account with that email. Ask them to sign up first.");
  await tx(async (c) => {
    await c.query(
      `insert into memberships (org_id, user_id, role) values ($1, $2, $3)
       on conflict (org_id, user_id) do update set role = excluded.role`,
      [req.params.orgId, user.id, body.role],
    );
    await assertHasOwner(c, req.params.orgId as string);
  });
  res.json({ ...user, role: body.role });
});

orgs.delete("/orgs/:orgId/members/:userId", requireRole("owner", "org"), async (req, res) => {
  await tx(async (c) => {
    await c.query("delete from memberships where org_id = $1 and user_id = $2", [req.params.orgId, req.params.userId]);
    await assertHasOwner(c, req.params.orgId as string);
  });
  res.json({});
});

orgs.get("/orgs/:orgId/projects", requireRole("viewer", "org"), async (req, res) => {
  res.json(await q("select id, name from projects where org_id = $1 order by name", [req.params.orgId]));
});

orgs.post("/orgs/:orgId/projects", requireRole("owner", "org"), async (req, res) => {
  const body = name.parse(req.body);
  const project = await tx(async (c) => {
    const { rows } = await c.query("insert into projects (org_id, name) values ($1, $2) returning id, name", [
      req.params.orgId,
      body.name,
    ]);
    const environments = [];
    for (const env of ["development", "staging", "production"]) {
      environments.push(await createEnvironment(c, rows[0].id, env));
    }
    return { ...rows[0], environments };
  });
  res.status(201).json(project);
});

orgs.get("/projects/:projectId", requireRole("viewer", "project"), async (req, res) => {
  const [project] = await q(`select id, name, org_id as "orgId" from projects where id = $1`, [req.params.projectId]);
  const environments = await q(
    `select id, name, sdk_key_prefix as "sdkKeyPrefix" from environments where project_id = $1 order by created_at, name`,
    [req.params.projectId],
  );
  res.json({ ...project, role: res.locals.role, environments });
});

orgs.post("/projects/:projectId/environments", requireRole("owner", "project"), async (req, res) => {
  const body = name.parse(req.body);
  res.status(201).json(await createEnvironment(pool, req.params.projectId as string, body.name));
});

// Old key stops working immediately.
orgs.post("/environments/:environmentId/rotate-key", requireRole("owner", "environment"), async (req, res) => {
  const { sdkKey, hash, sdkKeyPrefix } = newSdkKey();
  await q("update environments set sdk_key_hash = $1, sdk_key_prefix = $2 where id = $3", [
    hash,
    sdkKeyPrefix,
    req.params.environmentId,
  ]);
  res.json({ sdkKey, sdkKeyPrefix });
});
