import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Project rule: no `any`, ever. `next/typescript` ships this as a
      // warning, which in practice means it gets ignored. Promoted to an error
      // so CI fails instead of accumulating escape hatches.
      "@typescript-eslint/no-explicit-any": "error",
      // `!` is the same escape hatch as `any` wearing a different hat: it
      // asserts a fact the compiler could not prove and offers no runtime
      // check. When a value's type genuinely cannot be proven, narrow it.
      "@typescript-eslint/no-non-null-assertion": "error",
      // `{ ... } as Foo` on an object literal skips excess-property checking,
      // so a misspelled or stale field passes silently — the exact bug that
      // would let a malformed Chunk through. Banned.
      //
      // Plain narrowing casts (`x as string`) stay legal on purpose: pdf.js
      // hands back deliberately loose union types, and narrowing one after a
      // runtime check is honest work, not a lie. The dangerous case is
      // *inventing* a shape, which is what the object-literal form does.
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Third-party minified assets copied out of pdfjs-dist at build time by
      // scripts/copy-pdf-assets.mjs. Not our code, and linting a 1.3MB
      // minified worker buries real findings under ~1500 spurious ones.
      "public/**",
    ],
  },
];

export default eslintConfig;
