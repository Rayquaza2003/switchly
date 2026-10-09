import { useState, type CSSProperties, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  api, canEdit, cleanConditions, incomplete, useAction, useLoad,
  type Change, type Condition, type Environment, type Flag, type FlagConfig, type Project, type Segment,
} from "../api";
import { ChangesList, ConditionsEditor, describeConditions } from "./FlagPanels";
import { NewKeys } from "./Home";
import { Pipeline, type PipelineData } from "./Pipeline";

// ponytail: production is recognised by name. Add an explicit flag on environments if teams name it differently.
export const isProduction = (name: string) => /^prod/i.test(name);

const WEEK = 7 * 24 * 60 * 60 * 1000;
/** No app has asked about this flag for a week: the code that checks it is probably gone. */
const isStale = (flag: Flag) =>
  Date.now() - new Date(flag.createdAt).getTime() > WEEK &&
  (!flag.lastCheckedAt || Date.now() - new Date(flag.lastCheckedAt).getTime() > WEEK);

/** Segmented strip: the filled share is the share of users who get the feature. Grey when the flag is off. */
export function Meter({ config, large }: { config: FlagConfig; large?: boolean }) {
  return (
    <span
      className={`meter${large ? " large" : ""}${config.enabled ? "" : " off"}`}
      style={{ "--pct": config.rolloutPercentage } as CSSProperties}
      role="img"
      aria-label={`${config.rolloutPercentage}% rollout${config.enabled ? "" : ", switched off"}`}
    />
  );
}

export function summary(config: FlagConfig) {
  if (!config.enabled) return "Off for everyone";
  const targeted = config.targetedUsers.length;
  const rules = config.rules?.length ?? 0;
  if (config.rolloutPercentage === 100 && !rules) return "On for everyone";
  const parts = [];
  if (targeted) parts.push(`${targeted} selected ${targeted === 1 ? "user" : "users"}`);
  if (rules) parts.push(`${rules} ${rules === 1 ? "rule" : "rules"}`);
  if (config.rolloutPercentage) parts.push(`${config.rolloutPercentage}% of ${parts.length ? "the rest" : "users"}`);
  return parts.length ? `On for ${parts.join(" + ")}` : "On, but nobody is included yet";
}

/** What stands between an edit and this environment's users. */
export function EnvNotices({ env }: { env: Environment }) {
  return (
    <>
      {env.frozen && <p className="hazard">{env.name} is frozen. Flags can be switched off, nothing else.</p>}
      {!env.frozen && env.requiresApproval && (
        <p className="hazard">Changes in {env.name} need approval from a second person. Switching off does not.</p>
      )}
      {!env.frozen && !env.requiresApproval && isProduction(env.name) && (
        <p className="hazard">This is {env.name}. Changes reach real users within a second.</p>
      )}
    </>
  );
}

export function EnvTabs({ environments, current }: { environments: Environment[]; current: string }) {
  const [, setParams] = useSearchParams();
  return (
    <div className="tabs" role="tablist" aria-label="Environment">
      {environments.map((env) => (
        <button
          key={env.id}
          role="tab"
          className={isProduction(env.name) ? "prod" : undefined}
          aria-selected={env.id === current}
          onClick={() => setParams((p) => (p.set("env", env.id), p), { replace: true })}
        >
          {env.name}
        </button>
      ))}
    </div>
  );
}

/** Sections of one page. The chosen one lives in the URL, so reload and links keep it. */
export function SubTabs({ tabs, current }: { tabs: [id: string, label: string][]; current: string }) {
  const [, setParams] = useSearchParams();
  return (
    <div className="subtabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={id === current}
          onClick={() => setParams((p) => (p.set("tab", id), p), { replace: true })}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Segments({ projectId, editable, segments, reload }: {
  projectId: string;
  editable: boolean;
  segments: Segment[];
  reload: () => unknown;
}) {
  const blank = { id: "", name: "", conditions: [{ attribute: "", op: "is", values: [] }] as Condition[] };
  const [draft, setDraft] = useState(blank);
  const [error, run] = useAction();

  async function save(event: FormEvent) {
    event.preventDefault();
    const body = { name: draft.name, conditions: cleanConditions(draft.conditions) };
    const ok = await run(() => (draft.id ? api("PUT", `/segments/${draft.id}`, body) : api("POST", `/projects/${projectId}/segments`, body)));
    if (ok) setDraft(blank);
    reload();
  }
  const remove = (segment: Segment) => {
    if (!confirm(`Delete ${segment.name}? Rules that use it will match nobody.`)) return;
    run(() => api("DELETE", `/segments/${segment.id}`)).then(reload);
  };

  return (
    <section>
      <p className="muted">A named group of users, such as beta testers, that any flag's rules can use.</p>
      <div className="panel">
        {segments.length === 0 && <p className="empty">No segments yet.</p>}
        <ul className="rows">
          {segments.map((segment) => (
            <li key={segment.id}>
              <div className="grow">
                <strong>{segment.name}</strong>
                <div className="muted small">{describeConditions(segment.conditions)}</div>
              </div>
              {editable && (
                <>
                  <button className="ghost small" onClick={() => setDraft(segment)}>Edit</button>
                  <button className="ghost small" onClick={() => remove(segment)}>Delete</button>
                </>
              )}
            </li>
          ))}
        </ul>
        {editable && (
          <form onSubmit={save} className="foot stack tight">
            <label>
              {draft.id ? "Segment name" : "New segment name"}
              <input value={draft.name} required maxLength={100} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <ConditionsEditor conditions={draft.conditions} onChange={(conditions) => setDraft({ ...draft, conditions })} lead="Where" />
            <div className="inline">
              <button type="submit" disabled={incomplete(draft.conditions)}>{draft.id ? "Save segment" : "Create segment"}</button>
              {draft.id && <button type="button" className="ghost" onClick={() => setDraft(blank)}>Cancel</button>}
              {error && <p className="error" role="alert">{error}</p>}
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

export function ProjectPage() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const project = useLoad(() => api<Project>("GET", `/projects/${projectId}`), [projectId]);
  const flags = useLoad(() => api<Flag[]>("GET", `/projects/${projectId}/flags`), [projectId]);
  const segments = useLoad(() => api<Segment[]>("GET", `/projects/${projectId}/segments`), [projectId]);
  const changes = useLoad(() => api<Change[]>("GET", `/projects/${projectId}/changes`), [projectId]);
  const pipeline = useLoad(() => api<PipelineData>("GET", `/projects/${projectId}/pipeline`), [projectId]);
  const [error, run] = useAction();
  const [newKeys, setNewKeys] = useState<Environment[]>([]);

  if (project.error) return <p className="error" role="alert">{project.error}</p>;
  if (!project.data) return null;
  const { environments, role } = project.data;
  const env = environments.find((e) => e.id === params.get("env")) ?? environments[0];
  const envId = env.id;
  const editable = canEdit(role);
  const onCount = flags.data?.filter((f) => f.configs[envId].enabled).length ?? 0;
  const tab = params.get("tab") ?? "flags";
  const waiting = (flag: Flag) => changes.data?.filter((c) => c.flagId === flag.id && c.environmentId === envId).length ?? 0;

  // Switching on where approval is needed files a request; everything else applies at once.
  const toggle = (flag: Flag) => {
    const next = { ...flag.configs[envId], enabled: !flag.configs[envId].enabled };
    const path = `/flags/${flag.id}/environments/${envId}`;
    const request = next.enabled && env.requiresApproval;
    run(() => (request ? api("POST", `${path}/changes`, { config: next }) : api("PUT", path, next))).then(() => {
      flags.reload();
      changes.reload();
    });
  };

  async function createFlag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    if (await run(() => api("POST", `/projects/${projectId}/flags`, body))) form.reset();
    flags.reload();
  }

  async function addEnvironment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    const ok = await run(async () => setNewKeys([await api("POST", `/projects/${projectId}/environments`, body)]));
    if (ok) form.reset();
    project.reload();
  }

  const rotate = (target: Environment) => {
    if (!confirm(`Rotate the ${target.name} key? Apps using the current key stop receiving flags until they get the new one.`)) return;
    run(async () => {
      const rotated = await api("POST", `/environments/${target.id}/rotate-key`);
      setNewKeys([{ ...target, ...rotated }]);
    }).then(project.reload);
  };
  const guard = (target: Environment, patch: Partial<Environment>) =>
    run(() => api("PATCH", `/environments/${target.id}`, patch)).then(project.reload);

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/">Projects</Link> / {project.data.name}
      </nav>
      <div className="pagehead">
        <div>
          <h1>{project.data.name}</h1>
          {flags.data && flags.data.length > 0 && (
            <p className="muted">
              {onCount} of {flags.data.length} {flags.data.length === 1 ? "flag" : "flags"} switched on in {env.name}
            </p>
          )}
        </div>
        <EnvTabs environments={environments} current={envId} />
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      <SubTabs
        current={tab}
        tabs={[
          ["flags", `Flags${flags.data ? ` (${flags.data.length})` : ""}`],
          // Shown only for projects the server operator has connected to a repository.
          ...(pipeline.data?.enabled ? [["deploy", "Deploy"] as [string, string]] : []),
          ["segments", `Segments${segments.data ? ` (${segments.data.length})` : ""}`],
          ["environments", "Environments"],
        ]}
      />

      {tab === "flags" && (
        <>
          <section className="panel">
            <EnvNotices env={env} />
            {flags.data?.length === 0 && (
              <p className="empty">
                No flags yet. Create one, wrap the new feature in <code>isEnabled("your-flag")</code>, and ship it switched off.
              </p>
            )}
            <ul className="rows">
              {flags.data?.map((flag) => {
                const config = flag.configs[envId];
                return (
                  <li key={flag.id} className={`flag${config.enabled ? "" : " is-off"}`}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`${flag.key} in ${env.name}`}
                      checked={config.enabled}
                      disabled={!editable}
                      onChange={() => toggle(flag)}
                    />
                    <div>
                      <Link to={`/flags/${flag.id}?env=${envId}`} className="key">{flag.key}</Link>
                      {flag.description && <div className="muted small">{flag.description}</div>}
                      {waiting(flag) > 0 && (
                        <div className="stale small">{waiting(flag)} {waiting(flag) === 1 ? "change" : "changes"} waiting</div>
                      )}
                      {isStale(flag) && (
                        <div className="stale small">No app has checked this flag for a week. If its code is gone, delete it.</div>
                      )}
                    </div>
                    <div className="reach">
                      <span className={config.enabled ? undefined : "muted"}>{summary(config)}</span>
                      <Meter config={config} />
                    </div>
                  </li>
                );
              })}
            </ul>
            {editable && (
              <form onSubmit={createFlag} className="foot inline">
                <label>
                  New flag key
                  <input name="key" required pattern="[a-z0-9][a-z0-9._\-]*" maxLength={100} placeholder="new-checkout" className="mono" />
                </label>
                <label className="grow">
                  What it controls
                  <input name="description" maxLength={500} />
                </label>
                <button type="submit">Create flag</button>
              </form>
            )}
          </section>

          {changes.data && changes.data.length > 0 && (
            <section>
              <h2>Waiting changes</h2>
              <div className="panel">
                <ChangesList
                  changes={changes.data}
                  editable={editable}
                  showFlag
                  run={run}
                  onChanged={() => { changes.reload(); flags.reload(); }}
                />
              </div>
            </section>
          )}
        </>
      )}

      {tab === "deploy" && pipeline.data?.enabled && (
        <Pipeline data={pipeline.data} reload={pipeline.reload} editable={editable} />
      )}

      {tab === "segments" && (
        <Segments projectId={projectId!} editable={editable} segments={segments.data ?? []} reload={segments.reload} />
      )}

      {tab === "environments" && (
        <section>
          <p className="muted">Each environment has its own SDK key, which apps send to fetch their flags.</p>
          <div className="panel">
            <ul className="rows">
              {environments.map((e) => (
                <li key={e.id}>
                  <div className="grow">
                    <strong>{e.name}</strong>
                    <div><code className="muted">{e.sdkKeyPrefix}…</code></div>
                  </div>
                  <label className="check" title="A second person must approve every change except switching off">
                    <input type="checkbox" role="switch" checked={e.requiresApproval} disabled={role !== "owner"} onChange={() => guard(e, { requiresApproval: !e.requiresApproval })} />
                    Needs approval
                  </label>
                  <label className="check" title="Blocks every change except switching off; pauses rollouts and scheduled changes">
                    <input type="checkbox" role="switch" checked={e.frozen} disabled={role !== "owner"} onChange={() => guard(e, { frozen: !e.frozen })} />
                    Frozen
                  </label>
                  {role === "owner" && (
                    <button className="ghost small" onClick={() => rotate(e)}>
                      Rotate key
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {role === "owner" && (
              <form onSubmit={addEnvironment} className="foot inline">
                <label>
                  New environment name
                  <input name="name" required maxLength={100} />
                </label>
                <button type="submit">Add environment</button>
              </form>
            )}
          </div>
          <NewKeys environments={newKeys} />
        </section>
      )}
    </>
  );
}
