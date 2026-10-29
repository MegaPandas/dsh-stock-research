import { createRequire } from "node:module";
import type { OpenRunInput, RunVersions } from "../contracts/runs.js";
import type { RunDefinition, TaskDefinition } from "../contracts/workflow.js";
import type { SourceDescription } from "../services/query-sources.js";
import type { QueryToolPolicy } from "../tools/query-inputs.js";
import { DIGEST_PROMPT_VERSION } from "../host/digest-model.js";
import type { SourceCodeVersions } from "../data/versions.js";
import {
  APPLICATION_INPUT_NAME,
  captureApplicationInput,
} from "./research-input.js";
import { ROLE_PROMPT_VERSION } from "./research-prompts.js";
import { VALUATION_ENGINE_VERSION } from "../contracts/valuation.js";
import {
  VALUATION_METHODS,
  VALUATION_METHODS_INPUT,
} from "./valuation-methods.js";
import {
  PUBLIC_ANALYST_PROMPT,
  PUBLIC_RESEARCH_BRIEF,
  PUBLIC_RESEARCH_PROMPT_INPUT,
  PUBLIC_RESEARCH_TASK,
  PUBLIC_SEARCH_LIMITS,
} from "./public-research.js";
import {
  COORDINATOR_PROMPT,
  COORDINATOR_PROMPT_VERSION,
} from "./coordinator-prompt.js";
import {
  captureQuickSnapshots,
  QUICK_SNAPSHOTS_INPUT,
  type QuickQuerySnapshot,
} from "./quick-snapshots.js";

const PLUGIN_VERSION = (
  createRequire(import.meta.url)(
    "@megapandas/dsh-stock-research/package.json",
  ) as {
    version: string;
  }
).version;

export const DIGEST_RISK_RULE =
  "riskSummaries只对应输入context.requiredRisks中的issueId，每项恰好一次；该列表为空时返回[]。分析师的阶段风险没有风控issueId，不从中发明编号，其含义和阶段交接问题放在keyPoints或openQuestions中并保留上游归属。";

export const SHARED_BRIEFS = {
  "analysis.public": PUBLIC_RESEARCH_BRIEF,
  "analysis.market":
    "就固定快照形成行情方向的阶段性研究备忘录。按采集目录读取个股最近60根日线、52根周线、36根月线及源站均线，解释趋势、量价与相对强弱的现状及变化；K线和技术指标采用源站值。A股相对强弱基准为上证指数、深证成指、沪深300和创业板指，采用对应日/周/月序列。根据价格结构和量能给出明确期限内的基准路径、替代路径及确认或反证信号，交付价格、成交与相对强弱条件。说明这些观察对市场预期变化的可能含义及替代解释，不把量价推断写成已知的一致预期。经营驱动由财务及公开信息方向提供，利率、汇率、黄金与美元指数的传导由宏观方向提供。美股使用采集目录中的数据。采用最新已完成日线的close，按周期完成状态及复权口径解释价格。",
  "analysis.fundamentals":
    "就固定快照形成基本面方向的阶段性研究备忘录。A股读取最近12个报告期的主要财务指标、单季度数据和三表摘要，以及历史市盈率、市净率等源站指标；解释收入、成本、费用、利润、营运资本与资本开支对现金流和财务承受力的关系。建立盈利与现金流驱动模型，说明产品、地区或费用结构假设，给出后续报告期的经营、盈利、现金流及估值展望，交付持续性、弹性和财务风险等研究问题。分别解释长期内在价值与目标日市场定价，说明预测相对于可得市场预期的差异、盈利兑现与倍数变化的依据；历史估值作参照，不预设回归其均值。公司产品与竞争事件由公开信息方向提供。区分合并/归母、累计/单季度与公告日期，财务比率和历史估值采用对应期间的源站值。美股采用采集目录中的数据。",
  "analysis.macro":
    "就固定快照形成宏观方向的阶段性研究备忘录。A股使用中国GDP、CPI/PPI、制造业及非制造业PMI、M0/M1/M2、社融、LPR、工业、社会消费品零售、投资和进出口数据，按源站的月度、季度及累计口径解释当前环境和变化。交付增长、通胀、信用、利率和汇率背景，以及通过需求、成本、融资和汇兑向公司传导的路径与成立条件；区分总量观察、行业传导和公司经营变量。给出明确期限内的基准与替代路径、风险及观察信号，供后续整合公司经营和估值判断。A股固定市场基准读取现货黄金XAU/USD、美元指数DXY、USD/CNY、USD/CNH、EUR/USD、USD/JPY的固定日/周/月快照，以及中国和美国10年期国债最近60条源站日度收益率观察。汇率使用即期报价并保留货币对报价方向；国债收益率单位为percent，缺失国家值保持null。美股宏观使用采集目录中的数据。分析中采用各序列的单位和最新观察期间。",
  "debate.1.bull":
    "以多方视角对分析摘要独立立论，提出支持论点、作用机制、反证和成立条件，明确哪些变量决定上行空间。检验有利因素是否已被价格反映，解释尚未充分计价的预期改善、催化剂及其对盈利或估值倍数的影响。需要展开细节时按目录读取原始报告，提交本方论点与回应。",
  "debate.1.bear":
    "以空方视角对同一分析摘要独立立论，提出反方论点、作用机制和失效条件，明确哪些变量决定下行风险。检验不利因素是否已被价格反映，解释尚未充分计价的预期恶化及其对盈利或估值倍数的影响，回应预期修复使空方判断失效的条件。需要展开细节时按目录读取原始报告，提交本方论点与回应。",
  "manager.decision":
    "基于风控摘要形成投资决策稿，说明经营驱动、估值、风险取舍及改变判断的条件。按context.decisionPolicy的目标日期估计目标价并给出方法和假设；基准价、期限和评级由代码确定。整合已计价预期、预期差和目标期催化剂，解释所选市场定价情景与内在价值结果的关系及采纳理由，不机械采用最低估值。逐项回应全部风控issueId，交付投资者的持仓、敞口、退出和重估条件。提交校验失败后修正具体字段再提交。",
  finalize:
    "按固定业务契约成对发布decision与report，保留已验证经理稿的业务内容、固定引用和风险回应。",
} as const;

export function researchTask(
  id: string,
  executor: TaskDefinition["executor"],
  dependsOn: string[],
  outputKinds: TaskDefinition["outputKinds"],
): TaskDefinition {
  return {
    id,
    executor,
    dependsOn: [...dependsOn],
    inputTasks: [...dependsOn],
    outputKinds: [...outputKinds],
    dataRequirements:
      id === "analysis.market"
        ? [{ dataset: "market", fields: ["close"], requiredForDecision: true }]
        : [],
    instructionVersion: id.startsWith("digest.") ? 3 : 2,
  };
}

export function researchVersions(
  modeVersion: string,
  sources: Readonly<Record<string, SourceCodeVersions>>,
): RunVersions {
  const adapters: Record<string, string> = {};
  const normalization: Record<string, string> = {};
  for (const [key, source] of Object.entries(sources)) {
    adapters[key] = source.adapterVersion;
    normalization[key] = source.normalizationVersion;
  }
  return {
    plugin: PLUGIN_VERSION,
    mode: modeVersion,
    prompts: {
      roles: ROLE_PROMPT_VERSION,
      digest: DIGEST_PROMPT_VERSION,
      coordinator: COORDINATOR_PROMPT_VERSION,
      valuationMethods: VALUATION_METHODS.version,
      valuationEngine: VALUATION_ENGINE_VERSION,
    },
    skills: {},
    adapters,
    normalization,
  };
}

/** Both static plans capture the same application, source and prompt contracts. */
export function captureResearchInput(
  definition: RunDefinition,
  modeVersion: string,
  briefs: Readonly<Record<string, string>>,
  policy: QueryToolPolicy,
  sources: readonly SourceDescription[],
  snapshots: readonly QuickQuerySnapshot[],
  publicSearchLimit: number = PUBLIC_SEARCH_LIMITS.maxSearches,
): OpenRunInput {
  const versions: Record<string, SourceCodeVersions> = {};
  for (const source of sources)
    if (source.capability !== null)
      versions[`${source.dataset}/${source.provider}`] = source.capability;
  return {
    definition: structuredClone(definition),
    versions: researchVersions(modeVersion, versions),
    inputs: [
      {
        name: APPLICATION_INPUT_NAME,
        content: captureApplicationInput(policy, sources, publicSearchLimit),
      },
      { name: "prompt:coordinator", content: COORDINATOR_PROMPT },
      {
        name: VALUATION_METHODS_INPUT,
        content: structuredClone(VALUATION_METHODS),
      },
      ...(definition.tasks.some(({ id }) => id === PUBLIC_RESEARCH_TASK)
        ? [
            {
              name: PUBLIC_RESEARCH_PROMPT_INPUT,
              content: PUBLIC_ANALYST_PROMPT,
            },
          ]
        : []),
      ...(snapshots.length === 0
        ? []
        : [
            {
              name: QUICK_SNAPSHOTS_INPUT,
              content: captureQuickSnapshots(snapshots),
            },
          ]),
    ],
    instructions: definition.tasks.map(({ id }) => ({
      taskId: id,
      instruction: briefs[id]!,
    })),
  };
}
