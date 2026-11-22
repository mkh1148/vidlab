import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';
import { getKey, type KeyName } from '../keystore.ts';
import {
  requireLlmProvider,
  llmProviderPreset,
  protocolForProvider,
  type LlmProvider,
} from '../../shared/llm-providers.ts';
import { resolveLlmProviderConfig } from '../llm-config.ts';
import { xaiOauthAccessToken } from '../xai-oauth-session.ts';
import { proxyMiddleware } from '../proxy.ts';
import { localized } from '../ui-locale.ts';

function keyReader(name: string): string {
  return getKey(name as KeyName);
}

export function llmProviderForRequest(req?: IncomingMessage): LlmProvider {
  const requested = req?.headers['x-openchatcut-provider'];
  return requireLlmProvider(requested === undefined ? getKey('LLM_PROVIDER') : requested);
}

export function llmTarget(req?: IncomingMessage): string {
  return resolveLlmProviderConfig(llmProviderForRequest(req), keyReader).baseUrl;
}

export function llmHeaders(req?: IncomingMessage): Record<string, string> {
  const config = resolveLlmProviderConfig(llmProviderForRequest(req), keyReader);
  if (config.provider === 'xai-oauth') {
    // OAuth requests only trust the active in-memory session. API-key accounts
    // use the separate xai provider and LLM_XAI_API_KEY slot.
    const token = xaiOauthAccessToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }
  if (!config.apiKey) return {};
  const protocol = protocolForProvider(config.provider);
  if (protocol === 'anthropic') return { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' };
  if (protocol === 'google') return { 'x-goog-api-key': config.apiKey };
  return { authorization: `Bearer ${config.apiKey}` };
}

export function llmErrorMessage(status: number, req?: IncomingMessage): string {
  const provider = llmProviderForRequest(req);
  const label = llmProviderPreset(provider).label;
  // The browser renders this body verbatim in the chat, so it follows the
  // interface language the browser mirrored (server/ui-locale.ts) instead of
  // always answering in the original Chinese.
  if (provider === 'xai-oauth' && (status === 401 || status === 403)) {
    return status === 403
      ? localized({
        zh: 'xAI 拒绝了订阅会话的 API 访问（当前订阅档位可能未开放）。可升级订阅，或改在“设置 → Agent 模型 → xAI Grok”页配置 API Key 使用。',
        en: 'xAI refused API access for the subscription session (the current plan may not include it). Upgrade the plan, or set an API key under Settings → Agent model → xAI Grok.',
      })
      : localized({
        zh: 'xAI 订阅会话已失效。请在终端运行 grok login 重新登录，然后在“设置 → Agent 模型 → xAI Grok (订阅登录)”页点击导入。',
        en: 'The xAI subscription session has expired. Run grok login in a terminal, then click Import under Settings → Agent model → xAI Grok (subscription login).',
      });
  }
  if (status === 401 || status === 403) {
    return localized({
      zh: `${label} 认证失败。请在“设置 → Agent 模型”中检查 API Key。`,
      en: `${label} authentication failed. Check the API key under Settings → Agent model.`,
    });
  }
  if (status === 402 || status === 429) {
    return localized({
      zh: `${label} 额度不足或请求过于频繁。请检查账户额度，稍后重试。`,
      en: `${label} is out of quota or rate limited. Check the account balance and try again later.`,
    });
  }
  if (status === 404) {
    return localized({
      zh: `${label} 的接口或模型不存在。请检查 Base URL 和模型名称。`,
      en: `${label} endpoint or model not found. Check the base URL and the model name.`,
    });
  }
  if (status >= 500) {
    return localized({
      zh: `${label} 服务暂时不可用（HTTP ${status}）。请稍后重试或切换模型。`,
      en: `${label} is temporarily unavailable (HTTP ${status}). Try again later or switch models.`,
    });
  }
  return localized({
    zh: `${label} 请求失败（HTTP ${status}）。请检查“设置 → Agent 模型”中的连接配置。`,
    en: `${label} request failed (HTTP ${status}). Check the connection settings under Settings → Agent model.`,
  });
}

/** One dynamic proxy implementation shared by Vite dev and Electron production. */
export function llmProxyPlugin(): Plugin {
  return {
    name: 'openchatcut-llm-proxy',
    configureServer(server) {
      server.middlewares.use('/llm', (req, res, next) => {
        try {
          llmProviderForRequest(req);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Unsupported LLM provider' } }));
          return;
        }
        next();
      });
      server.middlewares.use('/llm', proxyMiddleware({
        target: llmTarget,
        headers: llmHeaders,
        forceJsonContentType: true,
        errorMessage: llmErrorMessage,
      }));
    },
  };
}
