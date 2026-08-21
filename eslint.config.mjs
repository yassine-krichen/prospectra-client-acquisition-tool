import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // A leading underscore is this codebase's existing convention for "must
      // stay in the signature (implements a shared interface / callback
      // shape) but this implementation doesn't need it" - e.g.
      // indiehackers.source.ts's `_query` param, required to match every
      // other discovery source's `(query: DiscoveryQuery) => Promise<SourceResult>`
      // shape. Without this, the convention doesn't actually suppress the
      // warning it's meant to.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma-generated client - not authored/maintained code.
    "lib/generated/**",
    // Python prototype (pending removal in a later phase) and its venv.
    "venv/**",
  ]),
]);

export default eslintConfig;
