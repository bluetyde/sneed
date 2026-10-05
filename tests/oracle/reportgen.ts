// Test-only: writes a report in the same layout SCRAM 0.16.2 produced in docs/spike/runs/*/report.xml,
// so failure paths can be fabricated. The parser is also checked against the real saved reports.
export interface FakeProduct {
  events: string[];
  probability: string;
  order?: number;
}

export interface FakeReport {
  version?: string;
  name?: string;
  probability?: string;
  approximation?: string | null;
  limit?: number | null;
  products?: FakeProduct[];
  warning?: string;
  extraSums?: number;
}

export function makeReport(r: FakeReport = {}): string {
  const products = r.products ?? [];
  const sum = (): string => {
    const warn = r.warning ? ` warning="${r.warning}"` : '';
    const body = products
      .map(
        (p) =>
          `      <product order="${p.order ?? p.events.length}" probability="${p.probability}" contribution="1">\n` +
          p.events.map((e) => `        <basic-event name="${e}"/>`).join('\n') +
          `\n      </product>`,
      )
      .join('\n');
    return `    <sum-of-products name="TOP"${warn} basic-events="0" products="${products.length}" probability="${r.probability ?? '0.1'}" distribution="1">\n${body}\n    </sum-of-products>`;
  };
  const sums = Array.from({ length: 1 + (r.extraSums ?? 0) }, sum).join('\n');
  const approx = r.approximation === null ? '' : ` approximation="${r.approximation ?? 'none'}"`;
  const limits = r.limit === null ? '' : `        <limits>\n          <product-order>${r.limit ?? 20}</product-order>\n        </limits>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<report>
  <information>
    <software name="${r.name ?? 'SCRAM'}" version="${r.version ?? '0.16.2'}" contacts="https://scram-pra.org"/>
    <time>2026-10-05T10:27:15</time>
    <calculated-quantity name="Minimal Cut Sets">
      <calculation-method name="Binary Decision Diagram">
${limits}      </calculation-method>
    </calculated-quantity>
    <calculated-quantity name="Probability Analysis" definition="x"${approx}>
      <calculation-method name="Binary Decision Diagram">
        <limits>
          <mission-time>8760</mission-time>
        </limits>
      </calculation-method>
    </calculated-quantity>
  </information>
  <results>
${sums}
  </results>
</report>
`;
}
