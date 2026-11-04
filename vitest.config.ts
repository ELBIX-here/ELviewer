import { defineConfig } from "vitest/config";

// Unit tests for the pure TypeScript logic (no Tauri runtime, no DOM).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
