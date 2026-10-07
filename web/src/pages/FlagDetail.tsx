import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, canEdit, useAction, useLoad, type Flag, type FlagConfig, type Project } from "../api";
import { EnvTabs, Meter, summary } from "./Project";

interface AuditEntry {
  id: string;
  action: string;
  environmentId: string | null;
  environment: string | null;
  actor: string | null;
  before: FlagConfig | null;
  after: FlagConfig | null;
  createdAt: string;
}

const parseUsers = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

function describe({ action, before, after }: AuditEntry) {
  if (action === "flag.created") return "Created the flag";
  if (!before || !after) return action;
  const changes = [];
  if (before.enabled !== after.enabled) changes.push(after.enabled ? "switched on" : "switched off");
  if (before.rolloutPercentage !== after.rolloutPercentage) {
    changes.push(`rollout ${before.rolloutPercentage}% to ${after.rolloutPercentage}%`);
  }
  if (before.targetedUsers.join() !== after.targetedUsers.join()) {
    changes.push(`selected users ${before.targetedUsers.length} to ${after.targetedUsers.length}`);
  }
  const text = changes.join(", ") || "saved with no changes";
  return action === "config.reverted" ? `Reverted: ${text}` : text[0].toUpperCase() + text.slice(1);
}

export function FlagDetail() {
  const { flagId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const flag = useLoad(() => api<Flag>("GET", `/flags/${flagId}`), [flagId]);
  const projectId = flag.data?.projectId;
  const project = useLoad(
    () => (projectId ? api<Project>("GET", `/projects/${projectId}`) : Promise.resolve(undefined)),
    [projectId],
  );
  const audit = useLoad(
    () => (projectId ? api<AuditEntry[]>("GET", `/projects/${projectId}/audit?flagId=${flagId}`) : Promise.resolve([])),
    [projectId, flagId],
  );
  const [error, run] = useAction();

  const environments = project.data?.environments ?? [];
  const envId = environments.find((e) => e.id === params.get("env"))?.id ?? environments[0]?.id;
  const saved = envId ? flag.data?.configs[envId] : undefined;

  // Draft of the rollout settings; reset whenever the saved config or environment changes.
  const [percentage, setPercentage] = useState(0);
  const [users, setUsers] = useState("");
  useEffect(() => {
    if (!saved) return;
    setPercentage(saved.rolloutPercentage);
    setUsers(saved.targetedUsers.join("\n"));
  }, [saved]);

  if (flag.error) return <p className="error" role="alert">{flag.error}</p>;
  if (!flag.data || !project.data || !saved) return null;

  const editable = canEdit(project.data.role);
  const envName = environments.find((e) => e.id === envId)!.name;
  const draft: FlagConfig = { enabled: saved.enabled, rolloutPercentage: percentage, targetedUsers: parseUsers(users) };
  const dirty = percentage !== saved.rolloutPercentage || draft.targetedUsers.join() !== saved.targetedUsers.join();
  const refresh = () => Promise.all([flag.reload(), audit.reload()]);
  const save = (config: FlagConfig) => run(() => api("PUT", `/flags/${flagId}/environments/${envId}`, config)).then(refresh);

  const remove = () => {
    if (!confirm(`Delete ${flag.data!.key}? Apps will get the fallback value for it in every environment.`)) return;
    run(() => api("DELETE", `/flags/${flagId}`)).then((ok) => ok && navigate(`/projects/${projectId}`));
  };

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/">Projects</Link> / <Link to={`/projects/${projectId}?env=${envId}`}>{project.data.name}</Link> /{" "}
        {flag.data.key}
      </nav>
      <div className="pagehead">
        <h1><code>{flag.data.key}</code></h1>
        <EnvTabs environments={environments} current={envId!} />
      </div>
      {flag.data.description && <p className="muted">{flag.data.description}</p>}

      <section className="killswitch">
        <label>
          <input
            type="checkbox"
            role="switch"
            checked={saved.enabled}
            disabled={!editable}
            // The switch saves immediately and leaves unsaved rollout edits alone.
            onChange={() => save({ ...saved, enabled: !saved.enabled })}
          />
          <span>
            <strong>{summary(saved)}</strong> in {envName}
          </span>
        </label>
        <p className="muted">
          Switching off overrides everything below and reaches apps on their next poll, about 10 seconds.
        </p>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      <fieldset disabled={!editable} className="stack">
        <legend>Who gets it when switched on</legend>
        <label>
          Selected users, one id per line
          <textarea
            rows={4}
            className="mono"
            value={users}
            onChange={(e) => setUsers(e.target.value)}
            placeholder={"user-123\nuser-456"}
          />
          <small className="muted">These users always get the feature, whatever the percentage.</small>
        </label>
        <label>
          Share of all other users: {percentage}%
          <input type="range" min={0} max={100} value={percentage} onChange={(e) => setPercentage(Number(e.target.value))} />
        </label>
        <Meter config={draft} large />
        <small className="muted">
          Each user lands in the same slot every time, so raising the percentage only adds users and never removes any.
        </small>
        <div className="inline">
          <button disabled={!dirty} onClick={() => save(draft)}>Save changes</button>
          {dirty && <span className="muted">Unsaved changes</span>}
        </div>
      </fieldset>

      <section>
        <h2>History</h2>
        <ul className="rows">
          {audit.data
            ?.filter((entry) => !entry.environmentId || entry.environmentId === envId)
            .map((entry) => (
              <li key={entry.id}>
                <div className="grow">
                  {describe(entry)}
                  <div className="muted">
                    {entry.actor ?? "Deleted user"}, {new Date(entry.createdAt).toLocaleString()}
                  </div>
                </div>
                {editable && entry.before && (
                  <button
                    className="quiet"
                    title="Restore the settings from just before this change"
                    onClick={() => run(() => api("POST", `/audit/${entry.id}/revert`)).then(refresh)}
                  >
                    Undo this change
                  </button>
                )}
              </li>
            ))}
        </ul>
      </section>

      {editable && (
        <section>
          <button className="danger" onClick={remove}>Delete flag</button>
        </section>
      )}
    </>
  );
}
