/** The part of a validated native document that analysis needs (docs/SCHEMA.md). */
export interface NativeModel {
  schema: { id: string; version: number };
  assumptions: Record<string, unknown>;
  top: string;
  events: { id: string; probability: number }[];
  gates: { id: string; type: 'and' | 'or' | 'atleast'; inputs: string[]; threshold?: number }[];
  /** Common-cause groups (plan 15). No engine expands them yet, so every analysis refuses a model that has some. */
  common_cause_groups?: { id: string; method: 'beta-factor'; members: string[]; beta: number }[];
}

export type Method = 'exact' | 'rare-event' | 'mcub';

export interface Settings {
  method: Method;
  /** SCRAM product-order limit. The default (reachable event count) cannot drop a cut set. */
  limitOrder: number;
}
