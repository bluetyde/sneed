import { XMLParser } from 'fast-xml-parser';

export const PARSER_VERSION = 'sneed-report-1';

export type ReportErrorCode = 'R_UNSAFE' | 'R_MALFORMED' | 'R_MISSING' | 'R_VALUE';

export class ReportError extends Error {
  constructor(
    readonly code: ReportErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface ReportProduct {
  order: number;
  probability: number;
  events: string[];
}

export interface ParsedReport {
  software: { name: string; version: string };
  /** Top-event probability as the engine printed it (about 6 significant digits). */
  probability: number;
  /** Set when the engine itself flagged the result, e.g. "The set is NULL/Empty.". */
  warning: string | null;
  products: ReportProduct[];
  /** Probability method as reported: "none" means exact; otherwise e.g. "rare-event", "mcub". */
  approximation: string | null;
  /** Product-order limit the engine echoed, or null if absent. */
  productOrderLimit: number | null;
  /** Names of the engine's qualitative and probability methods, as reported. */
  cutSetMethod: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  parseAttributeValue: false,
  parseTagValue: false,
  allowBooleanAttributes: false,
  isArray: (name) => ['product', 'basic-event', 'calculated-quantity', 'sum-of-products'].includes(name),
});

type Node = Record<string, unknown>;
const asNode = (v: unknown): Node | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Node) : undefined);
const attr = (n: Node | undefined, name: string): string | undefined => {
  const v = n?.[`@_${name}`];
  return typeof v === 'string' ? v : undefined;
};
const asArray = (v: unknown): Node[] => (Array.isArray(v) ? v.map((x) => asNode(x) ?? {}) : v === undefined ? [] : [asNode(v) ?? {}]);

function num(text: string | undefined, what: string): number {
  if (text === undefined || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text.trim())) throw new ReportError('R_VALUE', `${what} is not a number: ${JSON.stringify(text)}`);
  const v = Number(text);
  if (!Number.isFinite(v)) throw new ReportError('R_VALUE', `${what} is not finite`);
  return v;
}

/** Parses a SCRAM report. Never throws anything but ReportError. The text is data and is never interpreted. */
export function parseReport(text: string): ParsedReport {
  if (typeof text !== 'string' || text.trim() === '') throw new ReportError('R_MISSING', 'the report is empty');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(text)) throw new ReportError('R_UNSAFE', 'the report contains a DTD, entity or CDATA section');
  let tree: Node;
  try {
    tree = asNode(parser.parse(text, true)) ?? {};
  } catch (e) {
    throw new ReportError('R_MALFORMED', `not well-formed XML: ${(e as Error).message}`);
  }
  const report = asNode(tree.report);
  if (!report) throw new ReportError('R_MALFORMED', 'no <report> root element');
  const info = asNode(report.information);
  const software = asNode(info?.software);
  const name = attr(software, 'name');
  const version = attr(software, 'version');
  if (!name || !version) throw new ReportError('R_MISSING', 'no engine name and version in <information><software>');

  const results = asNode(report.results);
  const sums = asArray(results?.['sum-of-products']);
  if (sums.length !== 1) throw new ReportError('R_MISSING', `expected exactly one <sum-of-products>, found ${sums.length}`);
  const sum = sums[0]!;
  const probability = num(attr(sum, 'probability'), 'probability');
  const products: ReportProduct[] = asArray(sum.product).map((p, i) => {
    const events = asArray(p['basic-event']).map((b) => attr(b, 'name') ?? '');
    if (events.some((e) => e === '')) throw new ReportError('R_MALFORMED', `product ${i} has an unnamed event`);
    const order = num(attr(p, 'order'), `product ${i} order`);
    return { order, probability: num(attr(p, 'probability'), `product ${i} probability`), events };
  });

  let approximation: string | null = null;
  let productOrderLimit: number | null = null;
  let cutSetMethod: string | null = null;
  for (const q of asArray(info?.['calculated-quantity'])) {
    const qn = attr(q, 'name');
    if (qn === 'Probability Analysis') approximation = attr(q, 'approximation') ?? null;
    if (qn === 'Minimal Cut Sets') {
      const method = asNode(q['calculation-method']);
      cutSetMethod = attr(method, 'name') ?? null;
      const raw = asNode(method?.limits)?.['product-order'];
      if (typeof raw === 'string') productOrderLimit = num(raw, 'product-order limit');
    }
  }
  return { software: { name, version }, probability, warning: attr(sum, 'warning') ?? null, products, approximation, productOrderLimit, cutSetMethod };
}
