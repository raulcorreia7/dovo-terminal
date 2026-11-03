import { defineConfig } from "drizzle-kit";

// `pnpm --filter @dovo-terminal/a2a exec drizzle-kit generate` after changing src/schema.ts
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
