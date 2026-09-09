import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  minify: false,
  treeshake: true,
  external: ["@earendil-works/pi-coding-agent"],
  banner: { js: "// pi-billion-memory - MIT License" },
});
