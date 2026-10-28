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
export type { HttpClientOptions, HttpRequestOptions } from "./data/http.js";
export type { JsonValue, QueryCacheKey } from "./contracts/cache.js";
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
  MemoryRef,
  MemoryWriter,
} from "./contracts/memory.js";
export { MemoryStore } from "./memory/store.js";
export type {
  MemoryEntry,
  MemoryReceipt,
  MemoryReturnSnapshot,
  MemoryState,
  QueryMemoryReturns,
  RecallQuery,
  RememberInput,
  RememberOperation,
} from "./contracts/memory-service.js";
export { MemoryService } from "./services/memory.js";
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
export { parseAgentReport } from "./services/agent-reports.js";
export {
  PRICE_RATING_POLICY,
  PRICE_RATING_MONTHS,
  PRICE_RATING_BANDS,
  decisionPolicy,
  priceRating,
} from "./contracts/rating-policy.js";
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
export { RunService } from "./services/runs.js";
export type {
  ReplayEvidenceSource,
  ReplayEvidenceRequest,
  ReplayMemoryRequest,
  ReplayRunInput,
  ReplaySnapshot,
  ReplayTaskSnapshot,
  RunLineage,
} from "./contracts/replay.js";
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
  QueryCachePolicy,
  QueryData,
  QueryEnvelope,
  QueryRequest,
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
  SourceQuery,
  SourceResponse,
  TaskSourceResponse,
} from "./contracts/query.js";
export type {
  QuerySources,
  SourceCapability,
} from "./services/query-sources.js";
export type { QueryHealth, SourceHealth } from "./services/query.js";
export { QueryService } from "./services/query.js";
export { CollectionService } from "./services/collection.js";
export type { CollectionOptions } from "./services/collection.js";
export type {
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
  PlanPayload,
  Rating,
  ReportPayload,
  ReportedGap,
  ResearchArtifactInput,
  RiskIssue,
  RiskPayload,
  SupportedStatement,
} from "./contracts/artifact-payloads.js";
export { parseArtifactInput } from "./services/artifact-schema.js";
export { ArtifactService, ArtifactNumberError } from "./services/artifacts.js";
export { DecisionService } from "./services/decisions.js";
export { renderDecisionReport } from "./report/decision.js";
export type {
  DigestDraft,
  DigestModelInput,
  DigestNumberCandidate,
  GenerateDigest,
} from "./contracts/digests.js";
export { DigestService } from "./services/digests.js";
