import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // Mirror the "@/*" path alias from tsconfig.json. Done by hand rather than
    // with vite-tsconfig-paths: one alias is not worth a dependency, and an
    // explicit line here is easier to reason about than a plugin that reads
    // tsconfig at run time. If the alias list grows, revisit.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // Node environment only. Every function we unit-test is pure — chunking
    // and citation validation take data and return data. Nothing under test
    // touches the DOM, so jsdom would be startup cost for no coverage.
    // Browser-coupled code (pdf.js, speechSynthesis) is verified by hand.
    environment: "node",
    include: ["lib/**/*.test.ts"],
    // No `globals: true`: `describe`/`it`/`expect` are imported explicitly in
    // each test file, so the type checker and the reader both see where they
    // come from, and no extra ambient types have to be wired into tsconfig.
    globals: false,
  },
});
