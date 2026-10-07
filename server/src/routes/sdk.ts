import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { sha256 } from "../auth";
import { HttpError, q } from "../db";
import { configCols, evaluate } from "../evaluate";

export const sdk = Router();

// Called from customer apps on any origin. Auth is the SDK key, never cookies, so open CORS is safe.
sdk.use((req, res, next) => {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization" });
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

sdk.use(rateLimit({ windowMs: 60_000, limit: 600, message: { error: "Rate limit exceeded" } }));

// ponytail: evaluates from the database on every poll, no cache. That is what makes rollback
// land on the next poll. Add a short per-environment cache or ETag when this query shows up in load.
sdk.get("/flags", async (req, res) => {
  const sdkKey = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const userId = z.string().min(1).max(200).parse(req.query.userId);
  const [env] = await q("select id from environments where sdk_key_hash = $1", [sha256(sdkKey)]);
  if (!env) throw new HttpError(401, "Invalid SDK key");
  const rows = await q(
    `select f.key, ${configCols}
     from environments e
     join flags f on f.project_id = e.project_id
     left join flag_configs c on c.flag_id = f.id and c.environment_id = e.id
     where e.id = $1 order by f.key`,
    [env.id],
  );
  res.json({ flags: Object.fromEntries(rows.map((row) => [row.key, evaluate(row.key, row, userId)])) });
});
