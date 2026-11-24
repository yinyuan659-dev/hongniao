import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { Api } from 'telegram';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramClientService } from '../telegram/telegram.service';
import { normalizeChannel } from '../music/music.service';
import { freeJson } from '../common/free-ai';
import { AI_SYSTEM, FALLBACK_REPLIES, HOTLINE, MAX_LEN, MIN_LEN, aiAction, cleanSubmission, parseAiVerdict, ruleCheck } from './submission-rules';

const DEFAULT_CHANNEL = 'smsd2030';
const K = {
  token: 'tg_bot_token',
  channel: 'tg_submit_channel',
  enabled: 'tg_submit_enabled',
  ai: 'tg_submit_ai',
  auto: 'tg_submit_auto',
  daily: 'tg_submit_daily',
};
const POST_TAG = '#匿名投稿';
/** Telegram 调用（MTProto）断网时会一直挂着不返回，统计任务自己加超时，超时就让客户端重连 */
const TG_TIMEOUT_MS = 60_000;

interface TgMessage { message_id: number; chat: { id: number; type: string }; text?: string }
interface Settings { channel: string; enabled: boolean; ai: boolean; auto: boolean; daily: number }

const REJECT_TEXT: Record<string, string> = {
  sexual: '内容太露骨了', minor: '涉及未成年人', violence: '有暴力 / 威胁的内容', ad: '像广告或引流',
  hate: '有歧视 / 攻击性的内容', illegal: '涉及违法内容',
};

/**
 * 推广频道增长：
 * 1. 匿名投稿机器人（Bot API 长轮询，不需要公网回调）：用户私聊机器人写心事 → 规则去联系方式、拦广告、识别自伤 →
 *    免费模型审核并写一句回应 → 自动发到推广频道（默认 @smsd2030），帖子末尾带投稿入口；拿不准的扣下等后台处理。
 *    机器人 token 存 sys_setting.tg_bot_token，机器人要是频道管理员（能发消息）。
 * 2. 增长统计：每小时用已登录的 Telegram 账号记一次频道订阅数，刷新最近 100 条帖子的浏览 / 转发。
 */
@Injectable()
export class TgGrowthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('TgGrowth');
  private stopped = false;
  private offset = 0;
  private token = '';
  private botUser: { id: number; username: string } | null = null;
  private botError = '';
  private lastPollAt: Date | null = null;
  private statsRunning = false;
  private statsError = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly tg: TelegramClientService,
  ) {}

  onModuleInit() {
    setTimeout(() => void this.pollLoop(), 15_000);
    setTimeout(() => void this.collectStats(), 120_000);
    setInterval(() => void this.collectStats(), 60 * 60 * 1000);
  }

  onModuleDestroy() {
    this.stopped = true;
  }

  // ---------- 设置 ----------

  private async setting(key: string): Promise<string> {
    const row = await this.prisma.sysSetting.findUnique({ where: { key } });
    return row?.value ?? '';
  }

  private async setSetting(key: string, value: string) {
    await this.prisma.sysSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  async settings(): Promise<Settings> {
    const [channel, enabled, ai, auto, daily] = await Promise.all([K.channel, K.enabled, K.ai, K.auto, K.daily].map((k) => this.setting(k)));
    return {
      channel: normalizeChannel(channel) || DEFAULT_CHANNEL,
      enabled: enabled !== '0',
      ai: ai !== '0',
      auto: auto !== '0',
      daily: Math.min(20, Math.max(1, Number(daily) || 3)),
    };
  }

  async saveSettings(body: Partial<Settings>) {
    if (body.channel !== undefined) {
      const ch = normalizeChannel(body.channel);
      if (!ch) throw new BadRequestException('频道用户名不对');
      await this.setSetting(K.channel, ch);
    }
    if (body.enabled !== undefined) await this.setSetting(K.enabled, body.enabled ? '1' : '0');
    if (body.ai !== undefined) await this.setSetting(K.ai, body.ai ? '1' : '0');
    if (body.auto !== undefined) await this.setSetting(K.auto, body.auto ? '1' : '0');
    if (body.daily !== undefined) await this.setSetting(K.daily, String(Math.min(20, Math.max(1, Number(body.daily) || 3))));
    return this.status();
  }

  /** 后台填机器人 token（@BotFather 给的）：先 getMe 校验再保存 */
  async saveToken(raw: string) {
    const token = String(raw ?? '').trim();
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new BadRequestException('token 格式不对（形如 123456:ABC…）');
    const me = await this.botCall<{ id: number; username: string }>(token, 'getMe', {}).catch((e) => {
      throw new BadRequestException(`token 无效：${e.message}`);
    });
    await this.setSetting(K.token, token);
    this.token = '';
    this.botUser = null;
    return { username: me.username };
  }

  // ---------- Bot API ----------

  private async botCall<T>(token: string, method: string, params: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!data?.ok) throw new Error(String(data?.description ?? `HTTP ${res.status}`).slice(0, 200));
    return data.result as T;
  }

  private bot<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (!this.token) return Promise.reject(new Error('机器人未配置'));
    return this.botCall<T>(this.token, method, params, timeoutMs);
  }

  private async reply(chatId: string, text: string) {
    await this.bot('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } }).catch((e) =>
      this.logger.warn(`reply failed: ${e.message}`),
    );
  }

  /** 机器人资料：命令菜单 + 打开对话前看到的介绍 */
  private async setupBot() {
    const { channel } = await this.settings();
    await this.bot('setMyCommands', { commands: [{ command: 'start', description: '匿名投稿说明' }] }).catch(() => {});
    await this.bot('setMyShortDescription', { short_description: `私密树洞 · 匿名投稿，心事会匿名发到 @${channel}` }).catch(() => {});
    await this.bot('setMyDescription', {
      description: `把心事悄悄说给树洞听。\n直接发文字给我，审核后会匿名发到频道 @${channel}，不会显示你的名字。\n请不要写真实姓名、电话、住址。`,
    }).catch(() => {});
  }

  private async pollLoop() {
    while (!this.stopped) {
      try {
        const token = await this.setting(K.token);
        if (!token) {
          this.botError = '还没配置机器人 token';
          await sleep(60_000);
          continue;
        }
        if (token !== this.token || !this.botUser) {
          this.token = token;
          this.botUser = await this.bot<{ id: number; username: string }>('getMe', {});
          await this.bot('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
          await this.setupBot();
          this.botError = '';
          this.logger.log(`投稿机器人 @${this.botUser.username} 已连上`);
        }
        const updates = await this.bot<{ update_id: number; message?: TgMessage }[]>(
          'getUpdates',
          { offset: this.offset, timeout: 50, allowed_updates: ['message'] },
          65_000,
        );
        this.lastPollAt = new Date();
        this.botError = '';
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message) await this.handle(u.message).catch((e) => this.logger.warn(`handle: ${e?.message ?? e}`));
        }
      } catch (e: any) {
        this.botError = String(e?.message ?? e).slice(0, 200);
        if (/Unauthorized|Not Found/i.test(this.botError)) this.botUser = null;
        await sleep(this.botUser ? 10_000 : 60_000);
      }
    }
  }

  // ---------- 投稿 ----------

  private welcome(channel: string) {
    return (
      `这里是「私密树洞」匿名投稿 🌙\n\n` +
      `直接把你的心事发给我（${MIN_LEN}～${MAX_LEN} 字），审核后会匿名发到频道 @${channel}，不会显示你的名字或账号。\n\n` +
      `· 请不要写真实姓名、电话、住址、微信号（会被自动删掉）\n` +
      `· 广告、色情内容不会发布\n` +
      `· 目前只收文字`
    );
  }

  private async handle(msg: TgMessage) {
    if (msg.chat?.type !== 'private') return;
    const chatId = String(msg.chat.id);
    const s = await this.settings();
    const text = (msg.text ?? '').trim();
    if (!text) return this.reply(chatId, '目前只收文字投稿，把想说的话打出来发给我就好。');
    if (text.startsWith('/')) return this.reply(chatId, this.welcome(s.channel));
    if (!s.enabled) return this.reply(chatId, '投稿暂停中，过段时间再来吧。');

    const srcKey = `${chatId}:${msg.message_id}`;
    if (await this.prisma.tgSubmission.findUnique({ where: { srcKey } })) return;
    const recent = await this.prisma.tgSubmission.findFirst({ where: { chatId }, orderBy: { id: 'desc' } });
    if (recent && Date.now() - recent.createdAt.getTime() < 60_000) return this.reply(chatId, '慢一点～ 1 分钟后再投下一条。');
    const today = await this.prisma.tgSubmission.count({ where: { chatId, createdAt: { gte: dayStartCst() } } });
    if (today >= s.daily) return this.reply(chatId, `今天已经投了 ${today} 条，明天再来吧。`);
    if (recent && recent.rawText === text) return this.reply(chatId, '这条刚才已经收到了。');

    const cleaned = cleanSubmission(text);
    const rule = ruleCheck(text, cleaned);
    if (rule.action === 'too_short') return this.reply(chatId, `再多写几句吧（至少 ${MIN_LEN} 个字）。`);
    if (rule.action === 'too_long') return this.reply(chatId, `太长啦，请控制在 ${MAX_LEN} 字以内，可以分几次投。`);

    const row = await this.prisma.tgSubmission.create({
      data: { srcKey, chatId, authorTag: authorTag(chatId), rawText: text, text: cleaned.text },
    });
    if (rule.action === 'reject') {
      await this.mark(row.id, 'rejected', rule.reason);
      return this.reply(chatId, '这条看起来像广告或带了联系方式，没有发布。树洞只收心事～');
    }
    if (rule.action === 'hold') {
      await this.mark(row.id, 'pending', rule.reason);
      return this.reply(chatId, rule.crisis ? `收到了，谢谢你愿意说出来。\n\n${HOTLINE}` : '收到了，这条需要人工看一下，通过后会发布并通知你。');
    }

    let aiReply = FALLBACK_REPLIES[row.id % FALLBACK_REPLIES.length];
    if (s.ai) {
      try {
        const v = await freeJson([{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: cleaned.text }], parseAiVerdict, {
          temperature: 0.3,
          label: 'tg-submit',
        });
        aiReply = v.reply;
        const act = aiAction(v);
        if (act !== 'pass') {
          const reason = `AI：${v.risk}${v.reason ? ` · ${v.reason}` : ''}`;
          await this.prisma.tgSubmission.update({ where: { id: row.id }, data: { aiReply, status: act === 'reject' ? 'rejected' : 'pending', reason } });
          if (act === 'reject') return this.reply(chatId, `这条暂时不能发布：${REJECT_TEXT[v.risk] ?? '不太适合公开'}。`);
          if (v.risk === 'self_harm') return this.reply(chatId, `${aiReply}\n\n${HOTLINE}`);
          return this.reply(chatId, `${aiReply}\n\n这条需要人工看一下，通过后会发布并通知你。`);
        }
      } catch {
        await this.mark(row.id, 'pending', 'AI 审核暂时不可用，等人工看');
        return this.reply(chatId, '收到了，稍后人工看过就发布，会通知你。');
      }
    }
    await this.prisma.tgSubmission.update({ where: { id: row.id }, data: { aiReply, reason: rule.note } });
    if (!s.auto) {
      await this.mark(row.id, 'pending', rule.note ? `${rule.note}；等人工发布` : '等人工发布');
      return this.reply(chatId, `${aiReply}\n\n收到了，人工看过后发布，会通知你。`);
    }
    await this.publish(row.id, false);
  }

  private async mark(id: number, status: string, reason: string) {
    await this.prisma.tgSubmission.update({ where: { id }, data: { status, reason: reason.slice(0, 300) } });
  }

  /** 发到频道并通知投稿人；byAdmin = 后台点的「发布」 */
  private async publish(id: number, byAdmin: boolean) {
    const row = await this.prisma.tgSubmission.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('投稿不存在');
    if (row.status === 'published') return row;
    const { channel } = await this.settings();
    if (!this.token || !this.botUser) throw new BadRequestException(`机器人没连上：${this.botError || '未配置'}`);
    const body = `${POST_TAG} No.${row.id}\n\n${row.text}\n\n💌 匿名投稿 @${this.botUser.username}`;
    let msgId = 0;
    try {
      const sent = await this.bot<{ message_id: number }>('sendMessage', { chat_id: `@${channel}`, text: body, link_preview_options: { is_disabled: true } });
      msgId = sent.message_id;
    } catch (e: any) {
      const reason = `机器人发不了频道：${e.message}`;
      await this.mark(id, 'pending', reason);
      if (byAdmin) throw new BadRequestException(reason);
      await this.reply(row.chatId, '收到了，稍后发布，会通知你。');
      return row;
    }
    const done = await this.prisma.tgSubmission.update({ where: { id }, data: { status: 'published', msgId, publishedAt: new Date() } });
    const link = `https://t.me/${channel}/${msgId}`;
    await this.reply(row.chatId, byAdmin ? `你的投稿已经匿名发布：${link}` : `已匿名发布：${link}\n\n${row.aiReply}`);
    return done;
  }

  async adminPublish(id: number) {
    return this.publish(id, true);
  }

  async adminReject(id: number) {
    const row = await this.prisma.tgSubmission.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('投稿不存在');
    if (row.status === 'published') throw new BadRequestException('已经发布了，要删请到频道里删');
    await this.prisma.tgSubmission.update({ where: { id }, data: { status: 'rejected', reason: row.reason ? `${row.reason}；后台拒绝` : '后台拒绝' } });
    if (row.status === 'pending') await this.reply(row.chatId, '你的投稿这次没有发布，谢谢理解。');
    return { ok: true };
  }

  async submissions(status?: string, page = 1) {
    const where = status && ['pending', 'published', 'rejected'].includes(status) ? { status } : {};
    const size = 30;
    const [rows, total] = await Promise.all([
      this.prisma.tgSubmission.findMany({ where, orderBy: { id: 'desc' }, skip: (Math.max(1, page) - 1) * size, take: size }),
      this.prisma.tgSubmission.count({ where }),
    ]);
    return { total, size, list: rows.map(({ chatId: _c, srcKey: _s, ...r }) => r) };
  }

  // ---------- 统计 ----------

  async collectStats() {
    if (this.statsRunning) return;
    this.statsRunning = true;
    try {
      if (!(await this.tg.isLoggedIn())) { this.statsError = 'Telegram 账号未登录'; return; }
      const { channel } = await this.settings();
      const info = await withTimeout(this.tg.resolveChannel(channel), TG_TIMEOUT_MS, '读取频道信息');
      const at = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
      await this.prisma.tgChannelStat.upsert({
        where: { channel_at: { channel, at } },
        create: { channel, at, subscribers: info.subscribers },
        update: { subscribers: info.subscribers },
      });
      const client = await this.tg.authorized();
      const msgs = await withTimeout(client.getMessages(info.entity, { limit: 100 }), TG_TIMEOUT_MS, '读取频道帖子');
      for (const m of msgs) {
        if (m instanceof Api.MessageService) continue;
        const text = (m.message ?? '').trim();
        const data = {
          postedAt: new Date(m.date * 1000),
          views: m.views ?? 0,
          forwards: m.forwards ?? 0,
          kind: text.startsWith(POST_TAG) ? 'submission' : 'other',
          preview: (text || '[图片 / 视频]').replace(/\s+/g, ' ').slice(0, 120),
        };
        await this.prisma.tgPostStat.upsert({
          where: { channel_msgId: { channel, msgId: m.id } },
          create: { channel, msgId: m.id, ...data },
          update: data,
        });
      }
      this.statsError = '';
    } catch (e: any) {
      this.statsError = String(e?.message ?? e).slice(0, 200);
      this.logger.warn(`stats: ${this.statsError}`);
      if (/超时/.test(this.statsError)) await this.tg.recover();
    } finally {
      this.statsRunning = false;
    }
  }

  async stats(days = 30) {
    const { channel } = await this.settings();
    const since = new Date(Date.now() - Math.min(180, Math.max(1, days)) * 86_400_000);
    const [subs, posts] = await Promise.all([
      this.prisma.tgChannelStat.findMany({ where: { channel, at: { gte: since } }, orderBy: { at: 'asc' }, select: { at: true, subscribers: true } }),
      this.prisma.tgPostStat.findMany({ where: { channel }, orderBy: { postedAt: 'desc' }, take: 60 }),
    ]);
    const weekAgo = Date.now() - 7 * 86_400_000;
    const avg = (kind: string) => {
      const list = posts.filter((p) => p.kind === kind && p.postedAt.getTime() >= weekAgo);
      return { count: list.length, avgViews: list.length ? Math.round(list.reduce((a, p) => a + p.views, 0) / list.length) : 0 };
    };
    return { channel, subs, posts, week: { submission: avg('submission'), other: avg('other') }, error: this.statsError };
  }

  async status() {
    const s = await this.settings();
    const hasToken = !!(await this.setting(K.token));
    const [pending, published, rejected, today, last] = await Promise.all([
      this.prisma.tgSubmission.count({ where: { status: 'pending' } }),
      this.prisma.tgSubmission.count({ where: { status: 'published' } }),
      this.prisma.tgSubmission.count({ where: { status: 'rejected' } }),
      this.prisma.tgSubmission.count({ where: { createdAt: { gte: dayStartCst() } } }),
      this.prisma.tgChannelStat.findFirst({ where: { channel: s.channel }, orderBy: { at: 'desc' } }),
    ]);
    return {
      ...s,
      hasToken,
      bot: this.botUser?.username ?? '',
      botError: this.botError,
      lastPollAt: this.lastPollAt,
      counts: { pending, published, rejected, today },
      subscribers: last?.subscribers ?? null,
    };
  }
}

function authorTag(chatId: string) {
  return createHash('sha256').update(`tgsub:${chatId}`).digest('hex').slice(0, 8);
}

/** 北京时间今天 0 点 */
function dayStartCst(): Date {
  const h8 = 8 * 3_600_000;
  return new Date(Math.floor((Date.now() + h8) / 86_400_000) * 86_400_000 - h8);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时`)), ms); }),
  ]);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
