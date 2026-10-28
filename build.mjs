// Bundles the browser editor (client/) into public/editor.js. Uses esbuild's JS API so it works the
// same on Linux/macOS/Windows build machines and on Termux, where the esbuild CLI shim differs.
import { build } from "esbuild";

await build({
  entryPoints: ["client/editor.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  outfile: "public/editor.js",
  logLevel: "info",
});
