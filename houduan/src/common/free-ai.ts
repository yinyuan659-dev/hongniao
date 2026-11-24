import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { callModel } from './ai-model';

/**
 * BlockRun 免费模型（OpenAI 兼容，不用 Key、不付钱）：内容分发的英文翻译用它（10.15 起，原来走 DeepSeek）。
 *
 * - 免费模型在 BlockRun 列表里标着不可用，但实际能用，随时可能下线：按顺序换模型，全失败且配了 AI_API_KEY 才退回 DeepSeek。
 * - 推理模型的回答前面可能带 <think>…</think>，取 </think> 后面的。
 * - 同时最多 2 个请求；按请求内容（system + 原文 + 温度）的 sha256 在内存里缓存，后台预览后再应用拿到的是同一稿。
 * - 发出去的只有要翻译的文字（Telegram 公开频道内容 / 后台自己写的文案），不要传 Key、私钥、用户资料。
 */
const API = 'https://blockrun.ai/api/v1/chat/completions';
export const FREE_MODELS = ['nvidia/nemotron-3-ultra-550b', 'nvidia/nemotron-3.5-lightning', 'nvidia/muse-glimmer-30b', 'cohere/north-mini-code'];
const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 60_000;
const CACHE_MAX = 500;

type Msg = { role: string; content: string };
const logger = new Logger('FreeAI');
const cache = new Map<string, string>();

let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** 调一次某个免费模型，返回去掉 <think> 之后的回答 */
async function callFree(model: string, messages: Msg[], temperature: number | undefined, maxTokens: number): Promise<string> {
  return withSlot(async () => {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, ...(temperature != null ? { temperature } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const out = String(data?.choices?.[0]?.message?.content ?? '').split('</think>').pop()!.trim();
    if (!out) throw new Error('空回答');
    return out;
  });
}

/** 从回答里抠出 JSON 对象（模型可能包 ```json、前后带说明） */
export function extractJson(raw: string): any {
  const s = raw.split('</think>').pop()!.replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('回答里没有 JSON');
  return JSON.parse(s.slice(a, b + 1));
}

/**
 * 让免费模型按 JSON 回答，`parse` 负责取字段和校验（不合格就抛错，换下一个模型）。
 * 返回第一个通过校验的结果；全部失败抛错，错误信息里带每个模型的原因。
 */
export async function freeJson<T>(messages: Msg[], parse: (j: any) => T, opts: { temperature?: number; maxTokens?: number; label?: string } = {}): Promise<T> {
  const key = createHash('sha256').update(JSON.stringify([messages, opts.temperature ?? null])).digest('hex');
  const hit = cache.get(key);
  if (hit !== undefined) {
    try { return parse(extractJson(hit)); } catch { cache.delete(key); }
  }
  // 推理模型的 <think> 也占 token，给足
  const maxTokens = Math.min(8000, Math.max(4000, opts.maxTokens ?? 0));
  const errors: string[] = [];
  const keep = (raw: string, value: T) => {
    cache.set(key, raw);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return value;
  };
  for (const model of FREE_MODELS) {
    try {
      const raw = await callFree(model, messages, opts.temperature, maxTokens);
      return keep(raw, parse(extractJson(raw)));
    } catch (e: any) {
      errors.push(`${model}: ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  if (process.env.AI_API_KEY) {
    try {
      const raw = await callModel(messages, opts.temperature, opts.maxTokens ?? 1200);
      const value = parse(extractJson(raw));
      logger.warn(`${opts.label ?? 'freeJson'}: 免费模型都失败，已退回 DeepSeek（${errors.join('；')}）`);
      return keep(raw, value);
    } catch (e: any) {
      errors.push(`deepseek: ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  logger.warn(`${opts.label ?? 'freeJson'} failed: ${errors.join('；')}`);
  throw new Error(`免费模型都没给出可用结果（${errors.join('；')}）`);
}
