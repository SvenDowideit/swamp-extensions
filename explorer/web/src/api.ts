// API client + shared types for the swamp explorer.

export interface ModelSummary {
  id: string;
  name: string;
  type: string;
}

export interface ModelDetail {
  id: string;
  name: string;
  type: string;
  version: number;
  tags: Record<string, unknown>;
  globalArguments: Record<string, unknown>;
  typeVersion: string;
  globalArgumentsSchema: JsonSchema;
  methods: MethodSchema[];
}

export interface MethodSchema {
  name: string;
  description: string;
  arguments: JsonSchema;
}

export interface JsonSchema {
  $schema?: string;
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
  default?: unknown;
  items?: JsonSchema;
}

export interface JsonSchemaProperty extends JsonSchema {
  format?: string;
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

export interface TypeDetail {
  type: { raw: string; normalized: string };
  version: string;
  globalArguments: JsonSchema;
  dataOutputSpecs: DataOutputSpec[];
  methods: MethodSchema[];
}

export interface DataOutputSpec {
  specName: string;
  kind: string;
  description: string;
  schema: JsonSchema;
  lifetime: string;
  garbageCollection: number;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  jobCount: number;
}

export interface WorkflowStep {
  name: string;
  description?: string;
  task: {
    type: string;
    modelType?: string;
    modelName?: string;
    methodName?: string;
    inputs?: Record<string, unknown>;
  };
}

export interface WorkflowDetail {
  id: string;
  name: string;
  description: string;
  version: number;
  jobs: Array<{ name: string; description?: string; steps: WorkflowStep[] }>;
  path?: string;
}

export interface DataListItem {
  id: string;
  name: string;
  version: number;
  contentType: string;
  type: string; // resource | file | report
  streaming: boolean;
  size: number;
  createdAt: string;
  // for workflow data:
  modelId?: string;
  modelName?: string;
  modelType?: string;
  jobName?: string;
  stepName?: string;
}

export interface DataListResponse {
  modelId?: string;
  modelName?: string;
  modelType?: string;
  workflowId?: string;
  workflowName?: string;
  runId?: string;
  runStatus?: string;
  groups: Array<{ type: string; items: DataListItem[] }>;
}

export interface RunHistoryItem {
  id: string;
  type: string; // workflow | method
  name: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetchJson<{ ok: boolean; repoDir: string }>("/api/health"),
  listModels: () => fetchJson<{ results: ModelSummary[] }>("/api/models"),
  getModel: (name: string) => fetchJson<ModelDetail>(`/api/models/${encodeURIComponent(name)}`),
  getType: (type: string) => fetchJson<TypeDetail>(`/api/types/${encodeURIComponent(type)}`),
  listWorkflows: () => fetchJson<{ results: WorkflowSummary[] }>("/api/workflows"),
  getWorkflow: (name: string) => fetchJson<WorkflowDetail>(`/api/workflows/${encodeURIComponent(name)}`),
  listData: (model: string) => fetchJson<DataListResponse>(`/api/data/${encodeURIComponent(model)}`),
  getData: (model: string, name: string, version?: number) =>
    fetchJson<unknown>(`/api/data/${encodeURIComponent(model)}/${encodeURIComponent(name)}${version ? `?version=${version}` : ""}`),
  listWorkflowData: (name: string) => fetchJson<DataListResponse>(`/api/workflow-data/${encodeURIComponent(name)}`),
  listRuns: () => fetchJson<unknown>("/api/runs"),
  runWorkflow: (name: string, inputs: Record<string, unknown>) =>
    fetchJson<unknown>(`/api/runs/workflow/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs }),
    }),
  runMethod: (model: string, method: string, inputs: Record<string, unknown>) =>
    fetchJson<unknown>(`/api/runs/method/${encodeURIComponent(model)}/${encodeURIComponent(method)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs }),
    }),
};