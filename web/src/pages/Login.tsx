import { useState, type FormEvent } from "react";
import { api, useAction, type FlagConfig } from "../api";
import { Meter, summary } from "./Project";

/** A working flag to play with before signing in. Nothing here is sent anywhere. */
function Demo() {
  const [config, setConfig] = useState<FlagConfig>({ enabled: true, rolloutPercentage: 35, targetedUsers: [], rules: [] });
  return (
    <div className="panel demo">
      <code>new-checkout</code>
      <label className="power">
        <input
          type="checkbox"
          role="switch"
          checked={config.enabled}
          onChange={() => setConfig({ ...config, enabled: !config.enabled })}
        />
        <strong>{summary(config)}</strong>
      </label>
      <label>
        Share of users: {config.rolloutPercentage}%
        <input
          type="range"
          min={0}
          max={100}
          value={config.rolloutPercentage}
          onChange={(e) => setConfig({ ...config, rolloutPercentage: Number(e.target.value) })}
        />
      </label>
      <Meter config={config} large />
      <p className="muted small">
        Try it: drag to widen the rollout, flip the switch to pull the feature from everyone at once.
      </p>
    </div>
  );
}

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [signingUp, setSigningUp] = useState(false);
  const [error, run] = useAction();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    if (await run(() => api("POST", signingUp ? "/auth/signup" : "/auth/login", body))) onSignedIn();
  }

  return (
    <main className="login">
      <div>
        <span className="brand">Switchly</span>
        <h1>Ship it switched off. Turn it on when you are ready.</h1>
        <p className="muted">
          Give a feature to the users you pick, widen it by percentage, and switch it off in one click. No release
          needed.
        </p>
        <form onSubmit={submit} className="stack">
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required autoFocus />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={signingUp ? "new-password" : "current-password"}
              minLength={8}
              required
            />
            {signingUp && <small className="muted">At least 8 characters.</small>}
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit">{signingUp ? "Create account" : "Sign in"}</button>
        </form>
        <button className="link small" onClick={() => setSigningUp(!signingUp)}>
          {signingUp ? "I already have an account" : "Create an account instead"}
        </button>
      </div>
      <Demo />
    </main>
  );
}
