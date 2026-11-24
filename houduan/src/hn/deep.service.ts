import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { AiGatewayService, AiMsg } from '../ai/ai-gateway.service';
import { AiWalletService } from '../ai/ai-wallet.service';
import { HnService } from './hn.service';
import {
  CONFIRMED, DRAFT_READY, ESTIMATE_YUAN, MAX_INPUT, MAX_TURNS_PER_TOPIC, MIN_TURNS_PER_TOPIC, OPENING, PORTRAIT_PROMPT, PORTRAIT_ROWS, RESUME,
  SYSTEM_PROMPT, TOPICS, directive, profilePrompt,
} from './deep.prompt';

/** AI 整理出来的画像：一句话 + 标签 + 若干行 */
export interface DeepPortrait {
  summary: string;
  tags: string[];
  rows: { key: string; label: string; value: string }[];
}

const SKIP_TEXT = '先不说';
const NEXT_TEXT = '换个话题';

/**
 * AI 深聊：真的大模型在问、在接话。六个话题按顺序聊，聊完整理成画像，用户确认后生效。
 * 可选功能：不做也不影响被推荐和找人聊天（必做的是点选问答，见 hn.service.ts）。
 * 每次模型调用都从 AiGatewayService 走，由它扣费、记明细。
 */
@Injectable()
export class DeepService {
  private readonly logger = new Logger('Deep');
  /** 每个用户同一时间只处理一个请求，防止连点重复扣费 */
  private readonly inflight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly gateway: AiGatewayService,
    private readonly wallet: AiWalletService,
    private readonly hn: HnService,
  ) {}

  /** 当前这一场深聊的全部状态（聊天页进来、每次操作后都返回这个） */
  async state(userId: bigint) {
    const [session, profile, wallet] = await Promise.all([
      this.latest(userId),
      this.prisma.profile.findUnique({ where: { userId }, select: { confirmedAt: true, deepConfirmedAt: true } }),
      this.wallet.view(userId),
    ]);
    const base = {
      /** 必须先做完点选问答才能深聊 */
      profileDone: !!profile?.confirmedAt,
      topics: TOPICS.map((t) => t.name),
      /** 开始前告诉用户大概花多少（元） */
      estimate: ESTIMATE_YUAN,
      wallet: { balance: wallet.balance, payMode: wallet.payMode, hasKey: !!wallet.key, feePercent: wallet.feePercent },
    };
    if (!session) {
      return { ...base, status: 'none' as const, topic: 0, messages: [], pending: false, canFinish: false, spent: null };
    }
    const rows = await this.prisma.deepMessage.findMany({ where: { sessionId: session.id }, orderBy: { id: 'asc' } });
    const messages = rows.map((m) => ({ id: m.id, role: m.role, text: this.crypto.open(m.cipher), quick: (m.quick as string[] | null) ?? [], topic: m.topic }));
    const userTurns = rows.filter((m) => m.role === 'user').length;
    return {
      ...base,
      /** chatting 聊天中 | draft 画像等确认 | done 已确认 */
      status: session.status as 'chatting' | 'draft' | 'done',
      /** 聊到第几个话题；等于话题总数 = 都聊过了，在自由补充 */
      topic: session.topic,
      messages,
      /** 最后一句是用户说的、AI 还没回（上次调用失败了，比如余额不够）：解决后点「继续」重新让 AI 回 */
      pending: session.status === 'chatting' && rows.length > 0 && rows[rows.length - 1].role === 'user',
      /** 聊了至少两轮就可以直接出画像 */
      canFinish: session.status === 'chatting' && userTurns >= 2,
      spent: await this.wallet.groupSpent(userId, [`deep:${session.id}`, `portrait:${session.id}`]),
    };
  }

  /** 开始一场深聊（已经有进行中的就接着那一场） */
  async start(userId: bigint) {
    await this.mustProfile(userId);
    const cur = await this.latest(userId);
    if (!cur || cur.status === 'done') await this.open(userId);
    return this.state(userId);
  }

  /** 重新聊：开一场新的，没确认的草稿作废（已经确认的画像不动） */
  async restart(userId: bigint) {
    await this.mustProfile(userId);
    await this.prisma.profile.update({ where: { userId }, data: { deepDraft: Prisma.DbNull } });
    await this.open(userId);
    return this.state(userId);
  }

  /**
   * 用户说一句（或点现成回答 / 先不说 / 换个话题），AI 回一句。
   * text 为空 = 「继续」：上次 AI 没回成（余额不够等），重新让 AI 回最后那句话。
   */
  async message(userId: bigint, body: { text?: string; action?: string }) {
    return this.exclusive(userId, async () => {
      const session = await this.latest(userId);
      if (!session || session.status !== 'chatting') throw new BadRequestException('这场聊天已经结束了');
      const action = body.action === 'skip' || body.action === 'next' ? body.action : '';
      const text = clean(action === 'skip' ? SKIP_TEXT : action === 'next' ? NEXT_TEXT : String(body.text ?? ''));
      if (text.length > MAX_INPUT) throw new BadRequestException(`一次最多说 ${MAX_INPUT} 个字`);

      const rows = await this.prisma.deepMessage.findMany({ where: { sessionId: session.id }, orderBy: { id: 'asc' } });
      const pending = rows.length > 0 && rows[rows.length - 1].role === 'user';
      if (!text && !pending) throw new BadRequestException('说点什么吧');
      // AI 自己以前说的话，按它要输出的 JSON 格式放回去。直接放大白话的话，模型会学着也输出大白话，
      // 而接口又被限定成只能出 JSON，结果就是返回一串空格（2026-11-23 实测）
      const history: AiMsg[] = rows.map((m) => {
        const text = this.crypto.open(m.cipher);
        if (m.role !== 'ai') return { role: 'user' as const, content: text };
        return { role: 'assistant' as const, content: JSON.stringify({ reply: text, quick: (m.quick as string[] | null) ?? [], topic: m.topic, done: false, flag: '' }) };
      });
      // 先把用户这句话存下来：就算接下来模型调用失败（余额不够），说过的话也不丢
      if (text) {
        await this.prisma.deepMessage.create({ data: { sessionId: session.id, role: 'user', cipher: this.crypto.seal(text), topic: session.topic } });
        history.push({ role: 'user', content: text });
      }

      const extra = session.topic >= TOPICS.length;
      const turns = session.turns + 1;
      const lastText = history[history.length - 1].content;
      const forceNext = action === 'next' || lastText === NEXT_TEXT;
      const brief = await this.hn.brief(userId);
      const result = await this.gateway.chat({
        userId, feature: 'deep', groupKey: `deep:${session.id}`, json: true, maxTokens: 400,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'system', content: profilePrompt(brief.nickname, brief.gender, brief.summary, brief.intro) },
          ...history,
          { role: 'system', content: directive({ topic: session.topic, turns, skip: action === 'skip' || lastText === SKIP_TEXT, forceNext, extraTurns: extra ? turns : 0 }) },
        ],
      });

      const out = parseReply(result.content);
      // 用户说了自己的严重问题：马上记下来（不等聊完、不等确认），之后重新聊也不会消失
      if (out.flag) await this.addFlags(userId, [out.flag]);
      // 话题怎么走由服务端说了算，模型只是建议：只能留在当前话题或进下一个，到轮数上限必须换
      let topic = session.topic;
      let done = false;
      if (extra) {
        done = out.done;
      } else {
        const last = session.topic === TOPICS.length - 1;
        const mustMove = forceNext || turns >= MAX_TURNS_PER_TOPIC;
        const mayMove = turns >= MIN_TURNS_PER_TOPIC;
        if (last) done = mustMove || (mayMove && out.done);
        else if (mustMove || (mayMove && out.topic === session.topic + 1)) topic = session.topic + 1;
        if (done) topic = TOPICS.length;
      }
      await this.prisma.$transaction([
        this.prisma.deepMessage.create({
          data: { sessionId: session.id, role: 'ai', cipher: this.crypto.seal(out.reply), quick: done ? [] : out.quick, topic: Math.min(topic, TOPICS.length - 1) },
        }),
        this.prisma.deepSession.update({ where: { id: session.id }, data: { topic, turns: topic === session.topic ? turns : 0 } }),
      ]);
      return { ...(await this.state(userId)), done, fellBack: result.fellBack };
    });
  }

  /** 聊完（或用户说聊够了）：把聊天记录整理成画像草稿，等用户确认 */
  async finish(userId: bigint) {
    return this.exclusive(userId, async () => {
      const session = await this.latest(userId);
      if (!session || session.status !== 'chatting') throw new BadRequestException('这场聊天已经结束了');
      const rows = await this.prisma.deepMessage.findMany({ where: { sessionId: session.id }, orderBy: { id: 'asc' } });
      if (rows.filter((m) => m.role === 'user').length < 2) throw new BadRequestException('再多聊两句，我才好整理');
      const brief = await this.hn.brief(userId);
      const transcript = rows.map((m) => `${m.role === 'ai' ? '红娘' : '用户'}：${this.crypto.open(m.cipher)}`).join('\n');
      const known = await this.flags(userId);
      const result = await this.gateway.chat({
        userId, feature: 'portrait', groupKey: `portrait:${session.id}`, json: true, maxTokens: 800, temperature: 0.3,
        messages: [
          { role: 'system', content: PORTRAIT_PROMPT },
          {
            role: 'user',
            content: `${profilePrompt(brief.nickname, brief.gender, brief.summary, brief.intro)}`
              + (known.length ? `\n\n【已经记下的严重问题】（warnings 里不用重复写，只补充还没记的）\n${known.join('\n')}` : '')
              + `\n\n【深聊记录】\n${transcript}`,
          },
        ],
      });
      const parsed = parsePortrait(result.content);
      if (!parsed) {
        this.logger.warn(`uid=${userId} 画像整理结果解析失败`);
        throw new BadRequestException('整理画像时出了点问题，请再点一次');
      }
      const portrait = parsed.portrait;
      // 整理时再过一遍：聊天时没记到的严重问题补上
      if (parsed.warnings.length) await this.addFlags(userId, parsed.warnings);
      await this.prisma.$transaction([
        this.prisma.profile.update({ where: { userId }, data: { deepDraft: portrait as unknown as Prisma.InputJsonObject } }),
        this.prisma.deepSession.update({ where: { id: session.id }, data: { status: 'draft' } }),
        this.prisma.deepMessage.create({ data: { sessionId: session.id, role: 'ai', cipher: this.crypto.seal(DRAFT_READY), topic: TOPICS.length - 1 } }),
      ]);
      return this.state(userId);
    });
  }

  /** 确认画像：草稿生效 */
  async confirm(userId: bigint) {
    const session = await this.latest(userId);
    const profile = await this.prisma.profile.findUnique({ where: { userId }, select: { deepDraft: true } });
    if (!session || session.status !== 'draft' || !profile?.deepDraft) throw new BadRequestException('没有等待确认的画像');
    await this.prisma.$transaction([
      this.prisma.profile.update({ where: { userId }, data: { deep: profile.deepDraft as Prisma.InputJsonObject, deepDraft: Prisma.DbNull, deepConfirmedAt: new Date() } }),
      this.prisma.deepSession.update({ where: { id: session.id }, data: { status: 'done' } }),
      this.prisma.deepMessage.create({ data: { sessionId: session.id, role: 'ai', cipher: this.crypto.seal(CONFIRMED), topic: TOPICS.length - 1 } }),
    ]);
    return this.state(userId);
  }

  /** 再聊聊：回到聊天接着补充，聊完重新整理（已确认的画像在新的确认之前一直有效） */
  async resume(userId: bigint) {
    await this.mustProfile(userId);
    const session = await this.latest(userId);
    if (!session) return this.start(userId);
    if (session.status !== 'chatting') {
      await this.prisma.$transaction([
        this.prisma.deepSession.update({ where: { id: session.id }, data: { status: 'chatting', topic: TOPICS.length, turns: 0 } }),
        this.prisma.deepMessage.create({ data: { sessionId: session.id, role: 'ai', cipher: this.crypto.seal(RESUME.text), quick: RESUME.quick, topic: TOPICS.length - 1 } }),
      ]);
    }
    return this.state(userId);
  }

  /**
   * 手动改画像里的一项（不调模型、不花钱）：key 是 summary 或某一行；value 空 = 删掉这一行。
   * 有草稿改草稿，没有就改已经生效的那份。
   */
  async editPortrait(userId: bigint, key: string, value: string) {
    const profile = await this.prisma.profile.findUnique({ where: { userId }, select: { deep: true, deepDraft: true } });
    const field = profile?.deepDraft ? 'deepDraft' : profile?.deep ? 'deep' : null;
    if (!field) throw new BadRequestException('还没有 AI 整理的画像');
    const p = normalize(profile![field]);
    if (!p) throw new BadRequestException('还没有 AI 整理的画像');
    const v = clean(value);
    if (key === 'summary') {
      if (!v) throw new BadRequestException('这句话不能是空的');
      p.summary = v.slice(0, 80);
    } else {
      const def = PORTRAIT_ROWS.find((r) => r.key === key);
      if (!def) throw new BadRequestException('没有这一项');
      p.rows = p.rows.filter((r) => r.key !== key);
      if (v) p.rows.push({ key, label: def.label, value: v.slice(0, 60) });
      p.rows.sort((a, b) => PORTRAIT_ROWS.findIndex((r) => r.key === a.key) - PORTRAIT_ROWS.findIndex((r) => r.key === b.key));
    }
    await this.prisma.profile.update({ where: { userId }, data: { [field]: p as unknown as Prisma.InputJsonObject } });
    return { ok: true };
  }

  /** 后台用：清掉某个人「需要注意」的记录（AI 记错了的时候） */
  async clearFlags(userId: bigint) {
    await this.prisma.profile.update({ where: { userId }, data: { flags: Prisma.DbNull } });
    return { ok: true };
  }

  // ---------- 内部 ----------

  /** 已经记下的「需要注意」 */
  private async flags(userId: bigint): Promise<string[]> {
    const row = await this.prisma.profile.findUnique({ where: { userId }, select: { flags: true } });
    return Array.isArray(row?.flags) ? (row!.flags as unknown[]).filter((f): f is string => typeof f === 'string') : [];
  }

  /**
   * 记下用户自己说的严重问题。只加不减：本人没有任何接口能改或删，重新聊、不确认画像都不影响。
   * 同一件事聊天时记一次、整理画像时可能又说一次，说法差不多的只留更详细的那条。
   */
  private async addFlags(userId: bigint, list: string[]) {
    const flags = await this.flags(userId);
    for (const raw of list) {
      const f = clean(raw).slice(0, 60);
      if (!f) continue;
      const same = flags.findIndex((x) => x.includes(f) || f.includes(x) || similar(x, f));
      if (same < 0) flags.push(f);
      else if (f.length > flags[same].length) flags[same] = f;
    }
    await this.prisma.profile.update({ where: { userId }, data: { flags: flags.slice(0, 10) } });
    this.logger.log(`uid=${userId} 记下需要注意的事，现在共 ${flags.length} 条`);
  }

  private latest(userId: bigint) {
    return this.prisma.deepSession.findFirst({ where: { userId }, orderBy: { id: 'desc' } });
  }

  /** 新开一场，写入固定的开场白（不调模型） */
  private async open(userId: bigint) {
    const session = await this.prisma.deepSession.create({ data: { userId } });
    for (const o of OPENING) {
      await this.prisma.deepMessage.create({ data: { sessionId: session.id, role: 'ai', cipher: this.crypto.seal(o.text), quick: o.quick, topic: 0 } });
    }
    return session;
  }

  private async mustProfile(userId: bigint) {
    const p = await this.prisma.profile.findUnique({ where: { userId }, select: { confirmedAt: true } });
    if (!p?.confirmedAt) throw new BadRequestException('请先完成基本情况的问答');
  }

  private async exclusive<T>(userId: bigint, fn: () => Promise<T>): Promise<T> {
    const key = userId.toString();
    if (this.inflight.has(key)) throw new BadRequestException('上一句还在处理，请稍等');
    this.inflight.add(key);
    try {
      return await fn();
    } finally {
      this.inflight.delete(key);
    }
  }
}

/** 库里存的画像 JSON → 规范结构（格式不对返回 null） */
export function normalize(raw: unknown): DeepPortrait | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.summary !== 'string' || !o.summary) return null;
  const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string' && !!t) : [];
  const rows = Array.isArray(o.rows)
    ? o.rows.filter((r): r is DeepPortrait['rows'][number] => !!r && typeof r === 'object' && typeof (r as any).key === 'string' && typeof (r as any).value === 'string' && !!(r as any).value)
    : [];
  return { summary: o.summary, tags, rows: rows.map((r) => ({ key: r.key, label: PORTRAIT_ROWS.find((d) => d.key === r.key)?.label ?? r.label ?? '', value: r.value })) };
}

/** 去掉控制字符；手机号、身份证号这类长数字不发给模型、也不存 */
function clean(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\d{17}[\dXx]/g, '[已隐去]')
    .replace(/\d{7,}/g, '[已隐去]')
    .trim();
}

/** 模型偶尔会在 JSON 外面包一层 ```，剥掉再解析 */
function parseJson(content: string): Record<string, unknown> | null {
  const text = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const o = JSON.parse(text);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

function parseReply(content: string) {
  const o = parseJson(content);
  // 没按格式输出时，把整段话当成回复（不给现成回答）
  if (!o || typeof o.reply !== 'string' || !o.reply.trim()) return { reply: content.slice(0, 400), quick: [] as string[], topic: -1, done: false, flag: '' };
  const quick = Array.isArray(o.quick)
    ? [...new Set(o.quick.filter((q): q is string => typeof q === 'string').map((q) => q.trim()).filter((q) => q && q.length <= 20))].slice(0, 3)
    : [];
  return {
    reply: o.reply.trim().slice(0, 400), quick, topic: Number.isInteger(o.topic) ? (o.topic as number) : -1, done: o.done === true,
    flag: typeof o.flag === 'string' ? o.flag.trim() : '',
  };
}

function parsePortrait(content: string): { portrait: DeepPortrait; warnings: string[] } | null {
  const o = parseJson(content);
  if (!o || typeof o.summary !== 'string' || !o.summary.trim()) return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? clean(v).slice(0, max) : '');
  const tags = Array.isArray(o.tags) ? [...new Set(o.tags.map((t) => str(t, 6)).filter(Boolean))].slice(0, 5) : [];
  const rows = PORTRAIT_ROWS.map((r) => ({ key: r.key as string, label: r.label as string, value: str(o[r.key], 60) })).filter((r) => r.value);
  const warnings = Array.isArray(o.warnings) ? o.warnings.map((w) => str(w, 60)).filter(Boolean).slice(0, 6) : [];
  return { portrait: { summary: str(o.summary, 80), tags, rows }, warnings };
}

/** 两句话是不是在说同一件事：粗略地看共同的字占短的那句的比例 */
function similar(a: string, b: string): boolean {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  const chars = [...new Set(s.replace(/[，。、；：「」\s自述有过曾经]/g, ''))];
  if (chars.length < 3) return false;
  return chars.filter((c) => l.includes(c)).length / chars.length >= 0.8;
}
