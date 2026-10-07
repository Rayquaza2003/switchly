import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { api, useLoad } from "./api";
import { FlagDetail } from "./pages/FlagDetail";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { ProjectPage } from "./pages/Project";
import "./styles.css";

function App() {
  const me = useLoad(() => api<{ email: string }>("GET", "/auth/me"), []);
  if (!me.data && !me.error) return null;
  if (!me.data) return <Login onSignedIn={me.reload} />;

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          Switchly
        </Link>
        <nav aria-label="Main">
          <Link to="/">Projects</Link>
        </nav>
        <span className="muted small">{me.data.email}</span>
        <button className="ghost small" onClick={() => api("POST", "/auth/logout").then(me.reload)}>
          Sign out
        </button>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/projects/:projectId" element={<ProjectPage />} />
          <Route path="/flags/:flagId" element={<FlagDetail />} />
          <Route path="*" element={<p>Nothing here. <Link to="/">Back to projects</Link></p>} />
        </Routes>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
