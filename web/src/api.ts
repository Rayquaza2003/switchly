import { useCallback, useEffect, useState } from "react";

export type Role = "viewer" | "editor" | "owner";
export interface FlagConfig {
  enabled: boolean;
  rolloutPercentage: number;
  targetedUsers: string[];
}
export interface Flag {
  id: string;
  key: string;
  description: string;
  projectId: string;
  configs: Record<string, FlagConfig>;
}
export interface Environment {
  id: string;
  name: string;
  sdkKeyPrefix: string;
  sdkKey?: string;
}
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
