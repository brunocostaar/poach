// Stage what an installed Poach needs beside its binary (see
// src-tauri/tauri.bundle.conf.json): the analysis engine, a self-contained
// MCP connector and the GNOME extension. Run after `pnpm build`.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const app = fileURLToPath(new URL("../", import.meta.url));
const root = join(app, "../..");
const out = join(app, "src-tauri/resources");

await rm(out, { recursive: true, force: true });

// @poach/core has no runtime dependencies, so its build output runs as is.
await cp(join(root, "packages/core/dist"), join(out, "core"), {
  recursive: true,
  filter: (source) => !/\.(d\.ts|map)$/.test(source),
});

// Same bundling as scripts/build-connectors.mjs for the macOS connector.
await build({
  entryPoints: [join(root, "packages/mcp-server/dist/index.js")],
  outfile: join(out, "mcp/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
});

const extension = join(out, "gnome-extension");
await mkdir(extension, { recursive: true });
for (const entry of ["metadata.json", "extension.js", "schemas", "icons"]) {
  await cp(join(app, "gnome-extension", entry), join(extension, entry), { recursive: true });
}
execFileSync("glib-compile-schemas", [join(extension, "schemas")]);

console.log(`Staged Poach resources in ${out}`);
