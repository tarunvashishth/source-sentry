import { applyD1Migrations, env } from "cloudflare:test";

// Setup files run outside per-test-file storage isolation and may run more than
// once; applyD1Migrations() only applies migrations not already recorded, so this
// is safe to call here.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
