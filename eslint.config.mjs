import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

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
    "ImportDeclaration[source.value='./runs.js'], ImportDeclaration[source.value='../services/runs.js']",
  message:
    "Consumers must select RunReader or RunCommands capabilities instead of depending on the RunService implementation.",
};
const queryPrivateRestriction = {
  selector:
    ":matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration)[source.value=/query\\u002F(source-queries|source-selection)\\.js$/]",
  message:
    "Query consumers must use the public query or calculation entry instead of source execution internals.",
};

export default defineConfig(
  globalIgnores(["dist/", "coverage/"]),
  {
    files: ["**/*.{ts,tsx,mjs}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", queryPrivateRestriction],
    },
  },
  {
    files: [
      "src/{cache,data,indicators,json,memory,report,runs,storage,valuation}/**/*.ts",
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
      "src/services/collection-plan.ts",
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
    files: ["src/services/query/calculations.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...pureImports, "./*.js", "../*.js"],
              message:
                "Query calculations must depend on contracts and pure computations instead of query execution or services.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/{app,services,tools}/**/*.ts"],
    ignores: ["src/services/create-run-service.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        runConsumerRestriction,
        queryPrivateRestriction,
      ],
    },
  },
  {
    files: ["src/services/{numbers,valuation-records,valuation-reports}.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        runConsumerRestriction,
        queryPrivateRestriction,
        {
          selector:
            "ImportDeclaration[source.value='./valuation-calculations.js']",
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
                "./valuation-reports.js",
                "../report/**",
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
                "@megapandas/dsh-stock-research/application",
                "@megapandas/dsh-stock-research/quick",
                "@megapandas/dsh-stock-research/ask",
                "@megapandas/dsh-stock-research/review",
                "@megapandas/dsh-stock-research/role",
              ],
              message:
                "Host adapters must consume supplied execution contracts instead of application internals.",
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
    files: ["src/app/research-application.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/tools/**",
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
              ],
              message:
                "Client presentation must consume shared contracts and native client APIs instead of server or application internals.",
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
