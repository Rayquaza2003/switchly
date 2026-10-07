export interface SwitchlyOptions {
  /** Environment SDK key from the dashboard. */
  sdkKey: string;
  /** Stable id of the current user. Targeting and percentage rollout are decided per user id. */
  userId: string;
  /** Where the Switchly server runs, for example "https://flags.example.com". */
  baseUrl: string;
  /** How often to re-fetch flags. This is the longest a rollback takes to reach this client. */
  pollIntervalMs?: number;
}

export type Flags = Record<string, boolean>;

export function createClient({ sdkKey, userId, baseUrl, pollIntervalMs = 10_000 }: SwitchlyOptions) {
  let flags: Flags = {};
  const listeners = new Set<(flags: Flags) => void>();

  async function poll() {
    try {
      const res = await fetch(`${baseUrl}/sdk/flags?userId=${encodeURIComponent(userId)}`, {
        headers: { Authorization: sdkKey },
      });
      if (!res.ok) throw new Error(`Switchly: flag fetch failed with HTTP ${res.status}`);
      const next: Flags = (await res.json()).flags;
      const changed = JSON.stringify(next) !== JSON.stringify(flags);
      flags = next;
      if (changed) listeners.forEach((listener) => listener(flags));
    } catch (err) {
      // Keep the last known values: a Switchly outage must not flip features in the host app.
      console.warn(err);
    }
  }

  const first = poll();
  const timer = setInterval(poll, pollIntervalMs);
  // In Node, do not keep the process alive just for polling.
  (timer as { unref?: () => void }).unref?.();

  return {
    /** Resolves after the first fetch attempt, successful or not. */
    ready: () => first,
    /** `fallback` is returned for flags not known yet: before the first fetch, or never created. */
    isEnabled: (key: string, fallback = false) => flags[key] ?? fallback,
    /** Calls `listener` whenever any flag value changes. Returns an unsubscribe function. */
    onChange(listener: (flags: Flags) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close: () => clearInterval(timer),
  };
}
