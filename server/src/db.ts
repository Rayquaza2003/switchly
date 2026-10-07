import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://localhost/switchly",
});

export const q = <T extends pg.QueryResultRow = any>(text: string, params?: unknown[]) =>
  pool.query<T>(text, params).then((r) => r.rows);

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Applies migrations/*.sql in filename order, each once, each in its own transaction. */
export async function migrate() {
  await pool.query("create table if not exists migrations (name text primary key)");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(dir)).sort()) {
    const sql = await readFile(new URL(name, dir), "utf8");
    await tx(async (c) => {
      const done = await c.query("select 1 from migrations where name = $1", [name]);
      if (done.rowCount) return;
      await c.query(sql);
      await c.query("insert into migrations (name) values ($1)", [name]);
    });
  }
}
