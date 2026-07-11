import { defineConfig, type Options } from "tsup";

const shared: Options = {
  clean: true,
  format: ["esm"],
  platform: "node",
  sourcemap: true,
  splitting: false,
  target: "node22",
  treeshake: true,
};

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
    dts: true,
  },
  {
    ...shared,
    clean: false,
    entry: { cli: "src/cli/main.ts" },
    banner: { js: "#!/usr/bin/env node" },
  },
]);
