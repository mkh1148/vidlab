import { localized } from './ui-locale.ts';

export interface ProbeResult {
  ok: boolean;
  message: string;
  status?: number;
  latencyMs?: number;
  models?: string[];
}

export function parseModelCatalog(bodyText: string): string[] {
  try {
    const body = JSON.parse(bodyText) as {
      data?: Array<{ id?: unknown; name?: unknown }>;
      models?: Array<{ id?: unknown; name?: unknown }>;
    };
    const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
    return [...new Set(rows
      .map((row) => typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : '')
      .map((id) => id.trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Cheaper Inference also lists image/video models; chat keeps text and untyped rows. */
export function parseTextModelCatalog(bodyText: string): string[] {
  try {
    const body = JSON.parse(bodyText) as { data?: Array<{ type?: unknown } | null> };
    if (!Array.isArray(body.data)) return parseModelCatalog(bodyText);
    const data = body.data.filter((row) => row != null && (row.type === undefined || row.type === 'text'));
    return parseModelCatalog(JSON.stringify({ data }));
  } catch {
    return [];
  }
}

export function sanitizeProbeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** MiniMax: HTTP 200 may also cause authentication failure, the truth is in base_resp.status_code(0 = success).*/
export function minimaxPostCheck(bodyText: string): string | null {
  try {
    const body = JSON.parse(bodyText) as { base_resp?: { status_code?: number; status_msg?: string } };
    const code = body.base_resp?.status_code ?? 0;
    if (code === 0) return null;
    const msg = body.base_resp?.status_msg ?? '';
    const hint = code === 1004
      ? localized({ zh: '（鉴权失败，检查 Key）', en: ' (authentication failed — check the key)' })
      : '';
    return `MiniMax base_resp ${code}${msg ? ` · ${sanitizeProbeText(msg)}` : ''}${hint}`;
  } catch {
    return null; // Non-JSON 2xx are counted as successful
  }
}

/** Doubao 音频生成新版接口：HTTP 200 也可能带业务 code，非 0 即失败。 */
export function doubaoPostCheck(bodyText: string): string | null {
  try {
    const body = JSON.parse(bodyText) as { code?: number; message?: string };
    if (body.code == null || body.code === 0) return null;
    const hint = body.code === 401 || body.code === 403
      ? localized({ zh: '（鉴权失败，检查 API Key）', en: ' (authentication failed — check the API key)' })
      : '';
    return `Doubao ${body.code}${body.message ? ` · ${sanitizeProbeText(body.message)}` : ''}${hint}`;
  } catch {
    return null; // Non-JSON 2xx are counted as successful
  }
}

/** Convert a provider response into a user-facing connectivity conclusion. */
export function classifyStatus(status: number, bodyText: string): ProbeResult {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status,
      message: localized({
        zh: `鉴权失败（HTTP ${status}）· Key 无效、过期或无此接口权限`,
        en: `Authentication failed (HTTP ${status}) · the key is invalid, expired, or not allowed on this endpoint`,
      }),
    };
  }
  if (status === 404) {
    return {
      ok: false,
      status,
      message: localized({
        zh: '探测端点 404 · Base URL 可能填错（或该服务不认此探测路径）',
        en: 'Probe endpoint returned 404 · the base URL may be wrong (or this service does not answer this path)',
      }),
    };
  }
  if (status === 429) {
    return {
      ok: true,
      status,
      message: localized({
        zh: '鉴权通过（HTTP 429 限流，说明 Key 有效）',
        en: 'Authentication passed (HTTP 429 rate limit, which means the key is valid)',
      }),
    };
  }
  const detail = sanitizeProbeText(bodyText);
  return { ok: false, status, message: `HTTP ${status}${detail ? ` · ${detail}` : ''}` };
}

/** What went wrong in transport terms, before any reassurance about the key. */
function networkConclusion(error: unknown): { zh: string; en: string } {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}${error.cause instanceof Error ? `（${error.cause.message}）` : ''}`
    : String(error);
  if (/timeout|abort/i.test(raw)) {
    return {
      zh: '连接超时 · 服务不可达或网络受限（可能需代理）',
      en: 'Connection timed out · the service is unreachable or the network is restricted (a proxy may be needed)',
    };
  }
  return {
    zh: `网络不可达 · ${sanitizeProbeText(raw)} · 本机连不上该服务（可能需代理）`,
    en: `Network unreachable · ${sanitizeProbeText(raw)} · this machine cannot reach the service (a proxy may be needed)`,
  };
}

/** The transport failure alone, for a caller that prefixes its own context. */
export function networkDetail(error: unknown): string {
  return localized(networkConclusion(error));
}

/** Distinguish transport failures from rejected credentials. */
export function networkMessage(error: unknown): string {
  const conclusion = networkConclusion(error);
  return localized({
    zh: `${conclusion.zh}，不代表 Key 错误`,
    en: `${conclusion.en}; this does not mean the key is wrong`,
  });
}
