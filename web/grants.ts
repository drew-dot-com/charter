// The /grants page: the fund's address and balance, then one row per grant. Everything the door
// returns is escaped before it becomes HTML; a link is shown only when it is https.
export interface GrantRow {
  grantId: string;
  state: string;
  name: string;
  link?: string;
  image: string;
  createdAt: number;
  decidedAt?: number;
  summary?: string;
  reason?: string;
  leaseId?: string;
  paidHours: number;
  renewedByGrantee: boolean;
  updatedAt: number;
}
export interface GrantsData {
  grants: GrantRow[];
  fund: { address: string; balanceMicro: string | number; grantsLeft: number } | null;
}

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Micro-USDC (6 decimals) as a decimal string, by integer math: no float error. */
export function formatBalance(micro: string | number): string {
  let n: bigint;
  try {
    n = BigInt(micro);
  } catch {
    return 'unknown';
  }
  if (n < 0n) return 'unknown';
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${frac.length < 2 ? frac.padEnd(2, '0') : frac}`;
}

function day(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

function row(g: GrantRow): string {
  const link = typeof g.link === 'string' && g.link.startsWith('https://') ? ` <a href="${esc(g.link)}" rel="nofollow noopener noreferrer">link</a>` : '';
  const note = [g.summary, g.reason].filter((s): s is string => typeof s === 'string' && s !== '').map((s) => `<p>${esc(s)}</p>`).join('');
  const own = g.renewedByGrantee ? '<p><strong>renewed on its own money</strong></p>' : '';
  const hours = g.paidHours > 0 ? `<br>${esc(g.paidHours)} hours paid` : '';
  return `<tr><td class="mono">${esc(day(g.createdAt))}</td><td>${esc(g.name)}${link}${note}${own}</td><td>${esc(g.state)}${hours}</td></tr>`;
}

export function renderGrants(data: GrantsData): string {
  const f = data.fund;
  const fund = f
    ? `<p>Fund address on Base: <code>${esc(f.address)}</code></p><p>Balance: <strong>${esc(formatBalance(f.balanceMicro))} USDC</strong>. Grants left: <strong>${esc(f.grantsLeft)}</strong>.</p>`
    : '<p>The fund is not open yet. No grants can be made until it reports.</p>';
  const rows = data.grants.length
    ? `<table class="recent"><tr><th>date</th><th>grant</th><th>state</th></tr>${data.grants.map(row).join('')}</table>`
    : '<p>No pitches yet.</p>';
  return `<h2>The fund</h2>${fund}<h2>Every pitch</h2>${rows}`;
}

if (typeof document !== 'undefined') {
  const out = document.getElementById('grants');
  if (out) {
    fetch('/v1/grants')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: GrantsData) => {
        out.innerHTML = renderGrants(d);
      })
      .catch(() => {
        out.innerHTML = '<p>The grants list could not be loaded. Try again in a minute.</p>';
      });
  }
}
