import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  alias: {
    obsidian: path.join(root, "src", "browserObsidianShim.ts"),
  },
  banner: {
    js: "/*! Owen Mermaid browser editor | MIT | Copyright (c) 2026 towishy | See owen-mermaid.LICENSE */",
  },
  bundle: true,
  entryPoints: [path.join(root, "src", "browser.ts")],
  format: "iife",
  globalName: "OwenMermaid",
  legalComments: "none",
  loader: { ".css": "css" },
  minify: true,
  outfile: path.join(root, "dist", "owen-mermaid-editor.js"),
  sourcemap: false,
  target: "es2021",
});