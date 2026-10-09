import { basename } from "node:path";
import { Router } from "express";
import { z } from "zod";
import { HttpError, q } from "../db";
import { listBranches, pipelineOf, runDeployment } from "../deployer";
import { requireRole } from "../tenancy";

const deploymentCols = `d.id, d.branch, d.commit_sha as "commitSha", d.commit_subject as "commitSubject", d.status,
  d.created_at as "createdAt", d.finished_at as "finishedAt", u.email as "triggeredBy"`;

export const deploy = Router();

// Source branches on one side, one instance per environment on the other.
deploy.get("/projects/:projectId/pipeline", requireRole("viewer", "project"), async (req, res) => {
  const pipeline = await pipelineOf(req.params.projectId as string);
  if (!pipeline) return void res.json({ enabled: false });
  const [branches, environments, history] = await Promise.all([
    listBranches(pipeline.repo),
    q("select id, name, frozen from environments where project_id = $1 order by created_at, name", [req.params.projectId]),
    q(
      `select d.environment_id, ${deploymentCols} from deployments d left join users u on u.id = d.triggered_by
       where d.project_id = $1 order by d.created_at desc limit 200`,
      [req.params.projectId],
    ),
  ]);
  const instances = environments
    .filter((env) => pipeline.instances[env.name])
    .map((env) => {
      const deployments = history.filter((d) => d.environment_id === env.id).map(({ environment_id, ...d }) => d);
      const [current] = deployments;
      // What "roll back" restores: the last good deploy of a different commit.
      const live = deployments.find((d) => d.status === "succeeded");
      const rollbackTo = deployments.find((d) => d.status === "succeeded" && d.commitSha !== live?.commitSha) ?? null;
      return {
        environmentId: env.id,
        name: env.name,
        frozen: env.frozen,
        url: `http://localhost:${pipeline.instances[env.name].port}`,
        current: current ?? null,
        live: live ?? null,
        rollbackTo,
        history: deployments.slice(0, 6),
      };
    });
  res.json({ enabled: true, repo: basename(pipeline.repo), branches, instances });
});

// Deploys a branch at its latest commit, or repeats an earlier deployment (that is a rollback).
deploy.post("/environments/:environmentId/deploy", requireRole("editor", "environment"), async (req, res) => {
  const body = z
    .object({ branch: z.string().max(200).optional(), deploymentId: z.string().uuid().optional() })
    .refine((b) => !!b.branch !== !!b.deploymentId, "Send either branch or deploymentId")
    .parse(req.body);
  const [env] = await q("select id, name, project_id, frozen from environments where id = $1", [req.params.environmentId]);
  const pipeline = await pipelineOf(env.project_id);
  if (!pipeline?.instances[env.name]) throw new HttpError(400, "Deploying is not set up for this environment");
  if (env.frozen) throw new HttpError(403, `${env.name} is frozen. Unfreeze it before deploying.`);

  let target: { branch: string; sha: string; subject: string };
  if (body.branch) {
    // Only a name git itself lists is accepted, so the request cannot smuggle in options or paths.
    const branch = (await listBranches(pipeline.repo)).find((b) => b.name === body.branch);
    if (!branch) throw new HttpError(404, "No such branch");
    target = { branch: branch.name, sha: branch.sha, subject: branch.subject };
  } else {
    const [earlier] = await q(
      "select branch, commit_sha as sha, commit_subject as subject from deployments where id = $1 and environment_id = $2",
      [body.deploymentId, env.id],
    );
    if (!earlier) throw new HttpError(404, "No such deployment for this environment");
    target = earlier;
  }

  // The unique index on in-flight deployments turns a second concurrent deploy into a 409.
  const [deployment] = await q(
    `insert into deployments (project_id, environment_id, branch, commit_sha, commit_subject, triggered_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [env.project_id, env.id, target.branch, target.sha, target.subject, res.locals.user.id],
  ).catch((err) => {
    if (err.code === "23505") throw new HttpError(409, `A deploy to ${env.name} is already running`);
    throw err;
  });
  void runDeployment({ deploymentId: deployment.id, pipeline, environment: env.name, branch: target.branch, sha: target.sha });
  res.status(202).json(deployment);
});

deploy.get("/deployments/:deploymentId", requireRole("viewer", "deployment"), async (req, res) => {
  const [deployment] = await q(
    `select ${deploymentCols}, d.log from deployments d left join users u on u.id = d.triggered_by where d.id = $1`,
    [req.params.deploymentId],
  );
  res.json(deployment);
});
