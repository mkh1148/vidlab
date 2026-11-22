import { ProxyAgent } from 'undici';
import { environmentProxyUrl } from './outbound-proxy.ts';
import { getKey } from './keystore.ts';
import { checkDataDir, readDataDirPointer } from './data-dir.ts';
import { DATA_DIR_ENV, defaultRootDir, runtimeProfile } from './runtime-profile.ts';
import { networkDetail, type ProbeResult } from './key-probe-result.ts';
import { localized } from './ui-locale.ts';

export const PROBE_TIMEOUT_MS = 12_000;
const PROXY_PROBE_URL = 'https://www.gstatic.com/generate_204';

function proxyProbeUrl(overrides: Record<string, unknown>): string {
  if (Object.hasOwn(overrides, 'PROXY_URL')) return String(overrides.PROXY_URL ?? '').trim();
  return getKey('PROXY_URL').trim() || environmentProxyUrl();
}

/** Storage-root writability check: a local disk probe, never a network request. */
export async function runDataDirProbe(overrides: Record<string, unknown>): Promise<ProbeResult> {
  const profile = runtimeProfile();
  if (process.env[DATA_DIR_ENV]?.trim()) {
    return {
      ok: false,
      message: localized({
        zh: `目录由 ${DATA_DIR_ENV} 固定，无法在设置中修改`,
        en: `The directory is pinned by ${DATA_DIR_ENV} and cannot be changed in settings`,
      }),
    };
  }
  const raw = Object.hasOwn(overrides, DATA_DIR_ENV)
    ? String(overrides[DATA_DIR_ENV] ?? '')
    : readDataDirPointer() ?? '';
  const started = Date.now();
  const body = await checkDataDir(raw, defaultRootDir(profile));
  const latencyMs = Date.now() - started;
  return body.ok
    ? {
      ok: true,
      latencyMs,
      message: body.note ? localized(body.note) : localized({ zh: '目录可写', en: 'The directory is writable' }),
    }
    : {
      ok: false,
      latencyMs,
      message: body.error ? localized(body.error) : localized({ zh: '目录检查失败', en: 'The directory check failed' }),
    };
}

/** Test the saved proxy or the unsaved value currently shown in the settings field. */
export async function runProxyProbe(overrides: Record<string, unknown>): Promise<ProbeResult> {
  const proxyUrl = proxyProbeUrl(overrides);
  if (!proxyUrl) {
    return {
      ok: false,
      message: localized({
        zh: '尚未填写代理地址，且未检测到系统代理环境变量',
        en: 'No proxy address is set and no system proxy environment variable was found',
      }),
    };
  }
  let dispatcher: ProxyAgent;
  try {
    dispatcher = new ProxyAgent(proxyUrl);
  } catch {
    return {
      ok: false,
      message: localized({
        zh: '代理地址格式无效，请填写 http://host:port 或 https://host:port',
        en: 'The proxy address is not valid — use http://host:port or https://host:port',
      }),
    };
  }
  const started = Date.now();
  try {
    const response = await fetch(PROXY_PROBE_URL, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), dispatcher,
    } as RequestInit);
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        latencyMs,
        message: localized({
          zh: `代理已连接，但外网探测返回 HTTP ${response.status}`,
          en: `The proxy answered, but the outbound probe returned HTTP ${response.status}`,
        }),
      };
    }
    return {
      ok: true,
      status: response.status,
      latencyMs,
      message: localized({
        zh: `代理连接成功 · 外网可达 · ${latencyMs}ms`,
        en: `Proxy connected · the internet is reachable · ${latencyMs}ms`,
      }),
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, message: proxyNetworkMessage(error) };
  } finally {
    await dispatcher.close();
  }
}

function proxyNetworkMessage(error: unknown): string {
  const detail = networkDetail(error);
  return localized({ zh: `代理连接失败 · ${detail}`, en: `Proxy connection failed · ${detail}` });
}
