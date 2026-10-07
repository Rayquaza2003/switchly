import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, useAction, useLoad, type Environment, type Role } from "../api";

interface Org {
  id: string;
  name: string;
  role: Role;
}

/** Shown once, right after keys are created or rotated. The server cannot show them again. */
export function NewKeys({ environments }: { environments: Environment[] }) {
  if (!environments.length) return null;
  return (
    <div className="notice" role="status">
      <strong>Copy these SDK keys now. They are not shown again.</strong>
      <dl className="keys">
        {environments.map((env) => (
          <div key={env.id}>
            <dt>{env.name}</dt>
            <dd><code>{env.sdkKey}</code></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function NameForm({ label, action, onSubmit }: { label: string; action: string; onSubmit: (name: string) => Promise<unknown> }) {
  const [error, run] = useAction();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (await run(() => onSubmit(new FormData(form).get("name") as string))) form.reset();
  }
  return (
    <form onSubmit={submit} className="inline">
      <label>
        {label}
        <input name="name" required maxLength={100} />
      </label>
      <button type="submit">{action}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

function Members({ org }: { org: Org }) {
  const members = useLoad(() => api<{ id: string; email: string; role: Role }[]>("GET", `/orgs/${org.id}/members`), [org.id]);
  const [error, run] = useAction();
  const owner = org.role === "owner";
  const setRole = (email: string, role: string) =>
    run(() => api("POST", `/orgs/${org.id}/members`, { email, role })).then(members.reload);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    if (await run(() => api("POST", `/orgs/${org.id}/members`, body))) form.reset();
    members.reload();
  }

  return (
    <section>
      <h2>Members</h2>
      <ul className="rows">
        {members.data?.map((m) => (
          <li key={m.id}>
            <span className="grow">{m.email}</span>
            {owner ? (
              <>
                <select aria-label={`Role for ${m.email}`} value={m.role} onChange={(e) => setRole(m.email, e.target.value)}>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                </select>
                <button
                  className="quiet"
                  onClick={() => run(() => api("DELETE", `/orgs/${org.id}/members/${m.id}`)).then(members.reload)}
                >
                  Remove
                </button>
              </>
            ) : (
              <span className="muted">{m.role}</span>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error" role="alert">{error}</p>}
      {owner && (
        <form onSubmit={add} className="inline">
          <label>
            Add a member by email
            <input name="email" type="email" required />
          </label>
          <label>
            Role
            <select name="role" defaultValue="editor">
              <option value="viewer">Viewer: can look</option>
              <option value="editor">Editor: can change flags</option>
              <option value="owner">Owner: can manage everything</option>
            </select>
          </label>
          <button type="submit">Add member</button>
        </form>
      )}
    </section>
  );
}

function OrgView({ org }: { org: Org }) {
  const projects = useLoad(() => api<{ id: string; name: string }[]>("GET", `/orgs/${org.id}/projects`), [org.id]);
  const [newKeys, setNewKeys] = useState<Environment[]>([]);

  async function createProject(name: string) {
    const project = await api("POST", `/orgs/${org.id}/projects`, { name });
    setNewKeys(project.environments);
    await projects.reload();
  }

  return (
    <>
      <section>
        <h2>Projects</h2>
        {projects.data?.length === 0 && (
          <p className="muted">No projects yet. A project holds the flags for one app or service.</p>
        )}
        <ul className="rows">
          {projects.data?.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="grow">{p.name}</Link>
            </li>
          ))}
        </ul>
        <NewKeys environments={newKeys} />
        {org.role === "owner" && <NameForm label="New project name" action="Create project" onSubmit={createProject} />}
      </section>
      <Members org={org} />
    </>
  );
}

export function Home() {
  const orgs = useLoad(() => api<Org[]>("GET", "/orgs"), []);
  const [orgId, setOrgId] = useState(() => localStorage.getItem("org") ?? "");
  const org = orgs.data?.find((o) => o.id === orgId) ?? orgs.data?.[0];

  function choose(id: string) {
    localStorage.setItem("org", id);
    setOrgId(id);
  }
  const createOrg = async (name: string) => {
    choose((await api("POST", "/orgs", { name })).id);
    await orgs.reload();
  };

  if (orgs.error) return <p className="error" role="alert">{orgs.error}</p>;
  if (!orgs.data) return null;
  if (!org) {
    return (
      <section>
        <h1>Create your organization</h1>
        <p className="muted">Projects, flags and teammates live inside an organization.</p>
        <NameForm label="Organization name" action="Create organization" onSubmit={createOrg} />
      </section>
    );
  }

  return (
    <>
      <div className="pagehead">
        <h1>{org.name}</h1>
        {orgs.data.length > 1 && (
          <select aria-label="Switch organization" value={org.id} onChange={(e) => choose(e.target.value)}>
            {orgs.data.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        )}
      </div>
      <OrgView org={org} key={org.id} />
      <details>
        <summary>Create another organization</summary>
        <NameForm label="Organization name" action="Create organization" onSubmit={createOrg} />
      </details>
    </>
  );
}
