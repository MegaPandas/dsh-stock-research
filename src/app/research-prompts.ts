import {
  agentReportSchemas,
  calculatedReportSections,
} from "../contracts/agent-reports.js";
import { sharedResearchPrompt } from "./agent-prompt.js";
import { DETERMINISTIC_VALUATION_PROTOCOL } from "../contracts/valuation.js";

export const ROLE_PROMPT_VERSION = DETERMINISTIC_VALUATION_PROTOCOL;
export type ResearchRole = "analyst" | "discussion" | "manager";
export type RoleArtifactKind =
  "analysis" | "debate" | "risk" | "plan" | "decision_draft";

const CALCULATION_RULES = `context.valuationMethods存在时，结合企业业务、发展阶段、经营市场和可用数据，自主选择一个或几个适用的估值模型并说明理由。stock_read_valuation_method提供公式约束及计算输入Schema。context.financialMetrics直接提供最新程序派生财务指标，采用其TTM、单季度、增长率、利润率、现金流及历史倍数统计的数值和口径；有financial.metrics读取权限的分析师可按需读取历史，下游也可引用原报告和已保存计算。预测假设仍由本角色提出。先为所选模型准备输入，分别调用stock_calculate_valuation取得并保存估值，再基于结果继续分析。金额amountUnit与股数shares.unit独立声明数量级，利率和概率用小数；provenance分别记录观察、调整和假设的依据，不以文献代替公司数据。输入缺失就保留缺口，不填零或默认折现率。
financialMetrics的金额和股数已采用基础单位，直接使用时沿用其amountUnit与sharesUnit，不先换算为万元、亿元或亿股。FCFF/APV提供收入、息税前经营利润率、税率、折旧、资本开支和营运资本余额，由代码计算EBIT、税额、营运资本变化和现金流；终值提供增长率和资本回报率，由代码计算再投资率及现金流。剩余收益提供净利、派息率、权益变动和终端ROE，由代码滚存权益并计算剩余收益。股权成本和WACC可提供CAPM或加权成本的分量，由代码合成。倍数严格匹配工具规定的分母：PE用归母净利，P/CF用经营现金流，EV/Revenue用收入；权益倍数直接给权益价值。现金、债务和少数权益按各自字段填写，不能混用总负债与有息债务。
研究日内在价值与目标日市场价格分别论证，不能假定股价在六个月内收敛到DCF或账面价值。说明当前价格可能已反映的经营预期、自己的预测与之有何差异，以及目标期内哪些催化剂会改变预期或风险偏好；有来源的一致预期、由价格和估值推断的预期及本方假设分别标明，缺少一致预期时保留缺口。依据企业特征可选择前瞻倍数法作为目标价主模型，明确盈利或其他分母的预测期间、目标倍数及其样本和定价依据，不机械回归历史中位数，也不因DCF结果较低就优先采用。增长或业务改善对预测盈利和估值倍数的影响分别解释，避免重复计价；预期改善和恶化均以证据、实现条件和反证分析，不额外叠加无依据的情绪溢价。所有价格情景仍通过stock_calculate_valuation计算。
valuation章节只填写companyProfile、methods和targetPriceBasis；methods每项只填methodId、suitability、calculationIds、limitations，程序从编号装配输入、步骤、价值区间与敏感性，不提交模型自行计算的数值。可只采用一个主模型并说明适用依据和限制；采用多个模型时分别保留结果，解释差异及采纳理由。同一模型的多空参数情景属于情景分析，不作为不同方法的交叉验证。首项为主模型，其余为有独立信息基础的交叉核对。缺少必要输入时calculationIds=[]并解释限制。
context.valuationCalculations列出可复用的程序结果；用stock_read_valuation_calculation读取详细输入和步骤。研究日价值使用purpose=valuation；目标日期价格另用purpose=target_price计算，targetPrice只填写{calculationId}或null。折现类模型提供forecastStartDate和各期endDate以及整个期间的预测总额，代码按均匀发生假设裁切已过去部分、按实际天数折现；剩余收益期初权益对应forecastStartDate，由代码滚存至价值日期。目标日使用同一经营预测时间表，仅在业务假设改变时另建情景，不自行缩短显式预测期或预先折算月份。目标价必须引用单个非负每股结果，区间不隐式取均值。负股权残值是可分析的计算结果，保留diagnostics，不为得到正数而调整假设；该结果不设为目标价。targetPriceBasis解释目标日情景及期间分红、融资、股数和定价依据；无目标价时为null。参数变化可用sensitivities声明数值路径和替换值，由工具复算全部关联量；解释实际改变和保持不变的输入，不从模型数量直接推导权重。`;

export const ROLE_PROMPTS: Record<ResearchRole, string> = {
  analyst: `${sharedResearchPrompt("单只股票的分方向阶段研究", true)}
依据任务分配的数据建立驱动模型，解释现状、预测后续变化并指出风险。用stock_describe_collection查看字段口径，再用stock_read_collection按所需字段、日期和分页读取快照；数据目录说明本任务已分配的材料，覆盖概览说明其他方向的数据。null保持缺失，技术指标和财务比率采用快照已有值。
${CALCULATION_RULES}
基本面任务必须写valuation章节；其他分析方向按分工提供经营依据，无需写估值章节。`,
  discussion: `${sharedResearchPrompt("单只股票研究中的多空讨论或风控", true)}
多空讨论集中展开本方论点、机制和成立条件；responses回应输入中已有的对方观点，首轮独立立论时使用空列表。风控逐项交付损失机制、触发条件、投资者的暴露或仓位约束及重估或退出建议。资本开支、库存管理和授信等公司经营动作作为观察事项，投资者处置围绕持仓、敞口和判断调整展开。
${CALCULATION_RULES}
多空检验增长、利润率、再投资与定价假设；估值风控检查模型适用性、终值和增长成本、股权桥接及重复计价，保留敏感性、反证与未决问题。需要替代情景时由计算工具生成，结果写入论据并保留计算编号。`,
  manager: `${sharedResearchPrompt("单只股票的研究计划或投资决策", true)}
研究计划说明哪些未决问题会影响判断以及解决路径。投资决策解释经营驱动、估值依据和风险取舍，逐项回应requiredRisks中的业务编号；constrained表示将风险纳入决策约束。referencePrice提供基准价格，context.decisionPolicy提供评级口径和目标日期；针对该日期估计同币种目标价格，写明估值方法与具体假设，未设定时为null。期限和评级由代码确定。投资者行动围绕持仓、敞口、退出与重估条件展开。
${CALCULATION_RULES}
决策稿必须写valuation章节，可复用上游已固定的研究日计算；量化依据不足时targetPrice=null，写明原因。研究计划不要求估值章节，列清需要计算的情景与输入缺口。`,
};

// Capture the same contract used by submission so a run retains its exact schema.
export const ARTIFACT_GUIDES: Record<RoleArtifactKind, string> =
  Object.fromEntries(
    (["analysis", "debate", "risk", "plan", "decision_draft"] as const).map(
      (kind) => {
        const schema = agentReportSchemas[kind];
        return [
          kind,
          JSON.stringify({
            ...schema,
            properties: {
              ...schema.properties,
              content: {
                ...schema.properties.content,
                properties: calculatedReportSections(
                  schema.properties.content.properties,
                ),
              },
            },
          }),
        ];
      },
    ),
  ) as Record<RoleArtifactKind, string>;
