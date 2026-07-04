declare namespace Cloudflare {
  interface Env {
    // Defined in vitest.config.ts — test-only binding carrying the migrations array
    // so the workerd-side setup file can apply them without importing Node built-ins.
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
