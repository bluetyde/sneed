// The browser's side of the local API (src/server/app.ts). Types only come from the core; no core code runs in the browser.
import type { Lesson } from '../core/lesson.js';
import type { ResultRecord } from '../core/result.js';
import type { EtIssue } from '../core/event-tree.js';
import type { EventTreeResult } from '../core/event-tree-result.js';

export interface Issue {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
  ids?: string[];
}

export interface ValidateResponse {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
  model_hash: string | null;
  document_hash: string;
}

export interface RuntimeInfo {
  installed: boolean;
  install_id?: string | null;
  recipe_revision?: number | null;
  engine_version?: string;
  code?: string;
  message?: string;
}

export interface ImportErrorInfo {
  code: string;
  line: number;
  column: number;
  message: string;
  construct?: string;
}
export interface ImportNoteInfo {
  kind: string;
  line: number;
  message: string;
}
export type ImportResponse =
  | { kind: 'refused'; errors: ImportErrorInfo[] }
  | { kind: 'imported'; name: string; notes: ImportNoteInfo[]; summary: { top: string; events: number; gates: number }; source_sha256: string };

export type Engine = 'builtin' | 'scram' | 'both';

/** The second engine's answer when both were asked for, or why there is none. */
export type CrossCheckInfo = { engine: { name: string; version: string }; status: string; agree: boolean; differences: string[] } | { unavailable: true; reason: string };

import type { ImportanceResponse } from '../core/importance.js';
export type { ImportanceResponse };

export type RanResponse = { kind: 'ran'; run_id: string; record: ResultRecord; cross?: CrossCheckInfo };
export type RunResponse = RanResponse | { kind: 'refused'; errors: Issue[]; warnings: Issue[] } | { kind: 'dequeued' };

/** A saved result for exactly the run asked about (same model, method and engine build, complete), or nothing. */
export type RunLookup = { found: false } | { found: true; run_id: string; saved_at: string; record: ResultRecord };
export interface RunStatus {
  running: { request_id: string | null } | null;
  queued: { request_id: string | null }[];
}

export interface ModelInfo {
  name: string;
  bytes: number;
  modified: string;
}

export interface RunInfo {
  id: string;
  modified: string;
  status: string | null;
  completeness: string | null;
  method: string | null;
  top_event_probability: number | null;
  model_name: string | null;
  model_hash: string | null;
}

export interface SavedRun {
  id: string;
  model_text: string;
  record: unknown;
}

export type Method = 'exact' | 'rare-event' | 'mcub';

/** What the editor needs from the server. The editor takes this interface so tests can supply a fake. */
export interface Api {
  health(): Promise<{ name: string; runtime: RuntimeInfo; engines?: { builtin: { available: boolean; name: string; version: string; sha256?: string }; scram: RuntimeInfo } }>;
  validate(text: string): Promise<ValidateResponse>;
  run(text: string, method: Method, engine?: Engine, requestId?: string): Promise<RunResponse>;
  cancel(requestId?: string): Promise<{ cancelled: boolean }>;
  lookupRun(text: string, method: Method, engine: Engine): Promise<RunLookup>;
  runStatus(): Promise<RunStatus>;
  importance(text: string, requestId?: string): Promise<ImportanceResponse>;
  listModels(): Promise<ModelInfo[]>;
  loadModel(name: string): Promise<string>;
  saveModel(name: string, text: string): Promise<ModelInfo>;
  lessons(): Promise<Lesson[]>;
  importModel(text: string, name: string): Promise<ImportResponse>;
  listRuns(): Promise<RunInfo[]>;
  loadRun(id: string): Promise<SavedRun>;
}

/** Event trees (docs/plans/13-event-trees.md): what the server says about a document, and the answer to a run. */
export interface EtValidateResponse {
  valid: boolean;
  errors: EtIssue[];
  warnings: EtIssue[];
  modelChecked: boolean;
  tree_hash: string | null;
  document_hash: string;
}
export type EtRunResponse = { kind: 'ran'; run_id: string; record: EventTreeResult } | { kind: 'refused'; errors: EtIssue[]; warnings: EtIssue[] } | { kind: 'dequeued' };

/** A saved event-tree analysis, as the Compare list shows it. */
export interface EtRunInfo {
  id: string;
  modified: string;
  status: string | null;
  completeness: string | null;
  tree_name: string | null;
  initiating_event: string | null;
  frequency: number | null;
  total_frequency: number | null;
  tree_hash: string | null;
  model_hash: string | null;
  engine_name: string | null;
  engine_version: string | null;
}

/** The event-tree part of the API, apart from `Api` so the fault-tree editor and its tests are unchanged. */
export interface EtApi {
  validateEventTree(text: string): Promise<EtValidateResponse>;
  runEventTree(text: string, approximation: boolean, requestId?: string): Promise<EtRunResponse>;
  cancel(requestId?: string): Promise<{ cancelled: boolean }>;
  runStatus(): Promise<RunStatus>;
  listEventTrees(): Promise<ModelInfo[]>;
  listEventTreeRuns(): Promise<EtRunInfo[]>;
  loadEventTreeRun(id: string): Promise<{ id: string; record: unknown }>;
  loadEventTree(name: string): Promise<string>;
  saveEventTree(name: string, text: string): Promise<ModelInfo>;
  /** The saved fault-tree models the headings can refer to. */
  listModels(): Promise<ModelInfo[]>;
  loadModel(name: string): Promise<string>;
  validate(text: string): Promise<ValidateResponse>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function httpApi(base = ''): Api & EtApi {
  const call = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const init: RequestInit = { method, headers: { 'x-sneed-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(base + url, init);
    const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'E_HTTP', data?.error?.message ?? `request failed (${res.status})`);
    return data as T;
  };
  return {
    health: () => call('GET', '/api/health'),
    validate: (text) => call('POST', '/api/validate', { text }),
    run: (text, method, engine = 'builtin', requestId) => call('POST', '/api/run', { text, method, engine, ...(requestId ? { request_id: requestId } : {}) }),
    cancel: (requestId) => call('POST', '/api/run/cancel', requestId ? { request_id: requestId } : {}),
    lookupRun: (text, method, engine) => call('POST', '/api/run/lookup', { text, method, engine }),
    runStatus: () => call('GET', '/api/run/status'),
    importance: (text, requestId) => call('POST', '/api/importance', { text, ...(requestId ? { request_id: requestId } : {}) }),
    listModels: async () => (await call<{ models: ModelInfo[] }>('GET', '/api/models')).models,
    loadModel: async (name) => (await call<{ text: string }>('GET', `/api/models/${encodeURIComponent(name)}`)).text,
    listRuns: async () => (await call<{ runs: RunInfo[] }>('GET', '/api/runs')).runs,
    loadRun: (id) => call('GET', `/api/runs/${encodeURIComponent(id)}`),
    importModel: (text, name) => call('POST', '/api/import', { text, name }),
    lessons: async () => (await call<{ lessons: Lesson[] }>('GET', '/api/lessons')).lessons,
    saveModel: (name, text) => call('PUT', `/api/models/${encodeURIComponent(name)}`, { text }),
    validateEventTree: (text) => call('POST', '/api/event-tree/validate', { text }),
    runEventTree: (text, approximation, requestId) => call('POST', '/api/event-tree/run', { text, approximation, ...(requestId ? { request_id: requestId } : {}) }),
    listEventTreeRuns: async () => (await call<{ runs: EtRunInfo[] }>('GET', '/api/event-tree-runs')).runs,
    loadEventTreeRun: (id) => call('GET', `/api/event-tree-runs/${encodeURIComponent(id)}`),
    listEventTrees: async () => (await call<{ trees: ModelInfo[] }>('GET', '/api/event-trees')).trees,
    loadEventTree: async (name) => (await call<{ text: string }>('GET', `/api/event-trees/${encodeURIComponent(name)}`)).text,
    saveEventTree: (name, text) => call('PUT', `/api/event-trees/${encodeURIComponent(name)}`, { text }),
  };
}
