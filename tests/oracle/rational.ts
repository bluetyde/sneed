// Exact rational arithmetic for the test-only oracle. Test code only: never imported from src/.

export class Q {
  private constructor(
    readonly n: bigint,
    readonly d: bigint,
  ) {}

  static make(n: bigint, d: bigint): Q {
    if (d === 0n) throw new Error('zero denominator');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n < 0n ? -n : n, d);
    return g > 1n ? new Q(n / g, d / g) : new Q(n, d);
  }
  static readonly ZERO = new Q(0n, 1n);
  static readonly ONE = new Q(1n, 1n);

  add(o: Q): Q {
    return Q.make(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Q): Q {
    return Q.make(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Q): Q {
    return Q.make(this.n * o.n, this.d * o.d);
  }
  cmp(o: Q): number {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o: Q): boolean {
    return this.cmp(o) === 0;
  }
  /** Decimal expansion truncated (not rounded) to `digits` fractional digits. */
  toDecimal(digits = 30): string {
    const neg = this.n < 0n;
    const n = neg ? -this.n : this.n;
    const scale = 10n ** BigInt(digits);
    const scaled = (n * scale) / this.d;
    const s = scaled.toString().padStart(digits + 1, '0');
    const int = s.slice(0, s.length - digits);
    const frac = s.slice(s.length - digits);
    return (neg ? '-' : '') + int + (digits ? '.' + frac : '');
  }
  toNumber(): number {
    return Number(this.toDecimal(40));
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** A finite double as the exact decimal it prints as: value = a / 10^s. */
export function parseDecimal(x: number): { a: bigint; s: number } {
  if (!Number.isFinite(x)) throw new Error('non-finite probability');
  const text = JSON.stringify(x); // shortest round-trip, e.g. "0.021025", "1e-7", "4.76837e-7"
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(text);
  if (!m) throw new Error('cannot parse number ' + text);
  const frac = m[3] ?? '';
  let a = BigInt(m[2]! + frac);
  let s = frac.length - Number(m[4] ?? '0');
  if (s < 0) {
    a *= 10n ** BigInt(-s);
    s = 0;
  }
  if (m[1]) a = -a;
  return { a, s };
}

export const qFromNumber = (x: number): Q => {
  const { a, s } = parseDecimal(x);
  return Q.make(a, 10n ** BigInt(s));
};
