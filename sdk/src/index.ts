export interface SwitchlyOptions {
  /** Environment SDK key from the dashboard. */
  sdkKey: string;
  /** Stable id of the current user. Targeting and percentage rollout are decided per user id. */
  userId: string;
  /** Where the Switchly server runs, for example "https://flags.example.com". */
  baseUrl: string;
  /** Facts about the user that targeting rules can use, for example { country: "IN", plan: "pro" }. */
  attributes?: Record<string, string | number | boolean>;
  /** Keep a connection open so changes arrive within a second. Falls back to polling when it drops. */
  streaming?: boolean;
  /** How often to re-fetch flags while no stream is connected. */
  pollIntervalMs?: number;
  /** How often usage counts are sent. */
  flushIntervalMs?: number;
}

export type Flags = Record<string, boolean>;
type Counts = { on: number; off: number; ok: number; failed: number };

export function createClient(options: SwitchlyOptions) {
  const { sdkKey, userId, baseUrl, streaming = true, pollIntervalMs = 10_000, flushIntervalMs = 10_000 } = options;
  const headers = { Authorization: sdkKey };
  const query = new URLSearchParams({ userId });
  if (options.attributes) query.set("attributes", JSON.stringify(options.attributes));

  let flags: Flags = {};
  let counts: Record<string, Counts> = {};
  let connected = false;
  let closed = false;
  const abort = new AbortController();
  const listeners = new Set<(flags: Flags) => void>();
  const count = (key: string) => (counts[key] ??= { on: 0, off: 0, ok: 0, failed: 0 });

  function apply(next: Flags) {
    const changed = JSON.stringify(next) !== JSON.stringify(flags);
    flags = next;
    if (changed) listeners.forEach((listener) => listener(flags));
  }

  async function poll() {
    try {
      const res = await fetch(`${baseUrl}/sdk/flags?${query}`, { headers, signal: abort.signal });
      if (!res.ok) throw new Error(`Switchly: flag fetch failed with HTTP ${res.status}`);
      apply((await res.json()).flags);
    } catch (err) {
      // Keep the last known values: a Switchly outage must not flip features in the host app.
      if (!closed) console.warn(err);
    }
  }

  /** Reads server-sent events until the connection ends. Each event carries the full flag map. */
  async function readStream() {
    const res = await fetch(`${baseUrl}/sdk/stream?${query}`, { headers, signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`Switchly: stream failed with HTTP ${res.status}`);
    connected = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop()!;
      for (const event of events) {
        if (event.startsWith("data: ")) apply(JSON.parse(event.slice(6)).flags);
      }
    }
  }

  async function streamForever() {
    for (let delay = 1000; !closed; delay = Math.min(delay * 2, 30_000)) {
      try {
        await readStream();
        delay = 500;
      } catch {
        // Polling covers the gap until the next attempt.
      }
      connected = false;
      if (!closed) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async function flush() {
    if (!Object.keys(counts).length) return;
    const events = counts;
    counts = {};
    try {
      await fetch(`${baseUrl}/sdk/events`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        keepalive: true,
      });
    } catch {
      // Usage counts are best effort; a failed report is dropped.
    }
  }

  const first = poll();
  if (streaming) void first.then(streamForever);
  const timers = [setInterval(() => !connected && poll(), pollIntervalMs), setInterval(flush, flushIntervalMs)];
  // In Node, do not keep the process alive just for background work.
  for (const timer of timers) (timer as { unref?: () => void }).unref?.();

  return {
    /** Resolves after the first fetch attempt, successful or not. */
    ready: () => first,
    /** `fallback` is returned for flags not known yet: before the first fetch, or never created. */
    isEnabled(key: string, fallback = false) {
      const value = flags[key] ?? fallback;
      count(key)[value ? "on" : "off"]++;
      return value;
    },
    /**
     * Tell Switchly how the feature behaved for this user: `true` when it worked, `false` when it failed.
     * A rollout with an error limit switches the flag off when too many failures arrive.
     */
    report(key: string, ok: boolean) {
      count(key)[ok ? "ok" : "failed"]++;
    },
    /** Calls `listener` whenever any flag value changes. Returns an unsubscribe function. */
    onChange(listener: (flags: Flags) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Sends pending usage counts and stops all background work. */
    async close() {
      closed = true;
      timers.forEach(clearInterval);
      await flush();
      abort.abort();
    },
  };
}
