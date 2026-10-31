export interface ModelRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ModelCatalog {
  default?: ModelRoute;
  groups: {
    id: string;
    name: string;
    models: {
      id: string;
      name: string;
      reasoning?: {
        efforts: { id: string; name: string; description?: string }[];
        defaultEffort?: string;
      };
    }[];
  }[];
}
