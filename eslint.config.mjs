import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "next-env.d.ts", "node_modules/**", "public/**"]),

  // Boundary 1: the engine is framework-free. It must not reach into the app, features, or React/Next.
  {
    files: ["src/engine/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/app", "@/app/*", "@/features", "@/features/*", "@/lib", "@/lib/*"], message: "src/engine must not import from the app, features or lib layers." },
            { group: ["**/app/**", "**/features/**", "**/lib/**"], message: "src/engine must not import from the app, features or lib layers." },
            { group: ["react", "react/*", "react-dom", "react-dom/*", "next", "next/*"], message: "src/engine must stay framework-free (no React / Next)." },
          ],
        },
      ],
    },
  },

  // Boundary 2: everything outside the engine may use it only through its index.
  {
    files: ["src/app/**/*.{ts,tsx}", "src/features/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/engine/*", "**/engine/*"], message: "Import the engine through '@/engine' (its index) only." },
          ],
        },
      ],
    },
  },
]);
