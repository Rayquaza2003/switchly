import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { q } from "./db";

/**
 * Deploying runs git and docker on the machine this server runs on. Which projects may do that, and
 * from which repository, is decided by the server's operator in a file, never through the dashboard:
 * a tenant must not be able to point the server at an arbitrary path.
 *
 * deploy.config.json: { "<project id>": { repo, switchlyUrl, instances: { "<environment name>": { port, container, sdkKey } } } }
 */
const configSchema = z.record(
  z.object({
    repo: z.string().min(1),
    switchlyUrl: z.string().url().default("http://localhost:3000"),
    containerPort: z.number().int().default(8080),
    instances: z.record(
      z.object({
        port: z.number().int().min(1).max(65535),
        container: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
        // Raw SDK key for the instance's environment. Switchly itself stores only its hash.
        sdkKey: z.string().min(1),
      }),
    ),
  }),
);
export type ProjectPipeline = z.infer<typeof configSchema>[string];

const configPath = process.env.DEPLOY_CONFIG ?? new URL("../deploy.config.json", import.meta.url).pathname;

/** Read on every use, so the operator can edit the file without a restart. */
export async function pipelineOf(projectId: string): Promise<ProjectPipeline | undefined> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return undefined;
  }
  return configSchema.parse(JSON.parse(text))[projectId];
}

/** Runs a program with an argument list (no shell, so nothing in the arguments is interpreted). */
function run(command: string, args: string[], pipeFrom?: { command: string; args: string[] }) {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    let output = "";
    const child = spawn(command, args);
    const collect = (chunk: Buffer) => (output += chunk);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let sourceFailed = false;
    if (pipeFrom) {
      const source = spawn(pipeFrom.command, pipeFrom.args);
      source.stderr.on("data", collect);
      source.on("error", (err) => { sourceFailed = true; output += `${err.message}\n`; child.stdin.end(); });
      source.on("close", (code) => { if (code) sourceFailed = true; });
      source.stdout.pipe(child.stdin);
    }
    child.on("error", (err) => resolve({ ok: false, output: `${output}${err.message}\n` }));
    child.on("close", (code) => resolve({ ok: code === 0 && !sourceFailed, output }));
  });
}

export interface Branch {
  name: string;
  sha: string;
  subject: string;
}

export async function listBranches(repo: string): Promise<Branch[]> {
  const result = await run("git", ["-C", repo, "for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(subject)", "refs/heads"]);
  if (!result.ok) throw new Error(`Cannot read branches of ${repo}: ${result.output.trim()}`);
  return result.output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha, ...subject] = line.split("\t");
      return { name, sha, subject: subject.join("\t") };
    });
}

/**
 * Builds the commit into an image and replaces the instance's container with it. Runs after the request
 * has returned; progress goes to the deployment row. `sha` and every other argument come from git's own
 * output or the operator's config, never straight from a request.
 */
export async function runDeployment(args: {
  deploymentId: string;
  pipeline: ProjectPipeline;
  environment: string;
  branch: string;
  sha: string;
}) {
  const { deploymentId, pipeline, environment, branch, sha } = args;
  const instance = pipeline.instances[environment];
  const image = `switchly-deploy:${sha.slice(0, 12)}`;
  let log = "";
  let ok = true;

  const step = async (title: string, action: () => ReturnType<typeof run>, optional = false) => {
    if (!ok) return;
    log += `> ${title}\n`;
    const result = await action();
    // The legacy-builder notice is noise on every build.
    log += result.output.replace(/DEPRECATED: The legacy builder[\s\S]*?buildx\/\s*/, "");
    if (!result.ok && !optional) ok = false;
    await q("update deployments set log = $2 where id = $1", [deploymentId, log]);
  };

  try {
    await step(`Build ${branch} at ${sha.slice(0, 7)}`, () =>
      run("docker", ["build", "-q", "-t", image, "-"], { command: "git", args: ["-C", pipeline.repo, "archive", sha] }),
    );
    await step(`Stop current ${environment} instance`, () => run("docker", ["rm", "-f", instance.container]), true);
    // The SDK key is passed here and deliberately kept out of the log.
    await step(`Start ${environment} instance on port ${instance.port}`, () =>
      run("docker", [
        "run", "-d", "--name", instance.container,
        "-p", `${instance.port}:${pipeline.containerPort}`,
        "-e", `SWITCHLY_SDK_KEY=${instance.sdkKey}`,
        "-e", `SWITCHLY_URL=${pipeline.switchlyUrl}`,
        "-e", `ENVIRONMENT=${environment}`,
        "-e", `BRANCH=${branch}`,
        "-e", `PORT=${pipeline.containerPort}`,
        image,
      ]),
    );
  } catch (err) {
    ok = false;
    log += `${(err as Error).message}\n`;
  }
  await q("update deployments set status = $2, log = $3, finished_at = now() where id = $1", [
    deploymentId,
    ok ? "succeeded" : "failed",
    log,
  ]);
}
