export type {
  ArtifactRef,
  CandidateClaim,
  DataEnvelope,
  DataGap,
  Dataset,
  EvidenceRecord,
  EvidenceRef,
  ISOTime,
  LocalDate,
  MarketBar,
  MarketData,
  Mode,
  PriceAdjustment,
  ResearchScope,
  Security,
  SourceRef,
} from "./contracts/data.js";
export { ResearchError } from "./contracts/errors.js";
export type { ResearchErrorCode } from "./contracts/errors.js";
export { parseISOTime, parseLocalDate } from "./contracts/time.js";
export type {
  BollValue,
  IndicatorRequest,
  IndicatorResult,
  MacdValue,
  PeriodIndicator,
  PriceReturnInput,
  PriceReturnResult,
  ReturnPrice,
} from "./contracts/indicators.js";
export {
  calculateIndicators,
  INDICATORS_ALGORITHM_VERSION,
} from "./indicators/index.js";
export {
  calculatePriceReturn,
  PRICE_RETURN_ALGORITHM_VERSION,
} from "./indicators/returns.js";
export { HttpClient, HttpStatusError } from "./data/http.js";
export type { HttpClientOptions } from "./contracts/http.js";
export type { HttpRequestOptions } from "./data/http.js";
export type {
  ApplicationConfig,
  ModelConfig,
  ResearchConfig,
  SourceId,
} from "./contracts/settings.js";
export type { JsonValue } from "./contracts/json.js";
export type { QueryCacheKey, QueryCachePolicy } from "./contracts/cache.js";
export { createCacheKey, SqliteCache } from "./cache/index.js";
export type { MarketCapability, MarketQuery } from "./contracts/market.js";
export { YahooMarketAdapter } from "./data/yahoo-market.js";
export { EastmoneyMarketAdapter } from "./data/eastmoney-market.js";
export { TencentMarketAdapter } from "./data/tencent-market.js";
export type {
  FundamentalField,
  FundamentalObservation,
  FundamentalsData,
  SecConceptQuery,
} from "./contracts/fundamentals.js";
export { SecConceptAdapter } from "./data/sec-concept.js";
export type {
  EastmoneyIncomeData,
  EastmoneyIncomeField,
  EastmoneyIncomeObservation,
  EastmoneyIncomeQuery,
} from "./contracts/eastmoney-income.js";
export { EastmoneyIncomeAdapter } from "./data/eastmoney-income.js";
export type {
  SinaIncomeData,
  SinaIncomeField,
  SinaIncomeObservation,
  SinaIncomeQuery,
} from "./contracts/sina-income.js";
export { SinaIncomeAdapter } from "./data/sina-income.js";
export type {
  FredQuery,
  FredSeriesId,
  MacroData,
  MacroObservation,
} from "./contracts/macro.js";
export { FredCsvAdapter } from "./data/fred-csv.js";
export type {
  HostWebSearch,
  ResearchData,
  ResearchItem,
  ResearchQuery,
} from "./contracts/research.js";
export { HostResearchAdapter } from "./data/host-research.js";
export type {
  ArtifactContentRef,
  ContentRef,
  ContentReader,
  ContentWriter,
  RunLocation,
  StoredRun,
  ProjectionTarget,
  ProjectionWrite,
} from "./contracts/storage.js";
export { DataRoot } from "./storage/data-root.js";
export { RunStore } from "./runs/store.js";
export type {
  MemoryIndex,
  MemoryReader,
  MemoryRef,
  MemoryWriter,
} from "./contracts/memory.js";
export { MemoryStore } from "./memory/store.js";
export type {
  MemoryAccess,
  MemoryEntry,
  MemoryReceipt,
  MemoryReturnSnapshot,
  MemoryState,
  QueryMemoryReturns,
  RecallQuery,
  RememberInput,
  RememberOperation,
} from "./contracts/memory-service.js";
export { MemoryService } from "./services/memory/index.js";
export type {
  ArtifactInput,
  ArtifactVersion,
  ArtifactKind,
  NumberInput,
  NumericClaim,
} from "./contracts/artifacts.js";
export { renderArtifact } from "./report/render.js";
export {
  agentReportSchemas,
  AGENT_SUMMARY_MAX_CHARACTERS,
  DIGEST_MAX_CHARACTERS,
} from "./contracts/agent-reports.js";
export type {
  AgentReport,
  AgentReportContent,
  AgentReportKind,
} from "./contracts/agent-reports.js";
export { parseAgentReport } from "./artifacts/agent-reports.js";
export {
  PRICE_RATING_POLICY,
  PRICE_RATING_MONTHS,
  PRICE_RATING_BANDS,
} from "./contracts/rating-policy.js";
export { decisionPolicy, priceRating } from "./valuation/rating-policy.js";
export type { PriceRating } from "./contracts/rating-policy.js";
export { renderAgentReport } from "./report/agent-report.js";
export type {
  DataRequirement,
  RunDefinition,
  StageDefinition,
  TaskDefinition,
} from "./contracts/workflow.js";
export { validateRunDefinition } from "./services/definition.js";
export type {
  ArtifactCommitResult,
  AttemptFailureResult,
  AttemptTarget,
  BlockReason,
  BlockReasonInput,
  BlockRunResult,
  CancelRunResult,
  ClaimResult,
  OpenRunInput,
  ReceiptAction,
  ResearchRun,
  RecoverAttemptsResult,
  RedoTaskResult,
  ResumeRunInput,
  ResumeRunResult,
  RoleDispatchContext,
  RunArtifact,
  RunInput,
  RunInputCatalog,
  RunInputReference,
  RunOperation,
  RunReceipt,
  RunState,
  RunStatus,
  RunVersions,
  RunView,
  RunWriteResult,
  StageReview,
  StageReviewInput,
  StageReviewResult,
  StageView,
  TaskAttempt,
  TaskFailure,
  TaskInstructionSnapshot,
  TaskInstructionUpdate,
  TaskOperation,
  TaskState,
  TaskStatus,
} from "./contracts/runs.js";
export { createRunService } from "./services/run/index.js";
export type {
  RunAccess,
  RunCommands,
  RunLifecycle,
  RunReader,
} from "./contracts/run-access.js";
export type {
  ReplayEvidenceSource,
  ReplayEvidenceRequest,
  ReplayMemoryRequest,
  ReplayRunInput,
  ReplaySnapshot,
  ReplayTaskSnapshot,
} from "./contracts/replay.js";
export type { RunLineage } from "./contracts/run-lineage.js";
export type {
  CandidateSeed,
  EvidenceCall,
  EvidenceInput,
  EvidenceQuery,
  MemoryInputCall,
  MemoryInputQuery,
  MemoryInputRegistration,
  MemoryInputSnapshot,
  MemorySnapshotEntry,
  RegisteredEvidenceRecord,
  RunEvidence,
} from "./contracts/task-data.js";
export type {
  EastmoneySourceQuery,
  FredSourceQuery,
  MarketSourceQuery,
  QueryData,
  QueryEnvelope,
  QueryRequest,
  QueryPolicy,
  QueryResponse,
  QuerySnapshot,
  MarketIndicatorsData,
  MarketIndicatorsQuery,
  PriceReturnsData,
  PriceReturnsQuery,
  ReturnObservation,
  TaskQueryResponse,
  ResearchSourceQuery,
  SecSourceQuery,
  SinaSourceQuery,
  SourceData,
  SourceDataset,
  SourceEnvelope,
  ReadSource,
  SourceQuery,
  SourceResponse,
  TaskSourceResponse,
} from "./contracts/query.js";
export type {
  QuerySources,
  QuerySource,
  SourceCapability,
  SourceDescription,
  SourceCodeVersions,
} from "./contracts/sources.js";
export type { QueryHealth, SourceHealth } from "./contracts/sources.js";
export { QueryService } from "./services/query/index.js";
export type { QueryAccess } from "./contracts/query-service.js";
export { TaskQueryService } from "./services/task-query.js";
export { CollectionService } from "./services/collection/index.js";
export { createCollectionTaskFactory } from "./data/collection-tasks.js";
export type {
  CollectionAccess,
  CollectionOptions,
  CollectionSourceConfig,
  CollectionTaskFactory,
  CollectionPlan,
  CollectedTableData,
  CollectionColumn,
  CollectionRow,
  CollectionTask,
  CollectionPacket,
  CollectionReadSource,
  CollectionReadRequest,
  CollectionSummary,
  CollectionSnapshot,
  CollectionFailure,
} from "./contracts/collection.js";
export type {
  ClaimCheck,
  NumberCheck,
  NumberChecker,
  NumberContext,
  NumberIssue,
  NumberIssueCode,
  NumberTarget,
  NumberTargetRef,
  NumberWarning,
} from "./contracts/numbers.js";
export { NumberService, NUMBER_CHECK_VERSION } from "./services/numbers.js";
export type {
  AnalysisPayload,
  AnalysisReport,
  AnalysisNotePayload,
  AnalysisAgentPayload,
  ArtifactPayloads,
  DebatePayload,
  DebateAgentPayload,
  DecisionProposal,
  DecisionResult,
  DigestPayload,
  GapSummary,
  PlanPayload,
  Rating,
  ReportPayload,
  ReportedGap,
  ResearchArtifactInput,
  RiskIssue,
  RiskPayload,
  SupportedStatement,
} from "./contracts/artifact-payloads.js";
export { parseArtifactInput } from "./artifacts/schema.js";
export {
  ArtifactService,
  ArtifactNumberError,
} from "./services/artifact-submission/index.js";
export { DecisionService } from "./services/decisions.js";
export { renderDecisionReport } from "./report/decision.js";
export type {
  DigestDraft,
  DigestModelInput,
  DigestNumberCandidate,
  GenerateDigest,
} from "./contracts/digests.js";
export { DigestService } from "./services/digest/index.js";
export { DIGEST_HANDOFF_VERSION } from "./contracts/digests.js";
export { generateHandoffDigest } from "./services/digest/handoff.js";
