import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      core: "src/core.ts",
      tools: "src/tools/index.ts",
      runtime: "src/runtime.ts",
      ask: "src/ask.ts",
      review: "src/review.ts",
      application: "src/application.ts",
      role: "src/role.ts",
      quick: "src/quick.ts",
    },
    format: "esm",
    platform: "node",
    target: "node24",
    dts: true,
    clean: true,
  },
  {
    entry: { client: "src/client/index.ts" },
    format: "cjs",
    platform: "browser",
    target: "es2022",
    dts: true,
    clean: false,
    deps: { neverBundle: ["react", "react/jsx-runtime"] },
    outExtensions: () => ({ js: ".js" }),
    banner:
      'window.__ModuleLoader__.load({id:"@megapandas/dsh-stock-research",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
    footer: "return module.exports;}});",
  },
]);
