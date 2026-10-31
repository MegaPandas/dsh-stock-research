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
          {
            directory: "src/services/run",
            publicEntries: ["index.js"],
          },
          {
            directory: "src/services/artifact-submission",
            publicEntries: ["index.js"],
          },
          {
            directory: "src/services/digest",
            publicEntries: ["index.js", "handoff.js"],
          },
          {
            directory: "src/services/memory",
            publicEntries: ["index.js"],
          },
          {
            directory: "src/app/plan",
            publicEntries: [
              "quick.js",
              "deep.js",
              "versions.js",
              "protocol.js",
            ],
          },
          {
            directory: "src/app/role-preparation",
            publicEntries: ["index.js"],
          },
          {
            directory: "src/app/research-control",
            publicEntries: ["index.js"],
          },
          {
            directory: "src/app/review-preparation",
            publicEntries: ["index.js"],
          },
          {
            directory: "src/tools",
            publicEntries: [
              "index.js",
              "control.js",
              "data.js",
              "read.js",
              "write.js",
              "data-health.js",
              "recall.js",
              "service-tasks.js",
              "valuation.js",
              "parameters.js",
              "query-inputs.js",
              "query-scope.js",
              "errors.js",
            ],
          },
          {
            directory: "src/host/dispatch",
            publicEntries: ["index.js"],
          },
          {
            directory: "src/host/sessions",
            publicEntries: ["index.js"],
          },
          {
            directory: "src/host/agent-protocol",
            publicEntries: ["input.js", "submission.js"],
          },
          {
            directory: "src/app/research-execution",
            publicEntries: ["index.js", "labels.js"],
          },
          {
            directory: "src/client",
            publicEntries: ["index.js"],
          },
          {
            directory: "src/evidence",
            publicEntries: ["fields.js", "checks.js", "price-basis.js"],
          },
          {
            directory: "src/artifacts",
            publicEntries: [
              "references.js",
              "risks.js",
              "gaps.js",
              "schema.js",
              "analysis-report.js",
              "agent-reports.js",
              "stage-handoff.js",
              "assembly.js",
            ],
          },
        ],
      ],
    },
  },
  {
    files: [
      "src/{artifacts,cache,data,evidence,indicators,json,memory,report,runs,storage,valuation}/**/*.ts",
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
    files: ["src/services/run/service.ts"],
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
                "**/projections.*",
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
      "src/{evidence,indicators,json,report,valuation}/**/*.ts",
      "src/services/collection/{plan,quality,view,errors}.ts",
      "src/services/query/calculations.ts",
      "src/services/digest/{draft,handoff}.ts",
      "src/services/memory/state.ts",
      "src/app/plan/**/*.ts",
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
    files: ["src/report/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...pureImports, "**/artifacts/**"],
              message:
                "Report rendering must consume contracts and pure computations instead of artifact parsing or assembly.",
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
      "src/services/digest/{draft,handoff}.ts",
      "src/services/memory/state.ts",
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
    files: ["src/services/{numbers,valuation-records,valuation-reports}.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
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
      "src/app/collection-snapshot.ts",
      "src/app/research-control/open.ts",
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
    files: ["src/app/research-scope.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...pureImports, "./**"],
              message:
                "Research scope rules must depend on contracts and pure computations instead of command parsing or execution.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/research-execution/**/*.ts"],
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
                "**/quick.js",
                "**/research-control/**",
                "**/research-commands.js",
                "**/research-tools.js",
                "**/research-read-tools.js",
                "**/plan/**",
                "**/research-models.js",
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
    files: ["src/app/research-control/index.ts"],
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
                "../../runtime.js",
                "@megapandas/dsh-stock-research/runtime",
                "@deepseek-ai/dsh-tools",
                "@deepseek-ai/dsh-commands",
                "@deepseek-ai/dsh-jobs",
                "@deepseek-ai/dsh-llm",
                "../quick.js",
                "../research-commands.js",
                "../research-tools.js",
                "../research-read-tools.js",
                "../run-command-input.js",
                "../run-view.js",
                "../settings.js",
                "../activity.js",
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
                "./research-control/**",
                "./research-execution/**",
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
    files: ["src/app/research-execution/{view,progress,labels}.ts"],
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
                "./index.js",
                "./output.js",
                "../research-control/**",
                "../plan/**",
                "../quick.js",
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
    files: ["src/app/ask-request.ts", "src/app/review-preparation/**/*.ts"],
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
                "../../runtime.js",
                "@megapandas/dsh-stock-research/runtime",
                "./settings.js",
                "./activity.js",
                "../settings.js",
                "../activity.js",
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
