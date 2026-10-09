import { app } from "./app";
import { migrate, pool } from "./db";
import { tick } from "./releases";

const port = Number(process.env.PORT ?? 3000);

await migrate();
// A deploy runs inside this process, so one still marked in flight at startup died with the last process.
await pool.query("update deployments set status = 'failed', log = log || 'Server restarted during this deploy.', finished_at = now() where status = 'progressing'");
setInterval(() => tick().catch(console.error), 5_000);
// Usage counts are kept per minute; a month is enough for stale-flag detection.
setInterval(() => pool.query("delete from flag_stats where minute < now() - interval '30 days'").catch(console.error), 3_600_000);
app.listen(port, () => console.log(`Switchly API on http://localhost:${port}`));
