import OpenAI from 'openai';
import { config } from '../../../config';
import { AppError } from '../../../middlewares/error.middleware';
import { estimateTokens, withLease, type Classified } from '../../llm-budget';
import type { LlmErrorKind, LlmProvider, LlmRequest, ModelSpec, ProviderCompletion } from '../types';
import { LlmError } from '../types';

export interface OpenAILike {
  chat: {
    completions: {
      create(body: any, options?: any): Promise<any>;
    };
  };
}

const cache = new Map<string, OpenAI>();
let override: OpenAILike | null = null;

/** Test seam: route every OpenAI call to `client` (null restores the real SDK). */
export function setOpenAIClient(client: OpenAILike | null): OpenAILike | null {
  const prev = override;
  override = client;
  return prev;
}

function clientFor(spec: ModelSpec): OpenAILike {
  if (override) return override;
  const key = `${config.OPENAI_API_KEY}|${spec.baseUrl ?? config.OPENAI_BASE_URL}`;
  let client = cache.get(key);
  if (!client) {
    client = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      maxRetries: 0,
      ...(spec.baseUrl || config.OPENAI_BASE_URL
        ? { baseURL: spec.baseUrl || config.OPENAI_BASE_URL }
        : {}),
    });
    cache.set(key, client);
  }
  return client;
}

export function classifyOpenAIError(err: unknown): Classified {
  const message = (err as Error)?.message ?? '';
  if (/billing|quota|insufficient_quota|exceeded your current quota/i.test(message)) {
    return { outcome: 'quota' };
  }
  return { outcome: 'error' };
}

function mapError(err: unknown): LlmError {
  const status = (err as { status?: number })?.status;
  let kind: LlmErrorKind = 'server';
  if (status === 429) kind = 'rate_limited';
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 400) kind = 'invalid_request';
  else if ((err as { name?: string })?.name?.includes('Timeout')) kind = 'timeout';
  return new LlmError(kind, 'openai', `OpenAI-compatible call failed: ${(err as Error)?.message ?? String(err)}`, undefined, [], err);
}

export const openaiProvider: LlmProvider = {
  name: 'openai',
  available: () => override !== null || Boolean(config.OPENAI_API_KEY),
  async complete(spec, req: LlmRequest): Promise<ProviderCompletion> {
    const json = req.mode === 'json';
    const promptOnlyJson = json && spec.jsonMode === 'prompt';
    const maxTokens = Math.min(req.maxTokens ?? spec.maxTokens, spec.maxTokens);
    let completion: any;
    try {
      const client = clientFor(spec);
      completion = await withLease(
        'openai',
        req.ctx,
        estimateTokens(req, maxTokens),
        async () => {
          const res = await client.chat.completions.create(
            {
              model: spec.model,
              temperature: spec.temperature,
              max_tokens: maxTokens,
              messages: [
                { role: 'system', content: promptOnlyJson ? `${req.system}\n\nReturn only a valid JSON object.` : req.system },
                { role: 'user', content: req.user },
              ],
              ...(json && !promptOnlyJson ? { response_format: { type: 'json_object' as const } } : {}),
            },
            { timeout: spec.timeoutMs, signal: req.signal },
          );
          return {
            value: res,
            usage: {
              inputTokens: res.usage?.prompt_tokens ?? 0,
              outputTokens: res.usage?.completion_tokens ?? 0,
              model: spec.model,
            },
          };
        },
        { signal: req.signal, classify: classifyOpenAIError },
      );
    } catch (err) {
      if (err instanceof LlmError || err instanceof AppError) throw err;
      throw mapError(err);
    }

    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) throw new LlmError('empty', 'openai', 'OpenAI-compatible provider returned an empty response', undefined, []);
    return {
      text,
      usage: {
        inputTokens: completion.usage?.prompt_tokens,
        outputTokens: completion.usage?.completion_tokens,
      },
    };
  },
};
