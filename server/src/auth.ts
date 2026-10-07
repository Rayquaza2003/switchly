import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { RequestHandler, Response } from "express";
import { HttpError, q } from "./db";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const SESSION_DAYS = 30;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [salt, key] = stored.split(":");
  const actual = await scryptAsync(password, Buffer.from(salt, "hex"), 64);
  return timingSafeEqual(actual, Buffer.from(key, "hex"));
}

/** The cookie carries the raw token; the database only ever sees its hash. */
export async function startSession(res: Response, userId: string) {
  const token = randomBytes(32).toString("hex");
  await q(`insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + $3 * interval '1 day')`, [
    sha256(token),
    userId,
    SESSION_DAYS,
  ]);
  res.cookie("sid", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

export const requireUser: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.sid;
  const [user] = token
    ? await q(
        `select u.id, u.email from sessions s join users u on u.id = s.user_id
         where s.token_hash = $1 and s.expires_at > now()`,
        [sha256(token)],
      )
    : [];
  if (!user) throw new HttpError(401, "Not signed in");
  res.locals.user = user;
  next();
};
