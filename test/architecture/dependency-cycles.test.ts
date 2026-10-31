import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps local source dependencies acyclic, including type imports", () => {
  const root = resolve("src");
  const files = ts.sys.readDirectory(root, [".ts", ".tsx"]).sort();
  const sourceFiles = new Set(files);
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    resolveJsonModule: true,
  };
  const cache = ts.createModuleResolutionCache(
    process.cwd(),
    (file) => file,
    options,
  );
  const dependencies = new Map(
    files.map((file) => {
      const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
      const targets = imports.importedFiles.flatMap(({ fileName }) => {
        const target = ts.resolveModuleName(
          fileName,
          file,
          options,
          ts.sys,
          cache,
        ).resolvedModule?.resolvedFileName;
        return target !== undefined && sourceFiles.has(target) ? [target] : [];
      });
      return [file, targets];
    }),
  );
  const visited = new Set<string>();
  const active = new Map<string, number>();
  const path: string[] = [];
  const cycles: string[][] = [];

  function visit(file: string): void {
    const start = active.get(file);
    if (start !== undefined) {
      cycles.push(
        [...path.slice(start), file].map((entry) => relative(root, entry)),
      );
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.set(file, path.length);
    path.push(file);
    for (const target of dependencies.get(file)!) visit(target);
    path.pop();
    active.delete(file);
  }

  for (const file of files) visit(file);
  expect(cycles).toEqual([]);
});
