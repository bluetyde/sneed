// The browser's side of the local API (src/server/app.ts). Types only come from the core; no core code runs in the browser.
import type { Lesson } from '../core/lesson.js';
import type { ResultRecord } from '../core/result.js';

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

export type RunResponse = { kind: 'ran'; run_id: string; record: ResultRecord } | { kind: 'refused'; errors: Issue[]; warnings: Issue[] };

export interface ModelInfo {
  name: string;
  bytes: number;
  modified: string;
}

export type Method = 'exact' | 'rare-event' | 'mcub';

/** What the editor needs from the server. The editor takes this interface so tests can supply a fake. */
export interface Api {
  health(): Promise<{ name: string; runtime: RuntimeInfo }>;
  validate(text: string): Promise<ValidateResponse>;
  run(text: string, method: Method): Promise<RunResponse>;
  cancel(): Promise<{ cancelled: boolean }>;
  listModels(): Promise<ModelInfo[]>;
  loadModel(name: string): Promise<string>;
  saveModel(name: string, text: string): Promise<ModelInfo>;
  lessons(): Promise<Lesson[]>;
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

export function httpApi(base = ''): Api {
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
    run: (text, method) => call('POST', '/api/run', { text, method }),
    cancel: () => call('POST', '/api/run/cancel', {}),
    listModels: async () => (await call<{ models: ModelInfo[] }>('GET', '/api/models')).models,
    loadModel: async (name) => (await call<{ text: string }>('GET', `/api/models/${encodeURIComponent(name)}`)).text,
    lessons: async () => (await call<{ lessons: Lesson[] }>('GET', '/api/lessons')).lessons,
    saveModel: (name, text) => call('PUT', `/api/models/${encodeURIComponent(name)}`, { text }),
  };
}
