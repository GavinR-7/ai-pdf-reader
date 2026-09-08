/**
 * Copy pdf.js's runtime assets out of node_modules and into public/pdfjs/.
 *
 * pdf.js is not a self-contained bundle. It fetches three things over HTTP at
 * run time, by URL, from wherever you tell it to look:
 *
 *   pdf.worker.min.mjs  the parser, which runs in a Web Worker
 *   standard_fonts/     metrics for the 14 PDF base fonts
 *   cmaps/              character maps, needed for CJK documents
 *
 * They are copied rather than committed because they must match the installed
 * pdfjs-dist exactly — the API refuses to talk to a worker of a different
 * version — so node_modules is the only correct source of truth. Committing
 * them would mean a silent version skew the first time the dependency is
 * bumped and someone forgets to re-copy. public/pdfjs/ is gitignored.
 *
 * Runs on postinstall and again before build, so both a fresh clone and a
 * Vercel deploy get them without anyone remembering a step.
 */
import { cp, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "pdfjs-dist");
const to = join(root, "public", "pdfjs");

try {
  await access(from);
} catch {
  console.warn("[pdf-assets] pdfjs-dist not installed yet; skipping.");
  process.exit(0);
}

await mkdir(to, { recursive: true });
await cp(join(from, "build", "pdf.worker.min.mjs"), join(to, "pdf.worker.min.mjs"));
await cp(join(from, "standard_fonts"), join(to, "standard_fonts"), { recursive: true });
await cp(join(from, "cmaps"), join(to, "cmaps"), { recursive: true });

const { version } = JSON.parse(
  await (await import("node:fs/promises")).readFile(join(from, "package.json"), "utf8"),
);
console.log(`[pdf-assets] copied pdfjs-dist ${version} assets into public/pdfjs/`);
