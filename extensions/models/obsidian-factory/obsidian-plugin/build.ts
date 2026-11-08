import { build } from "npm:esbuild@0.25.0";

const here = new URL(".", import.meta.url);
await build({
  absWorkingDir: decodeURIComponent(here.pathname),
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: "main.js",
  legalComments: "none",
  sourcemap: false,
  minify: false,
  logLevel: "warning",
  footer: {
    js: "module.exports = module.exports.default || module.exports;",
  },
});

const bytes = await Deno.readFile(new URL("main.js", import.meta.url));
const digest = await crypto.subtle.digest("SHA-256", bytes);
const hash = Array.from(
  new Uint8Array(digest),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");
await Deno.writeTextFile(
  new URL("main.js.sha256.txt", import.meta.url),
  `${hash}\n`,
);
console.log(`main.js ${bytes.length} bytes, sha256 ${hash}`);
