import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/persistence/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? "./var/copy-trading.sqlite",
  },
});
