import type { RequestHandler } from "express";
import { HttpError, q } from "./db";

export type Role = "viewer" | "editor" | "owner";

// How to find the owning org for each kind of resource id.
const orgOf = {
  org: "select $1::uuid as org_id",
  project: "select org_id from projects where id = $1",
  environment: "select p.org_id from environments e join projects p on p.id = e.project_id where e.id = $1",
  flag: "select p.org_id from flags f join projects p on p.id = f.project_id where f.id = $1",
  audit: "select org_id from audit_log where id = $1",
  segment: "select p.org_id from segments s join projects p on p.id = s.project_id where s.id = $1",
  change: "select org_id from change_requests where id = $1",
  rollout:
    "select p.org_id from rollouts r join flags f on f.id = r.flag_id join projects p on p.id = f.project_id where r.id = $1",
};

/**
 * Every dashboard route goes through this. Reads `req.params[<kind>Id]`, resolves its org,
 * and checks the signed-in user's membership. Non-members get 404 (not 403) so resource
 * ids from other tenants are indistinguishable from ids that do not exist.
 */
export const requireRole =
  (min: Role, kind: keyof typeof orgOf): RequestHandler =>
  async (req, res, next) => {
    const [membership] = await q(
      `select m.org_id, m.role, m.role >= $3::role as allowed
       from (${orgOf[kind]}) r join memberships m on m.org_id = r.org_id and m.user_id = $2`,
      [req.params[`${kind}Id`], res.locals.user.id, min],
    );
    if (!membership) throw new HttpError(404, "Not found");
    if (!membership.allowed) throw new HttpError(403, `Requires ${min} role`);
    res.locals.orgId = membership.org_id;
    res.locals.role = membership.role;
    next();
  };
