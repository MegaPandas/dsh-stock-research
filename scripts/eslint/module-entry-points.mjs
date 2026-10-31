import { dirname, isAbsolute, resolve, sep } from "node:path";

function inside(file, directory) {
  return file.startsWith(`${directory}${sep}`);
}

export default {
  meta: {
    type: "problem",
    schema: [
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            directory: { type: "string" },
            publicEntries: { type: "array", items: { type: "string" } },
          },
          required: ["directory", "publicEntries"],
          additionalProperties: false,
        },
      },
    ],
    messages: {
      privateEntry:
        "Module {{entry}} is private to {{module}}; use its declared public entries.",
    },
  },
  create(context) {
    const consumer = resolve(context.cwd, context.filename);
    const modules = context.options[0].map(({ directory, publicEntries }) => {
      const root = resolve(context.cwd, directory);
      return {
        directory,
        root,
        publicEntries: new Set(
          publicEntries.map((entry) => resolve(root, entry)),
        ),
      };
    });

    function check(node) {
      const source =
        node.type === "TSExternalModuleReference"
          ? node.expression
          : node.source;
      if (typeof source?.value !== "string") return;
      const specifier = source.value;
      if (!specifier.startsWith(".") && !isAbsolute(specifier)) return;
      const target = resolve(dirname(consumer), specifier);
      for (const module of modules) {
        if (
          inside(target, module.root) &&
          !inside(consumer, module.root) &&
          !module.publicEntries.has(target)
        )
          context.report({
            node: source,
            messageId: "privateEntry",
            data: { module: module.directory, entry: specifier },
          });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      TSImportType: check,
      TSExternalModuleReference: check,
    };
  },
};
