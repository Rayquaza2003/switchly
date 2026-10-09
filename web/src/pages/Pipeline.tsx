import { useEffect, useState } from "react";
import { api, useAction } from "../api";
import { isProduction } from "./Project";

interface Deployment {
  id: string;
  branch: string;
  commitSha: string;
  commitSubject: string;
  status: "progressing" | "succeeded" | "failed";
  createdAt: string;
  triggeredBy: string | null;
}
interface Instance {
  environmentId: string;
  name: string;
  frozen: boolean;
  url: string;
  /** Latest deploy attempt. */
  current: Deployment | null;
  /** What is actually running: the latest attempt that succeeded. */
  live: Deployment | null;
  rollbackTo: Deployment | null;
  history: Deployment[];
}
export interface PipelineData {
  enabled: boolean;
  repo: string;
  branches: { name: string; sha: string; subject: string }[];
  instances: Instance[];
}

const STATUS = { progressing: "Progressing", succeeded: "Succeeded", failed: "Failed" };
const short = (sha: string) => sha.slice(0, 7);
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** Source branches on the left, one deploy card per instance on the right. */
export function Pipeline({ data, reload, editable }: { data: PipelineData; reload: () => unknown; editable: boolean }) {
  const [error, run] = useAction();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [log, setLog] = useState<{ id: string; text: string } | null>(null);

  // A deploy runs on the server; follow it until it settles.
  const busy = data.instances.some((i) => i.current?.status === "progressing");
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(reload, 1500);
    return () => clearInterval(timer);
  }, [busy, reload]);
  // Keep an open log in step with the deploy it belongs to.
  useEffect(() => {
    if (log) api("GET", `/deployments/${log.id}`).then((d) => setLog({ id: d.id, text: d.log }));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const deploy = (instance: Instance, body: { branch: string } | { deploymentId: string }, what: string) => {
    if (isProduction(instance.name) && !confirm(`Deploy ${what} to ${instance.name}?`)) return;
    run(() => api("POST", `/environments/${instance.environmentId}/deploy`, body)).then(reload);
  };
  const toggleLog = (d: Deployment) =>
    log?.id === d.id ? setLog(null) : api("GET", `/deployments/${d.id}`).then((full) => setLog({ id: d.id, text: full.log }));

  return (
    <section>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="pipeline">
        <div className="panel pad source">
          <div className="muted small">Source repository</div>
          <strong>{data.repo}</strong>
          <ul>
            {data.branches.map((b) => (
              <li key={b.name}>
                <code>{b.name}</code>
                <div className="muted small">{short(b.sha)} {b.subject}</div>
              </li>
            ))}
          </ul>
        </div>

        <div className="stages">
          {data.instances.map((instance) => {
            const { current, live, rollbackTo } = instance;
            const branch = picked[instance.environmentId] ?? live?.branch ?? data.branches[0]?.name ?? "";
            const running = current?.status === "progressing";
            return (
              <article key={instance.environmentId} className="panel stage">
                <div className="strip" aria-hidden="true">Manual</div>
                <div className="body">
                  <div className="inline">
                    <div className="grow">
                      <div className="muted small">Deploy to</div>
                      <strong className={isProduction(instance.name) ? "prodname" : undefined}>{instance.name}</strong>
                    </div>
                    <a href={instance.url} target="_blank" rel="noreferrer" className="small">{instance.url.replace("http://", "")}</a>
                  </div>

                  {current ? (
                    <div className={`status ${current.status}`}>
                      <span className="dot" />
                      {STATUS[current.status]}
                      <button className="link small" onClick={() => toggleLog(current)}>
                        {log?.id === current.id ? "Hide details" : "Details"}
                      </button>
                    </div>
                  ) : (
                    <div className="status muted">Nothing deployed from here yet</div>
                  )}

                  {live && (
                    <div className="small">
                      Running <code>{live.branch}</code> at {short(live.commitSha)}
                      <div className="muted">{live.commitSubject}</div>
                    </div>
                  )}

                  {log && log.id === current?.id && <pre className="log">{log.text || "Starting…"}</pre>}

                  {editable && (
                    <div className="inline">
                      <select
                        aria-label={`Branch for ${instance.name}`}
                        className="grow"
                        value={branch}
                        onChange={(e) => setPicked({ ...picked, [instance.environmentId]: e.target.value })}
                      >
                        {data.branches.map((b) => (
                          <option key={b.name} value={b.name}>{b.name}</option>
                        ))}
                      </select>
                      <button disabled={running || instance.frozen || !branch} onClick={() => deploy(instance, { branch }, branch)}>
                        {running ? "Deploying…" : "Deploy"}
                      </button>
                    </div>
                  )}
                  {instance.frozen && <div className="stale small">{instance.name} is frozen: no deploys until it is unfrozen.</div>}

                  {editable && rollbackTo && (
                    <div>
                      <button
                        className="ghost small"
                        disabled={running || instance.frozen}
                        onClick={() => deploy(instance, { deploymentId: rollbackTo.id }, `${rollbackTo.branch} at ${short(rollbackTo.commitSha)}`)}
                      >
                        Roll back to {rollbackTo.branch} at {short(rollbackTo.commitSha)}
                      </button>
                    </div>
                  )}

                  {instance.history.length > 1 && (
                    <details>
                      <summary className="muted small">Earlier deploys</summary>
                      <ul className="history">
                        {instance.history.slice(1).map((d) => (
                          <li key={d.id} className="small">
                            <span className={`status ${d.status}`}><span className="dot" />{STATUS[d.status]}</span>{" "}
                            <code>{d.branch}</code> at {short(d.commitSha)}
                            <div className="muted">{when(d.createdAt)}{d.triggeredBy ? `, ${d.triggeredBy}` : ""}</div>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
