import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig([
  "extensions/**/*.test.ts",
  "extensions-custom/**/*.test.ts",
]);
