import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  api, canEdit, cleanRules, incomplete, useAction, useLoad,
  type Flag, type FlagConfig, type Overview, type Project, type Rule, type Segment,
} from "../api";
import { ChangesList, RolloutPanel, RulesEditor, Usage } from "./FlagPanels";
import { EnvNotices, EnvTabs, Meter, SubTabs, summary } from "./Project";

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
const rulesKey = (rules: Rule[] = []) => JSON.stringify(cleanRules(rules));

const PREFIX: Record<string, string> = {
  "config.reverted": "Undone: ",
  "change.applied": "Approved or scheduled change: ",
  "rollout.started": "Rollout started: ",
  "rollout.advanced": "Rollout step: ",
  "rollout.rolled_back": "Switched off automatically, too many failures: ",
};

function describe({ action, before, after }: AuditEntry) {
  if (action === "flag.created") return "Created the flag";
  if (!before || !after) return action;
  const changes = [];
  if (before.enabled !== after.enabled) changes.push(after.enabled ? "switched on" : "switched off");
  if (before.rolloutPercentage !== after.rolloutPercentage) {
    changes.push(`share ${before.rolloutPercentage}% to ${after.rolloutPercentage}%`);
  }
  if (before.targetedUsers.join() !== after.targetedUsers.join()) {
    changes.push(`selected users ${before.targetedUsers.length} to ${after.targetedUsers.length}`);
  }
  if (rulesKey(before.rules) !== rulesKey(after.rules)) changes.push("rules changed");
  const text = changes.join(", ") || "saved with no changes";
  return PREFIX[action] ? PREFIX[action] + text : text[0].toUpperCase() + text.slice(1);
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
  const segments = useLoad(
    () => (projectId ? api<Segment[]>("GET", `/projects/${projectId}/segments`) : Promise.resolve([])),
    [projectId],
  );
  const audit = useLoad(
    () => (projectId ? api<AuditEntry[]>("GET", `/projects/${projectId}/audit?flagId=${flagId}`) : Promise.resolve([])),
    [projectId, flagId],
  );
  const [error, run] = useAction();

  const environments = project.data?.environments ?? [];
  const env = environments.find((e) => e.id === params.get("env")) ?? environments[0];
  const envId = env?.id;
  const overview = useLoad(
    () => (envId ? api<Overview>("GET", `/flags/${flagId}/environments/${envId}/overview`) : Promise.resolve(undefined)),
    [flagId, envId],
  );
  const saved = envId ? flag.data?.configs[envId] : undefined;

  // Draft of the rollout settings; reset whenever the saved config or environment changes.
  const [percentage, setPercentage] = useState(0);
  const [users, setUsers] = useState("");
  const [rules, setRules] = useState<Rule[]>([]);
  const [scheduleAt, setScheduleAt] = useState("");
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!saved) return;
    setPercentage(saved.rolloutPercentage);
    setUsers(saved.targetedUsers.join("\n"));
    setRules(saved.rules);
  }, [saved]);
  useEffect(() => setNotice(""), [envId]);

  // A running rollout changes the flag from the server side; keep the page in step with it.
  const rolling = overview.data?.rollout?.status === "running";
  useEffect(() => {
    if (!rolling) return;
    const timer = setInterval(() => void Promise.all([flag.reload(), overview.reload(), audit.reload()]), 5000);
    return () => clearInterval(timer);
  }, [rolling, flag.reload, overview.reload, audit.reload]);

  if (flag.error) return <p className="error" role="alert">{flag.error}</p>;
  if (!flag.data || !project.data || !saved || !env) return null;

  const editable = canEdit(project.data.role);
  const path = `/flags/${flagId}/environments/${envId}`;
  const draft: FlagConfig = { enabled: saved.enabled, rolloutPercentage: percentage, targetedUsers: parseUsers(users), rules: cleanRules(rules) };
  const dirty =
    percentage !== saved.rolloutPercentage ||
    draft.targetedUsers.join() !== saved.targetedUsers.join() ||
    rulesKey(rules) !== rulesKey(saved.rules);
  const unfinished = rules.some((r) => incomplete(r.conditions));
  const waits = env.requiresApproval || !!scheduleAt;
  const refresh = () => Promise.all([flag.reload(), audit.reload(), overview.reload()]);
  const edited = <T,>(set: (value: T) => void) => (value: T) => { set(value); setNotice(""); };
  const tab = params.get("tab") ?? "targeting";
  const history = audit.data?.filter((entry) => !entry.environmentId || entry.environmentId === envId) ?? [];

  /** Saves at once, or files a change request when the environment needs approval or a time was set. */
  async function submit(config: FlagConfig, done: string) {
    const body = { config, note, scheduledAt: scheduleAt ? new Date(scheduleAt).toISOString() : undefined };
    // Switching off is never held back.
    const direct = !waits || (!config.enabled && saved!.enabled && !dirty);
    const ok = await run(() => (direct ? api("PUT", path, config) : api("POST", `${path}/changes`, body)));
    await refresh();
    if (!ok) return;
    setNotice(direct ? done : env.requiresApproval ? "Approval requested" : "Changes scheduled");
    if (!direct) {
      setScheduleAt("");
      setNote("");
      // The request holds the draft now; show the live settings again.
      setPercentage(saved!.rolloutPercentage);
      setUsers(saved!.targetedUsers.join("\n"));
      setRules(saved!.rules);
    }
  }

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
        <div>
          <h1><code>{flag.data.key}</code></h1>
          {flag.data.description && <p className="muted">{flag.data.description}</p>}
        </div>
        <EnvTabs environments={environments} current={envId!} />
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      <div className="hero">
        <section className="panel">
          <EnvNotices env={env} />
          <label className="power">
            <input
              type="checkbox"
              role="switch"
              checked={saved.enabled}
              disabled={!editable}
              // The switch acts on the saved settings and leaves unsaved edits alone.
              onChange={() => {
                const next = { ...saved, enabled: !saved.enabled };
                if (next.enabled && env.requiresApproval) {
                  run(() => api("POST", `${path}/changes`, { config: next })).then((ok) => { refresh(); if (ok) setNotice("Approval requested"); });
                } else {
                  run(() => api("PUT", path, next)).then(refresh);
                }
              }}
            />
            <strong>{summary(saved)}</strong>
            <p className="muted small">
              Switching off overrides everything below, needs no approval, and reaches connected apps within a second.
            </p>
          </label>
        </section>
        <section className="panel pad">
          <h2>Use in the last 24 hours</h2>
          {overview.data && <Usage stats={overview.data.stats} />}
        </section>
      </div>

      {overview.data && overview.data.changes.length > 0 && (
        <section className="panel">
          <h2 className="panelhead">Waiting changes</h2>
          <ChangesList changes={overview.data.changes} editable={editable} run={run} onChanged={refresh} />
        </section>
      )}

      <SubTabs
        current={tab}
        tabs={[
          ["targeting", "Who gets it"],
          ["rollout", rolling ? "Rollout (running)" : "Rollout"],
          ["history", "History"],
        ]}
      />

      {tab === "targeting" && (
        <section className="panel pad narrow">
          <fieldset disabled={!editable} className="stack" aria-label="Who gets it when switched on">
            <label>
              Selected users, one id per line
              <textarea
                rows={3}
                className="mono"
                value={users}
                onChange={(e) => edited(setUsers)(e.target.value)}
                placeholder={"user-123\nuser-456"}
              />
              <small className="muted">These users always get the feature, whatever the rules and percentage.</small>
            </label>
            <RulesEditor rules={rules} onChange={edited(setRules)} segments={segments.data ?? []} />
            <div>
              <label>
                Share of all other users
                <span className="figure">{percentage}%</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={percentage}
                  onChange={(e) => edited(setPercentage)(Number(e.target.value))}
                />
              </label>
              <Meter config={draft} large />
              <div className="scale" aria-hidden="true">
                <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
              </div>
            </div>
            <small className="muted">
              Each user lands in the same slot every time, so raising the percentage only adds users and never removes any.
            </small>
            <div className="savebar">
              <label>
                Apply later (optional)
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
              </label>
              {waits && (
                <label className="grow">
                  Note for the reviewer or the record
                  <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
                </label>
              )}
              <button disabled={!dirty || unfinished} onClick={() => submit(draft, "Changes saved")}>
                {env.requiresApproval ? "Request approval" : scheduleAt ? "Schedule changes" : "Save changes"}
              </button>
              <div className="status small">
                {unfinished && <span className="error">Fill in or remove the unfinished rule.</span>}
                {dirty && !unfinished && <span className="muted">Unsaved changes</span>}
                {!dirty && notice && <span className="ok" role="status">{notice}</span>}
              </div>
            </div>
          </fieldset>
        </section>
      )}

      {tab === "rollout" && overview.data && (
        <div className="narrow tabbody">
          <RolloutPanel flagId={flagId!} env={env} current={saved} rollout={overview.data.rollout} editable={editable} run={run} onChanged={refresh} />
        </div>
      )}

      {tab === "history" && (
        <section className="panel pad narrow">
          <ol className="timeline">
            {history.map((entry) => (
              <li key={entry.id} className={entry.after ? (entry.after.enabled ? "on" : "off") : undefined}>
                {describe(entry)}
                <div className="muted small">
                  {entry.actor ?? (entry.action.startsWith("rollout.") ? "Switchly" : "Deleted user")},{" "}
                  {new Date(entry.createdAt).toLocaleString()}
                </div>
                {editable && entry.before && (
                  <button
                    className="ghost small"
                    title="Restore the settings from just before this change"
                    onClick={() => run(() => api("POST", `/audit/${entry.id}/revert`)).then(refresh)}
                  >
                    Undo this change
                  </button>
                )}
              </li>
            ))}
          </ol>
          {editable && <button className="danger small" onClick={remove}>Delete flag</button>}
        </section>
      )}
    </>
  );
}
