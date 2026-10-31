import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import moduleEntryPoints from "./scripts/eslint/module-entry-points.mjs";

const integrationImports = [
  "**/tools/**",
  "**/host/**",
  "**/app/**",
  "**/client/**",
  "@megapandas/dsh-stock-research",
  "@megapandas/dsh-stock-research/*",
];
const foundationImports = [
  "**/services/**",
  ...integrationImports,
  "@deepseek-ai/*",
];
const pureImports = [
  ...foundationImports,
  "node:*",
  "**/cache/**",
  "**/data/**",
  "**/memory/**",
  "**/runs/**",
  "**/storage/**",
];
const runConsumerRestriction = {
  selector:
    ":matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration)[source.value='./runs.js'], :matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration)[source.value=/services\\u002Fruns\\.js$/]",
  message:
    "Consumers must select run capabilities instead of depending on the RunService implementation.",
};
const digestPrivateRestriction = {
  selector:
    ":matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration)[source.value=/(^|\\u002F)digest-(inputs|draft)\\.js$/]",
  message:
    "Digest consumers must use the digest service or shared artifact rules instead of digest assembly internals.",
};

export default defineConfig(
  globalIgnores(["dist/", "coverage/"]),
  {
    files: ["**/*.{ts,tsx,mjs}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      architecture: { rules: { "module-entry-points": moduleEntryPoints } },
    },
    rules: {
      "architecture/module-entry-points": [
        "error",
        [
          {
            directory: "src/services/query",
            publicEntries: ["index.js", "calculations.js"],
          },
          {
            directory: "src/services/collection",
            publicEntries: ["index.js", "view.js"],
          },
        ],
      ],
    },
  },
  {
    files: [
      "src/{artifacts,cache,data,indicators,json,memory,report,runs,storage,valuation}/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: foundationImports,
              message:
                "Foundation modules must not depend on services, integration layers, or the host SDK.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/services/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...integrationImports, "@deepseek-ai/*"],
              message:
                "Services must not depend on integration layers or the host SDK.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/services/runs.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                ...integrationImports,
                "@deepseek-ai/*",
                "**/report/**",
                "**/run-projections.*",
              ],
              message:
                "Run transactions must not depend on report rendering or projection composition.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/{indicators,json,report,valuation}/**/*.ts",
      "src/services/collection/{plan,quality,view,errors}.ts",
      "src/services/query/calculations.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: pureImports,
              message:
                "Pure modules must not depend on I/O, persistence, services, or integration layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/artifacts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...pureImports, "!node:util"],
              message:
                "Artifact rules must not depend on I/O, persistence, services, or integration layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/services/query/calculations.ts",
      "src/services/collection/{plan,quality,view,errors}.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...pureImports, "./*.js", "../*.js"],
              message:
                "Pure rules must depend on contracts and pure computations instead of stateful services.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/{app,services,tools,host}/**/*.ts", "src/*.ts"],
    ignores: ["src/services/create-run-service.ts"],
    rules: {
      "no-restricted-syntax": ["error", runConsumerRestriction],
    },
  },
  {
    files: ["src/{app,tools,host,client,services}/**/*.{ts,tsx}", "src/*.ts"],
    ignores: [
      "src/services/digests.ts",
      "src/services/digest-inputs.ts",
      "src/services/digest-draft.ts",
      "src/services/create-run-service.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        runConsumerRestriction,
        digestPrivateRestriction,
      ],
    },
  },
  {
    files: ["src/services/{numbers,valuation-records,valuation-reports}.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        runConsumerRestriction,
        digestPrivateRestriction,
        {
          selector:
            ":matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration)[source.value=/(^|\\u002F)valuation-calculations\\.js$/]",
          message:
            "Valuation readers and reports must not depend on calculation registration.",
        },
      ],
    },
  },
  {
    files: ["src/services/valuation-records.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                ...integrationImports,
                "@deepseek-ai/*",
                "**/valuation-reports.js",
                "**/report/**",
              ],
              message:
                "Fixed valuation records must not depend on report rendering or integration layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/host/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/app/**",
                "@megapandas/dsh-stock-research",
                "@megapandas/dsh-stock-research/application",
                "@megapandas/dsh-stock-research/quick",
                "@megapandas/dsh-stock-research/ask",
                "@megapandas/dsh-stock-research/review",
                "@megapandas/dsh-stock-research/role",
              ],
              message:
                "Host adapters must consume supplied execution contracts instead of application internals.",
            },
            {
              regex:
                "^(?:\\.\\./)+(?:index|plugin|application|quick|ask|review|role)\\.js$",
              message:
                "Host adapters must not access application composition through public entry points.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/app/{quick-plan,deep-plan,research-plan,research-input-capture,query-snapshots,collection-snapshot,open-research}.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "**/tools/**", "**/host/**", "@deepseek-ai/*"],
              message:
                "Research plans must use neutral contracts instead of tools, host adapters, or the host SDK.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/research-executions.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/tools/**",
                "**/host/**",
                "@deepseek-ai/dsh-commands",
                "./quick.js",
                "./research-application.js",
                "./research-commands.js",
                "./research-tools.js",
                "./research-read-tools.js",
                "./open-research.js",
                "./*-plan.js",
                "./research-models.js",
              ],
              message:
                "Execution ownership must not depend on commands, tool adapters, research policy, or runtime composition.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/activity.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/host/**",
                "../runtime.js",
                "@megapandas/dsh-stock-research/runtime",
                "@deepseek-ai/*",
                "**/services/**",
                "**/storage/**",
              ],
              message:
                "Activity tracking must use the owner's busy capability without owning runtime or storage lifecycle.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/research-application.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/tools/**",
                "@deepseek-ai/cordis",
                "**/host/runtime.js",
                "../runtime.js",
                "@megapandas/dsh-stock-research/runtime",
                "@deepseek-ai/dsh-tools",
                "@deepseek-ai/dsh-commands",
                "@deepseek-ai/dsh-jobs",
                "@deepseek-ai/dsh-llm",
                "./quick.js",
                "./research-commands.js",
                "./research-tools.js",
                "./research-read-tools.js",
                "./run-command-input.js",
                "./run-view.js",
                "./settings.js",
                "./activity.js",
              ],
              message:
                "Research actions must use typed requests and coordinator ports instead of command/tool adapters or output formatting.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/research-{commands,tools,read-tools}.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "./research-application.js",
                "./research-executions.js",
                "**/services/**",
                "**/storage/**",
                "**/runs/**",
              ],
              message:
                "Application adapters must use action/read contracts instead of owning workflow state or business mutations.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/research-job-view.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "@deepseek-ai/*",
                "**/tools/**",
                "**/host/**",
                "**/services/**",
                "**/storage/**",
                "**/runs/**",
                "**/cache/**",
                "**/memory/**",
              ],
              allowTypeImports: true,
              message:
                "Job presentation must render supplied values without runtime SDK, service, or I/O dependencies.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/{ask-request,review-request}.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@deepseek-ai/cordis",
                "@deepseek-ai/dsh-commands",
                "**/host/runtime.js",
                "../runtime.js",
                "@megapandas/dsh-stock-research/runtime",
                "./settings.js",
                "./activity.js",
              ],
              message:
                "Request preparation must use explicit capabilities instead of Context, total Runtime, or command adapters.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/review-session.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "@deepseek-ai/*",
                "**/host/**",
                "**/tools/**",
                "**/storage/**",
                "**/runs/**",
              ],
              message:
                "Review business state must use supplied capabilities instead of SDK, tools, or host execution.",
            },
            {
              group: ["**/services/**"],
              allowTypeImports: true,
              message:
                "Review business state must receive service capabilities instead of creating or locating services.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/client/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "**/app/**",
                "**/host/**",
                "**/services/**",
                "**/storage/**",
                "**/runs/**",
                "**/tools/**",
                "@megapandas/dsh-stock-research",
                "@megapandas/dsh-stock-research/*",
              ],
              message:
                "Client presentation must consume shared contracts and native client APIs instead of server or application internals.",
            },
            {
              regex:
                "^(?:\\.\\./)+(?:index|plugin|core|tools|runtime|application|quick|ask|review|role)\\.js$",
              message:
                "Client presentation must not access server composition through public entry points.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "../**", "@deepseek-ai/*"],
              message:
                "Public contracts must not depend on I/O or upper layers.",
            },
          ],
        },
      ],
    },
  },
);
