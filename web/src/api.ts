import { useCallback, useEffect, useState } from "react";

export type Role = "viewer" | "editor" | "owner";
export type Op = "is" | "is_not" | "contains" | "starts_with" | "ends_with" | "gte" | "lte" | "in_segment" | "not_in_segment";
export interface Condition {
  attribute: string;
  op: Op;
  values: string[];
}
export interface Rule {
  conditions: Condition[];
  percentage: number;
}
export interface FlagConfig {
  enabled: boolean;
  rolloutPercentage: number;
  targetedUsers: string[];
  rules: Rule[];
}
export interface Flag {
  id: string;
  key: string;
  description: string;
  projectId: string;
  createdAt: string;
  lastCheckedAt: string | null;
  configs: Record<string, FlagConfig>;
}
export interface Environment {
  id: string;
  name: string;
  sdkKeyPrefix: string;
  sdkKey?: string;
  requiresApproval: boolean;
  frozen: boolean;
}
export interface Segment {
  id: string;
  name: string;
  conditions: Condition[];
}
export interface RolloutPlan {
  steps: { percentage: number; waitMinutes: number }[];
  maxErrorRate: number | null;
  minSamples: number;
}
export interface Rollout extends RolloutPlan {
  id: string;
  currentStep: number;
  nextStepAt: string;
  status: "running" | "completed" | "cancelled" | "rolled_back";
  finishedAt: string | null;
}
export interface Change {
  id: string;
  flagId: string;
  flagKey: string;
  environmentId: string;
  environment: string;
  config: FlagConfig | null;
  rollout: RolloutPlan | null;
  note: string;
  scheduledAt: string | null;
  status: "pending_approval" | "scheduled";
  requestedBy: string | null;
  mine: boolean;
}
export interface Overview {
  rollout: Rollout | null;
  changes: Change[];
  stats: { on: number; off: number; ok: number; failed: number };
}

/**
 * Drops half-typed blanks and fixes key order, so a rule list can be sent to the server and
 * compared with the saved one. (Postgres returns JSON keys in its own order.)
 */
export const cleanConditions = (conditions: Condition[]): Condition[] =>
  conditions.map((c) => ({
    attribute: c.op.endsWith("segment") ? "" : c.attribute.trim(),
    op: c.op,
    values: c.values.map((v) => v.trim()).filter(Boolean),
  }));
export const cleanRules = (rules: Rule[]): Rule[] =>
  rules.map((r) => ({ conditions: cleanConditions(r.conditions), percentage: r.percentage }));
export const incomplete = (conditions: Condition[]) =>
  !conditions.length || cleanConditions(conditions).some((c) => !c.values.length || (!c.attribute && !c.op.endsWith("segment")));
export interface Project {
  id: string;
  name: string;
  orgId: string;
  role: Role;
  environments: Environment[];
}

export const canEdit = (role?: Role) => role === "editor" || role === "owner";

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Loads on mount and whenever `deps` change; `reload` re-fetches after a mutation. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(
    () => load().then((data) => setState({ data }), (err) => setState({ error: err.message })),
    deps,
  );
  useEffect(() => void reload(), [reload]);
  return { ...state, reload };
}

/** Wraps a mutation so its failure message can be shown next to the control that caused it. */
export function useAction() {
  const [error, setError] = useState("");
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };
  return [error, run] as const;
}
