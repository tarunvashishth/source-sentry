import { createMiddleware } from "hono/factory";
import { sha256Hex } from "./lib/ids";
import type { AppEnv, UserRow } from "./types";

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : c.req.header("x-api-key");
  if (!key) {
    return c.json({ error: "missing API key — pass Authorization: Bearer <key>" }, 401);
  }
  const keyHash = await sha256Hex(key);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE api_key_hash = ?")
    .bind(keyHash)
    .first<UserRow>();
  if (!user) {
    return c.json({ error: "invalid API key" }, 401);
  }
  c.set("user", user);
  await next();
});
