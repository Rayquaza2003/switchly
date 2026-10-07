import { app } from "./app";
import { migrate } from "./db";

const port = Number(process.env.PORT ?? 3000);

await migrate();
app.listen(port, () => console.log(`Switchly API on http://localhost:${port}`));
