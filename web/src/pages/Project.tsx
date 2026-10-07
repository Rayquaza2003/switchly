import { useState, type CSSProperties, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, canEdit, useAction, useLoad, type Environment, type Flag, type FlagConfig, type Project } from "../api";
import { NewKeys } from "./Home";

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
  if (config.rolloutPercentage === 100) return "On for everyone";
  const parts = [];
  if (targeted) parts.push(`${targeted} selected ${targeted === 1 ? "user" : "users"}`);
  if (config.rolloutPercentage) parts.push(`${config.rolloutPercentage}% of ${targeted ? "the rest" : "users"}`);
  return parts.length ? `On for ${parts.join(" + ")}` : "On, but nobody is included yet";
}

export function EnvTabs({ environments, current }: { environments: Environment[]; current: string }) {
  const [, setParams] = useSearchParams();
  return (
    <div className="tabs" role="tablist" aria-label="Environment">
      {environments.map((env) => (
        <button
          key={env.id}
          role="tab"
          aria-selected={env.id === current}
          onClick={() => setParams({ env: env.id }, { replace: true })}
        >
          {env.name}
        </button>
      ))}
    </div>
  );
}

export function ProjectPage() {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const project = useLoad(() => api<Project>("GET", `/projects/${projectId}`), [projectId]);
  const flags = useLoad(() => api<Flag[]>("GET", `/projects/${projectId}/flags`), [projectId]);
  const [error, run] = useAction();
  const [newKeys, setNewKeys] = useState<Environment[]>([]);

  if (project.error) return <p className="error" role="alert">{project.error}</p>;
  if (!project.data) return null;
  const { environments, role } = project.data;
  const envId = environments.find((e) => e.id === params.get("env"))?.id ?? environments[0].id;
  const editable = canEdit(role);

  const toggle = (flag: Flag) =>
    run(() =>
      api("PUT", `/flags/${flag.id}/environments/${envId}`, {
        ...flag.configs[envId],
        enabled: !flag.configs[envId].enabled,
      }),
    ).then(flags.reload);

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

  const rotate = (env: Environment) => {
    if (!confirm(`Rotate the ${env.name} key? Apps using the current key stop receiving flags until they get the new one.`)) return;
    run(async () => {
      const rotated = await api("POST", `/environments/${env.id}/rotate-key`);
      setNewKeys([{ ...env, ...rotated }]);
    }).then(project.reload);
  };

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/">Projects</Link> / {project.data.name}
      </nav>
      <div className="pagehead">
        <h1>{project.data.name}</h1>
        <EnvTabs environments={environments} current={envId} />
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      <section>
        {flags.data?.length === 0 && (
          <p className="muted">
            No flags yet. Create one, wrap the new feature in <code>isEnabled("your-flag")</code>, and ship it switched off.
          </p>
        )}
        <ul className="rows">
          {flags.data?.map((flag) => {
            const config = flag.configs[envId];
            return (
              <li key={flag.id}>
                <div className="grow">
                  <Link to={`/flags/${flag.id}?env=${envId}`}><code>{flag.key}</code></Link>
                  {flag.description && <div className="muted">{flag.description}</div>}
                </div>
                <span className="muted status">{summary(config)}</span>
                <Meter config={config} />
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`${flag.key} in this environment`}
                  checked={config.enabled}
                  disabled={!editable}
                  onChange={() => toggle(flag)}
                />
              </li>
            );
          })}
        </ul>
        {editable && (
          <form onSubmit={createFlag} className="inline">
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

      <section>
        <h2>SDK keys</h2>
        <p className="muted">Each environment has its own key. Apps send it to fetch their flags.</p>
        <ul className="rows">
          {environments.map((env) => (
            <li key={env.id}>
              <span className="grow">{env.name}</span>
              <code className="muted">{env.sdkKeyPrefix}…</code>
              {role === "owner" && (
                <button className="quiet" onClick={() => rotate(env)}>
                  Rotate key
                </button>
              )}
            </li>
          ))}
        </ul>
        <NewKeys environments={newKeys} />
        {role === "owner" && (
          <form onSubmit={addEnvironment} className="inline">
            <label>
              New environment name
              <input name="name" required maxLength={100} />
            </label>
            <button type="submit">Add environment</button>
          </form>
        )}
      </section>
    </>
  );
}
