import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { ZodError } from "zod";
import { requireUser } from "./auth";
import { HttpError } from "./db";
import { auth } from "./routes/auth";
import { deploy } from "./routes/deploy";
import { flags } from "./routes/flags";
import { orgs } from "./routes/orgs";
import { releases } from "./routes/releases";
import { sdk } from "./routes/sdk";

// CSRF defence for the cookie-authenticated API, on top of SameSite=Lax and JSON-only bodies:
// browsers label every request with Sec-Fetch-Site, and pages cannot forge it. Unlike comparing
// Origin to Host, this still works when a proxy (Vite in dev, nginx in production) rewrites Host.
const sameOrigin: RequestHandler = (req, _res, next) => {
  const site = req.get("sec-fetch-site");
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating && site && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "Cross-origin request blocked");
  }
  next();
};

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // A stream that fails after its first write cannot change status any more.
  if (res.headersSent) return void res.end();
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => [i.path.join("."), i.message].filter(Boolean).join(": ")).join("; ");
    return void res.status(400).json({ error: message });
  }
  // Postgres: malformed uuid in a path is just an id that does not exist; unique violation is a duplicate.
  if (err.code === "22P02") return void res.status(404).json({ error: "Not found" });
  if (err.code === "23505") return void res.status(409).json({ error: "That name is already taken" });
  if (err.status >= 400 && err.status < 500) return void res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Internal error" });
};

export const app = express();
// Set TRUST_PROXY=1 behind a reverse proxy so rate limits see the real client address.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY));
app.use("/sdk", sdk);
app.use("/api", express.json({ limit: "1mb" }), cookieParser(), sameOrigin);
app.use("/api/auth", auth);
app.use("/api", requireUser, orgs, flags, releases, deploy);
app.use(errorHandler);
