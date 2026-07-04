import { Hono } from "hono";
import { cors } from "hono/cors";
import { runDueChecks } from "./lib/check";
import { dashboardPage } from "./pages/dashboard";
import { landingPage } from "./pages/landing";
import api from "./routes/api";
import dev from "./routes/dev";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

app.use("/api/*", cors());
app.get("/", (c) => c.html(landingPage));
app.get("/app", (c) => c.html(dashboardPage));
app.route("/api", api);
app.route("/dev", dev);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.log(
    JSON.stringify({ event: "unhandled_error", path: c.req.path, error: String(err) }),
  );
  return c.json({ error: "internal error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runDueChecks(env));
  },
} satisfies ExportedHandler<Env>;
