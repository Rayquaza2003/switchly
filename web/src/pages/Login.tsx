import { useState, type FormEvent } from "react";
import { api, useAction } from "../api";

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
      <h1 className="brand">Switchly</h1>
      <p className="lede">
        Give a feature to the users you pick, widen it by percentage, and switch it off in one click. No release needed.
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
      <button className="quiet" onClick={() => setSigningUp(!signingUp)}>
        {signingUp ? "I already have an account" : "Create an account instead"}
      </button>
    </main>
  );
}
