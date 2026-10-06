import { defineConfig } from "tsdown";

// unbundle: lib/ mirrors src/ file for file. utils/config finds the package root
// as two levels up from itself, so the layout has to survive the build.
export default defineConfig({
  entry: ["src/**/*.ts"],
  format: "esm",
  outDir: "lib",
  platform: "node",
  unbundle: true,
  dts: true,
  clean: true,
  sourcemap: true,
  fixedExtension: false,
});
