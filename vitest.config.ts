import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // example/ is a standalone project with its own vitest run (npm run check:example)
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    typecheck: {
      enabled: true,
      include: ["src/**/*.test-d.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
});
