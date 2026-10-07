import type { FormEvent } from "react";
import {
  api, type Change, type Condition, type Environment, type FlagConfig, type Op, type Overview, type RolloutPlan, type Rule, type Segment,
} from "../api";
import { Meter, summary } from "./Project";

type Run = (action: () => Promise<unknown>) => Promise<boolean>;

const OPS: [Op, string][] = [
  ["is", "is"],
  ["is_not", "is not"],
  ["contains", "contains"],
  ["starts_with", "starts with"],
  ["ends_with", "ends with"],
  ["gte", "is at least"],
  ["lte", "is at most"],
  ["in_segment", "is in segment"],
  ["not_in_segment", "is not in segment"],
];
const isSegmentOp = (op: Op) => op === "in_segment" || op === "not_in_segment";
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export function describeConditions(conditions: Condition[], segments: Segment[] = []) {
  return conditions
    .map((c) => {
      const label = OPS.find(([op]) => op === c.op)![1];
      if (!isSegmentOp(c.op)) return `${c.attribute} ${label} ${c.values.join(" or ")}`;
      const names = c.values.map((id) => segments.find((s) => s.id === id)?.name ?? "a deleted segment");
      return `user ${label} ${names.join(" or ")}`;
    })
    .join(", and ");
}

/** One row per condition; all must match. Pass `segments` to allow the segment operators. */
export function ConditionsEditor({ conditions, onChange, segments, lead = "If" }: {
  conditions: Condition[];
  onChange: (conditions: Condition[]) => void;
  segments?: Segment[];
  /** Word in front of the first condition; later ones read "and". */
  lead?: string;
}) {
  const set = (i: number, patch: Partial<Condition>) => onChange(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const ops = segments?.length ? OPS : OPS.filter(([op]) => !isSegmentOp(op));
  return (
    <div className="stack tight">
      {conditions.map((c, i) => (
        <div className="cond" key={i}>
          <span className="lead">{i === 0 ? lead : "and"}</span>
          {isSegmentOp(c.op) ? (
            <span className="muted small">the user</span>
          ) : (
            <input
              aria-label="Attribute"
              placeholder="country"
              className="mono"
              value={c.attribute}
              onChange={(e) => set(i, { attribute: e.target.value })}
            />
          )}
          <select
            aria-label="Comparison"
            value={c.op}
            onChange={(e) => {
              const op = e.target.value as Op;
              // Values mean different things on each side of this switch, so start them over.
              set(i, isSegmentOp(op) === isSegmentOp(c.op) ? { op } : { op, values: isSegmentOp(op) ? [segments![0].id] : [] });
            }}
          >
            {ops.map(([op, label]) => (
              <option key={op} value={op}>{label}</option>
            ))}
          </select>
          {isSegmentOp(c.op) ? (
            <select aria-label="Segment" value={c.values[0] ?? ""} onChange={(e) => set(i, { values: [e.target.value] })}>
              {!segments?.some((s) => s.id === c.values[0]) && <option value={c.values[0] ?? ""}>Deleted segment</option>}
              {segments?.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          ) : (
            <input
              aria-label="Values, separated by commas"
              placeholder="IN, NP"
              className="mono"
              value={c.values.join(",")}
              onChange={(e) => set(i, { values: e.target.value.split(",") })}
            />
          )}
          <button type="button" className="ghost small" aria-label="Remove condition" onClick={() => onChange(conditions.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="link small" onClick={() => onChange([...conditions, { attribute: "", op: "is", values: [] }])}>
          Add a condition
        </button>
      </div>
    </div>
  );
}

export function RulesEditor({ rules, onChange, segments }: { rules: Rule[]; onChange: (rules: Rule[]) => void; segments: Segment[] }) {
  const set = (i: number, patch: Partial<Rule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack tight">
      <div>
        <strong className="small">Rules</strong>
        <div className="muted small">
          Checked top to bottom for users not selected above. The first rule a user matches decides; everyone else
          gets the share below. Attributes come from your app through the SDK.
        </div>
      </div>
      {rules.map((rule, i) => (
        <div className="rule" key={i}>
          <div className="inline">
            <strong className="grow">Rule {i + 1}</strong>
            <button type="button" className="ghost small" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
              Remove rule
            </button>
          </div>
          <ConditionsEditor conditions={rule.conditions} onChange={(conditions) => set(i, { conditions })} segments={segments} />
          <div className="inline">
            <label className="check">
              Then on for
              <input
                type="number"
                className="num"
                min={0}
                max={100}
                value={rule.percentage}
                onChange={(e) => set(i, { percentage: Math.min(100, Math.max(0, Math.round(Number(e.target.value)))) })}
              />
              % of matching users
            </label>
          </div>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="ghost small"
          onClick={() => onChange([...rules, { conditions: [{ attribute: "", op: "is", values: [] }], percentage: 100 }])}
        >
          Add a rule
        </button>
      </div>
    </div>
  );
}

const planText = (plan: RolloutPlan) => `Rollout in steps: ${plan.steps.map((s) => `${s.percentage}%`).join(", ")}`;

/** Changes waiting for a second person or for their scheduled time. */
export function ChangesList({ changes, editable, showFlag, run, onChanged }: {
  changes: Change[];
  editable: boolean;
  showFlag?: boolean;
  run: Run;
  onChanged: () => unknown;
}) {
  const act = (change: Change, verb: "approve" | "reject") => run(() => api("POST", `/changes/${change.id}/${verb}`)).then(onChanged);
  return (
    <ul className="rows">
      {changes.map((change) => (
        <li key={change.id}>
          <div className="grow">
            {showFlag && <><code>{change.flagKey}</code> in {change.environment}: </>}
            {change.rollout ? planText(change.rollout) : summary(change.config!)}
            <div className="muted small">
              {change.status === "pending_approval" ? "Waiting for approval" : "Approved"}
              {change.scheduledAt && `, set for ${when(change.scheduledAt)}`}
              {change.requestedBy && `. Requested by ${change.requestedBy}`}
              {change.note && `. "${change.note}"`}
            </div>
          </div>
          {editable && (
            <>
              {change.status === "pending_approval" && !change.mine && (
                <button className="small" onClick={() => act(change, "approve")}>Approve</button>
              )}
              <button className="ghost small" onClick={() => act(change, "reject")}>
                {change.mine ? "Withdraw" : change.status === "scheduled" ? "Cancel" : "Reject"}
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function RolloutPanel({ flagId, env, current, rollout, editable, run, onChanged }: {
  flagId: string;
  env: Environment;
  /** The flag's live settings here, for the progress meter. */
  current: FlagConfig;
  rollout: Overview["rollout"];
  editable: boolean;
  run: Run;
  onChanged: () => unknown;
}) {
  const path = `/flags/${flagId}/environments/${env.id}`;

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const waitMinutes = Number(form.get("minutes"));
    const limit = form.get("maxErrorRate") as string;
    const plan: RolloutPlan = {
      steps: (form.get("steps") as string).split(/[\s,]+/).filter(Boolean).map((p) => ({ percentage: Number(p), waitMinutes })),
      maxErrorRate: limit === "" ? null : Number(limit),
      minSamples: Number(form.get("minSamples")),
    };
    await run(() => (env.requiresApproval ? api("POST", `${path}/changes`, { rollout: plan }) : api("POST", `${path}/rollout`, plan)));
    onChanged();
  }

  if (rollout?.status === "running") {
    const last = rollout.currentStep === rollout.steps.length - 1;
    return (
      <section className="panel pad stack tight">
        <h2>Rollout in progress</h2>
        <div>
          <span className="figure">{current.rolloutPercentage}%</span>
          <Meter config={current} large />
        </div>
        <ol className="steps" aria-label="Rollout steps">
          {rollout.steps.map((step, i) => (
            <li key={i} className={i === rollout.currentStep ? "now" : i < rollout.currentStep ? "done" : undefined}>
              {step.percentage}%
            </li>
          ))}
        </ol>
        <p className="small">
          Step {rollout.currentStep + 1} of {rollout.steps.length}.{" "}
          {env.frozen ? `Paused while ${env.name} is frozen.` : last ? `Finishes ${when(rollout.nextStepAt)}.` : `Next step ${when(rollout.nextStepAt)}.`}
        </p>
        {rollout.maxErrorRate !== null && (
          <p className="small muted">
            Switches off by itself when more than {rollout.maxErrorRate}% of reported runs fail (after {rollout.minSamples} reports).
          </p>
        )}
        {editable && (
          <div>
            <button className="ghost small" onClick={() => run(() => api("POST", `/rollouts/${rollout.id}/cancel`)).then(onChanged)}>
              Stop rollout
            </button>{" "}
            <span className="muted small">The flag keeps its current percentage.</span>
          </div>
        )}
      </section>
    );
  }

  if (!editable) return <p className="muted">No rollout is running.</p>;
  return (
    <section className="panel pad">
      <form onSubmit={start} className="stack">
        <h2>Roll out in steps</h2>
        {rollout?.status === "rolled_back" && (
          <p className="error small">
            The last rollout switched the flag off by itself on {when(rollout.finishedAt!)}: too many failures were reported.
          </p>
        )}
        <p className="muted small">
          Switches the flag on at the first percentage, then widens it step by step. Any manual change stops the rollout.
        </p>
        <div className="inline">
          <label className="grow">
            Percentages, smallest first
            <input name="steps" className="mono" defaultValue="5, 25, 50, 100" required pattern="[\d\s,]+" />
          </label>
          <label>
            Minutes at each step
            <input name="minutes" type="number" className="num" min={0} max={43200} step="any" defaultValue={30} required />
          </label>
        </div>
        <div className="inline">
          <label>
            Switch off if failures pass (%)
            <input name="maxErrorRate" type="number" className="num" min={0} max={100} step="any" placeholder="off" />
          </label>
          <label>
            After at least this many reports
            <input name="minSamples" type="number" className="num" min={1} defaultValue={20} required />
          </label>
        </div>
        <p className="muted small">
          The failure limit needs your app to call <code>flags.report("key", ok)</code> after running the feature.
        </p>
        <div>
          <button type="submit" className="ghost">{env.requiresApproval ? "Request approval for rollout" : "Start rollout"}</button>
        </div>
      </form>
    </section>
  );
}

export function Usage({ stats }: { stats: Overview["stats"] }) {
  const checks = stats.on + stats.off;
  const runs = stats.ok + stats.failed;
  if (!checks && !runs) {
    return <p className="muted small">No app has checked this flag here in the last 24 hours. Counts appear once an app calls <code>isEnabled</code> through the SDK.</p>;
  }
  const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : "No data");
  return (
    <dl className="stats">
      <div><dt>Checks</dt><dd>{checks.toLocaleString()}</dd></div>
      <div><dt>Answered on</dt><dd>{percent(stats.on, checks)}</dd></div>
      <div><dt>Runs that failed</dt><dd className={runs && stats.failed / runs > 0.05 ? "error" : undefined}>{percent(stats.failed, runs)}</dd></div>
    </dl>
  );
}
