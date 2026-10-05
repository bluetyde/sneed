// Test-only: evaluates exported Open-PSA XML, so the exporter's logic can be checked without the engine.
// It parses the XML text itself and shares no code with src/core/export.ts.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  isArray: (name) => ['and', 'or', 'atleast', 'basic-event', 'gate', 'define-gate', 'define-basic-event'].includes(name),
});

type Node = Record<string, unknown>;
const KINDS = ['and', 'or', 'atleast', 'basic-event', 'gate'] as const;
type Kind = (typeof KINDS)[number];

export interface ParsedXml {
  /** gate name -> its define-gate node */
  gates: Map<string, Node>;
  /** basic event name -> probability text */
  events: Map<string, string>;
}

export function parseExported(xml: string): ParsedXml {
  const root = (parser.parse(xml) as Node)['opsa-mef'] as Node;
  const tree = root['define-fault-tree'] as Node;
  const gates = new Map<string, Node>();
  for (const g of (tree['define-gate'] as Node[] | undefined) ?? []) gates.set(String(g['@_name']), g);
  const events = new Map<string, string>();
  for (const e of (tree['define-basic-event'] as Node[] | undefined) ?? []) events.set(String(e['@_name']), String((e.float as Node)['@_value']));
  return { gates, events };
}

const children = (n: Node): [Kind, Node][] => KINDS.flatMap((k) => ((n[k] as Node[] | undefined) ?? []).map((c): [Kind, Node] => [k, c]));

/** The one gate that no other gate references. */
export function topGate(p: ParsedXml): string {
  const referenced = new Set<string>();
  const walk = (n: Node): void => {
    for (const [k, c] of children(n)) {
      if (k === 'gate') referenced.add(String(c['@_name']));
      else walk(c);
    }
  };
  for (const g of p.gates.values()) walk(g);
  const tops = [...p.gates.keys()].filter((name) => !referenced.has(name));
  if (tops.length !== 1) throw new Error(`expected exactly one unreferenced gate, found ${tops.length}`);
  return tops[0]!;
}

export function evaluateExported(p: ParsedXml, failed: ReadonlySet<string>): boolean {
  const evalNode = (kind: Kind, n: Node): boolean => {
    if (kind === 'basic-event') return failed.has(String(n['@_name']));
    if (kind === 'gate') return evalGate(String(n['@_name']));
    const vals = children(n).map(([k, c]) => evalNode(k, c));
    if (kind === 'and') return vals.every(Boolean);
    if (kind === 'or') return vals.some(Boolean);
    return vals.filter(Boolean).length >= Number(n['@_min']);
  };
  const evalGate = (name: string): boolean => {
    const vals = children(p.gates.get(name)!).map(([k, c]) => evalNode(k, c));
    if (vals.length !== 1) throw new Error(`gate ${name} must hold exactly one formula, has ${vals.length}`);
    return vals[0]!;
  };
  return evalGate(topGate(p));
}
