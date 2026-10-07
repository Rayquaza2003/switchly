import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { hashPassword, requireUser, sha256, startSession, verifyPassword } from "../auth";
import { HttpError, q } from "../db";

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200),
});

// Verified against when the email is unknown, so login timing does not reveal which emails exist.
const dummyHash = await hashPassword("dummy");

const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, message: { error: "Too many attempts, try again later" } });

export const auth = Router();

auth.post("/signup", limiter, async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  const [user] = await q("insert into users (email, password_hash) values ($1, $2) returning id, email", [
    email,
    await hashPassword(password),
  ]);
  await startSession(res, user.id);
  res.status(201).json(user);
});

auth.post("/login", limiter, async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  const [user] = await q("select id, email, password_hash from users where email = $1", [email]);
  const ok = await verifyPassword(password, user?.password_hash ?? dummyHash);
  if (!user || !ok) throw new HttpError(401, "Wrong email or password");
  await startSession(res, user.id);
  res.json({ id: user.id, email: user.email });
});

auth.post("/logout", async (req, res) => {
  if (req.cookies?.sid) await q("delete from sessions where token_hash = $1", [sha256(req.cookies.sid)]);
  res.clearCookie("sid").json({});
});

auth.get("/me", requireUser, (_req, res) => {
  res.json(res.locals.user);
});
