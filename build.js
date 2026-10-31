// Bundles src/widget.js (with the Decart SDK) into extension/widget.js.
// Chrome extensions can't load code from the internet, so the SDK must be packed inside.
import { build, context } from "esbuild";
import { copyFileSync } from "node:fs";

const options = {
  entryPoints: ["src/widget.js"],
  bundle: true,
  format: "esm", // keeps `import.meta.url`, which the SDK uses to find its worker file
  target: "chrome120",
  minify: true,
  outfile: "extension/widget.js",
  logLevel: "info",
};

// The SDK starts a small helper worker from a file next to the bundle.
copyFileSync(
  "node_modules/@decartai/sdk/dist/realtime/browser/frame-metadata-worker.js",
  "extension/frame-metadata-worker.js"
);

if (process.argv.includes("--watch")) {
  await (await context(options)).watch();
} else {
  await build(options);
}
