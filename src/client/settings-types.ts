import type {
  ModelCatalog as NativeModelCatalog,
  ModelSelection,
} from "@deepseek-ai/dsh-api-remotes/client";

export type ModelRoute = ModelSelection;

export interface ModelCatalog {
  readonly default?: ModelRoute;
  readonly groups: NativeModelCatalog["groups"];
}
