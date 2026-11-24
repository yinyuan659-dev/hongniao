import { HttpException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AiWalletService } from './ai-wallet.service';
import { costMicro, feeMicro, isOffpeak, priceOf } from './ai-price';

export interface AiMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiChatOptions {
  userId: bigint;
  /** deep / portrait … 明细里按它显示名字 */
  feature: string;
  /** 明细里合成一条的分组，例如 deep:12 */
  groupKey: string;
  messages: AiMsg[];
  maxTokens: number;
  /** 要求模型只输出 JSON */
  json?: boolean;
  temperature?: number;
}

export interface AiChatResult {
  content: string;
  /** 这次实际是谁付的 */
  payMode: 'platform' | 'own';
  /** 用户的 Key 出问题、按用户的设置自动改用了平台余额 */
  fellBack: boolean;
}

/**
 * AI 费用相关的拒绝：HTTP 402，带 reason 让客户端知道弹哪张提示。
 *   no_balance      平台余额不够
 *   need_key        选了「自己的 Key」但没填
 *   key_invalid     用户的 Key 失效 / 不对
 *   key_no_balance  用户的 Key 在 DeepSeek 那边没额度了
 *   ai_down         模型服务暂时用不了（不是用户的问题）
 */
export class AiPayException extends HttpException {
  constructor(public readonly reason: string, message: string) {
    super({ message, reason }, 402);
  }
}

/** 上游返回的错误，按 HTTP 状态分类 */
class UpstreamError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * 模型网关：所有要花钱的模型调用都从这里走。
 * 负责：选用谁的 Key（平台 / 用户自己的）→ 调 DeepSeek → 按返回的实际用量算钱 → 扣余额、记明细。
 * 日志只记用量和状态，不记对话内容。
 */
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger('AiGateway');

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: AiWalletService,
  ) {}

  private get base() {
    return (process.env.AI_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
  }

  get model() {
    return process.env.AI_MODEL ?? 'deepseek-flash';
  }

  async chat(o: AiChatOptions): Promise<AiChatResult> {
    const w = await this.wallet.get(o.userId);
    let mode: 'platform' | 'own' = w.payMode === 'own' ? 'own' : 'platform';
    let fellBack = false;
    if (mode === 'own' && !w.keyEnc) throw new AiPayException('need_key', '还没有填写你自己的 Key');

    let raw: { content: string; hit: number; miss: number; out: number };
    if (mode === 'platform') {
      this.assertPlatform(w.balance, o);
      raw = await this.callPlatform(o);
    } else {
      try {
        raw = await this.call(this.wallet.openKey(w.keyEnc), o);
      } catch (e) {
        const reason = e instanceof UpstreamError && e.status === 401 ? 'key_invalid' : e instanceof UpstreamError && e.status === 402 ? 'key_no_balance' : '';
        if (!reason) throw this.down(e);
        // 用户的 Key 出问题：打开了「自动改用平台余额」且余额够，就转平台代付；否则停下来让用户自己选
        if (!w.autoFallback) throw new AiPayException(reason, reason === 'key_invalid' ? '你的 Key 用不了，可能已失效' : '你的 Key 在 DeepSeek 的额度用完了');
        this.assertPlatform(w.balance, o);
        raw = await this.callPlatform(o);
        mode = 'platform';
        fellBack = true;
      }
    }

    await this.record(o, mode, raw);
    return { content: raw.content, payMode: mode, fellBack };
  }

  /** 测试一个 Key 能不能用：真的调一次，只要 1 个 token。返回 '' = 能用，否则是原因 */
  async testKey(key: string): Promise<'' | 'key_invalid' | 'key_no_balance' | 'ai_down'> {
    try {
      await this.post(key, { model: this.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, thinking: { type: 'disabled' }, stream: false }, 20_000);
      return '';
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 401) return 'key_invalid';
      if (e instanceof UpstreamError && e.status === 402) return 'key_no_balance';
      this.logger.warn(`测试 Key 失败: ${(e as Error).message}`);
      return 'ai_down';
    }
  }

  // ---------- 内部 ----------

  /** 用平台余额前的检查：平台配了 Key、用户余额够这次最多可能花的钱 */
  private assertPlatform(balance: bigint, o: AiChatOptions) {
    if (!process.env.AI_API_KEY) throw new AiPayException('ai_down', 'AI 服务还没有配置');
    // 最坏情况：输入全部没命中缓存（一个字按 1 个 token 算，偏多）、输出写满，按高峰价，再加手续费
    const chars = o.messages.reduce((s, m) => s + m.content.length, 0);
    const p = priceOf(this.model);
    const worst = Math.ceil(chars * p.miss + o.maxTokens * p.out);
    if (Number(balance) < worst + feeMicro(worst)) throw new AiPayException('no_balance', '余额不够了');
  }

  private async callPlatform(o: AiChatOptions) {
    try {
      return await this.call(process.env.AI_API_KEY!, o);
    } catch (e) {
      if (e instanceof UpstreamError && (e.status === 401 || e.status === 402)) {
        // 平台自己的 Key 失效 / 欠费：不是用户的问题，要运维处理
        this.logger.error(`平台的模型 Key 用不了（HTTP ${e.status}），请检查 AI_API_KEY 和 DeepSeek 账户余额`);
      }
      throw this.down(e);
    }
  }

  private down(e: unknown) {
    if (e instanceof AiPayException) return e;
    this.logger.warn(`模型调用失败: ${(e as Error).message}`);
    return new AiPayException('ai_down', 'AI 暂时不可用，请稍后再试');
  }

  /** 调一次模型；限流 / 上游故障重试一次 */
  private async call(key: string, o: AiChatOptions) {
    const body = {
      model: this.model,
      messages: o.messages,
      max_tokens: o.maxTokens,
      temperature: o.temperature ?? 0.8,
      stream: false,
      // 关掉「思考」：聊天和整理画像都不需要，开着会多花几倍的输出 token，也更慢
      thinking: { type: 'disabled' },
      ...(o.json ? { response_format: { type: 'json_object' } } : {}),
    };
    let data: any;
    try {
      data = await this.post(key, body, 60_000);
    } catch (e) {
      if (e instanceof UpstreamError && (e.status === 401 || e.status === 402 || e.status === 400)) throw e;
      data = await this.post(key, body, 60_000);
    }
    const content = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!content) throw new UpstreamError(502, '模型返回了空内容');
    const u = data?.usage ?? {};
    const hit = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0) || 0;
    const prompt = Number(u.prompt_tokens ?? 0) || 0;
    const miss = Number(u.prompt_cache_miss_tokens ?? Math.max(prompt - hit, 0)) || 0;
    const out = Number(u.completion_tokens ?? 0) || 0;
    return { content, hit, miss, out };
  }

  private async post(key: string, body: unknown, timeoutMs: number): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // 上游的报错里可能带着 Key 的片段，只留状态码和错误类型
        let type = '';
        try {
          type = String(((await res.json()) as any)?.error?.type ?? '');
        } catch {
          /* 不是 JSON 就算了 */
        }
        throw new UpstreamError(res.status, `上游 HTTP ${res.status} ${type}`);
      }
      return await res.json();
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError(0, (e as Error).name === 'AbortError' ? '上游超时' : `连不上上游: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 记用量；用平台余额的同时扣钱、记流水（同一个事务） */
  private async record(o: AiChatOptions, mode: 'platform' | 'own', r: { hit: number; miss: number; out: number }) {
    const requestId = randomUUID();
    const offpeak = isOffpeak();
    const cost = costMicro(this.model, r.hit, r.miss, r.out, offpeak);
    const fee = mode === 'platform' ? feeMicro(cost) : 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.aiUsage.create({
        data: {
          userId: o.userId, feature: o.feature, groupKey: o.groupKey, model: this.model,
          hitTokens: r.hit, missTokens: r.miss, outTokens: r.out, offpeak,
          costMicro: BigInt(cost), feeMicro: BigInt(fee), payMode: mode, requestId,
        },
      });
      if (mode !== 'platform') return;
      const total = BigInt(cost + fee);
      let after = (await tx.aiWallet.update({ where: { userId: o.userId }, data: { balance: { decrement: total } } })).balance;
      let charged = total;
      if (after < 0n) {
        // 调用前检查过余额，正常到不了这里；万一同时发了两个请求扣成负数，只扣到 0，差额平台承担
        charged = total + after;
        after = 0n;
        await tx.aiWallet.update({ where: { userId: o.userId }, data: { balance: 0n } });
      }
      await tx.aiLedger.create({ data: { userId: o.userId, type: 'usage', amount: -charged, balanceAfter: after, refKey: requestId, note: o.feature } });
    });
    this.logger.log(`uid=${o.userId} ${o.feature} ${mode} hit=${r.hit} miss=${r.miss} out=${r.out} cost=${cost} fee=${fee}`);
  }
}
