// P3 · Host allowlist for the production server.
//
// The base authorizes *writes* by request shape (server/plugins/request-shape-gate.ts)
// but leaves every read open: a page that resolves a foreign name to 127.0.0.1
// (DNS rebinding) can read the local API — including the endpoints that list
// stored provider keys — because the server never looks at the Host header.
//
// This guard is therefore the FIRST middleware of the production server and it
// answers before any route, static or API, can run. Loopback only (owner
// decision D-8): localhost names, the loopback IP literals, plus whatever the
// machine's own configuration names as the editor host.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const ALLOWED_HOSTS_ENV = 'OPENCHATCUT_ALLOWED_HOSTS';
export const EDITOR_URL_ENV = 'OPENCHATCUT_EDITOR_URL';

/** Host names that always mean "this machine". Brackets are stripped before the
 *  comparison, so `[::1]:5199` and `::1` both match. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/** Characters that can never appear in a Host header; their presence means the
 *  value was smuggled past a proxy or is an absolute-form request target. */
const ILLEGAL_HOST_CHARS = /[/\\@?#,\s]/;

export interface ParsedHost {
  /** Lowercased hostname without the port and without IPv6 brackets. */
  readonly hostname: string;
  /** Port as written, or null when the header carried none. */
  readonly port: string | null;
}

/** A Host port must be a real TCP port; anything else is a malformed header. */
function validPort(port: string): boolean {
  if (!/^\d{1,5}$/.test(port)) return false;
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Split a Host header into hostname and port. Returns null for a missing,
 * malformed, or absolute-form value: an unparseable Host is a denial, never a
 * pass-through.
 */
export function parseHostHeader(raw: string | undefined): ParsedHost | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || ILLEGAL_HOST_CHARS.test(value)) return null;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0) return null;
    const hostname = value.slice(1, close).toLowerCase();
    const rest = value.slice(close + 1);
    if (!rest) return { hostname, port: null };
    if (!rest.startsWith(':')) return null;
    const port = rest.slice(1);
    return validPort(port) ? { hostname, port } : null;
  }
  const colon = value.lastIndexOf(':');
  // A bare IPv6 literal without brackets is not a valid Host header.
  if (colon === -1) return { hostname: value.toLowerCase(), port: null };
  if (value.indexOf(':') !== colon) return null;
  const hostname = value.slice(0, colon).toLowerCase();
  const port = value.slice(colon + 1);
  if (!hostname || !validPort(port)) return null;
  return { hostname, port };
}

/** Hostname of a configured editor URL, or null when it is unset or unusable. */
function configuredEditorHostname(editorUrl: string | undefined): string | null {
  const raw = editorUrl?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Configured extra host names: comma-separated, lowercased, blanks dropped. */
export function configuredHostAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && !ILLEGAL_HOST_CHARS.test(entry))
    .map((entry) => (entry.startsWith('[') && entry.endsWith(']') ? entry.slice(1, -1) : entry));
}

export interface HostAllowlistOptions {
  readonly extraHosts?: readonly string[];
  readonly editorUrl?: string;
}

/** The complete allowlist: loopback names plus the machine's configured hosts. */
export function hostAllowlist(options: HostAllowlistOptions = {}): ReadonlySet<string> {
  const allowed = new Set<string>(LOOPBACK_HOSTNAMES);
  const editor = configuredEditorHostname(options.editorUrl);
  if (editor) allowed.add(editor);
  for (const host of options.extraHosts ?? []) allowed.add(host.toLowerCase());
  return allowed;
}

export function hostAllowed(hostHeader: string | undefined, options: HostAllowlistOptions = {}): boolean {
  const parsed = parseHostHeader(hostHeader);
  if (!parsed) return false;
  return hostAllowlist(options).has(parsed.hostname);
}

type GuardNext = () => unknown;

/**
 * First-middleware Host guard. A foreign or missing Host gets 403 on every
 * route, static and API alike; an allowed one continues down the chain.
 *
 * `options` is read per request so a settings change takes effect without a
 * restart, exactly like the base's other env-driven getters.
 */
export type HostGuardMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: GuardNext,
) => void;

export function hostGuardMiddleware(
  options: () => HostAllowlistOptions = () => ({
    extraHosts: configuredHostAllowlist(process.env[ALLOWED_HOSTS_ENV]),
    editorUrl: process.env[EDITOR_URL_ENV],
  }),
): HostGuardMiddleware {
  return (req, res, next) => {
    const host = req.headers.host;
    if (hostAllowed(typeof host === 'string' ? host : undefined, options())) {
      next();
      return;
    }
    // Drain the request body so a rejected upload cannot hold the socket open.
    req.resume();
    res.writeHead(403, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'host not allowed' }));
  };
}
