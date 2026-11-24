import { spamReason } from '../common/spam-filter';

export const MIN_LEN = 10;
export const MAX_LEN = 1000;

/** 自伤 / 轻生信号：命中就不自动发，扣下给人看，并给投稿人回求助热线 */
const CRISIS = /自杀|轻生|不想活|活不下去|想死|去死吧我|结束(自己的)?生命|割腕|跳楼|跳河|烧炭|上吊|安眠药|吞药|遗书|离开这个世界|自残|伤害自己/;

export const HOTLINE =
  '如果你现在很难受，请一定找人说说：\n' +
  '· 全国心理援助热线 12356\n' +
  '· 希望24热线 400-161-9995（24 小时）\n' +
  '· 人在海外请拨当地急救电话\n' +
  '你不是一个人。';

/** 联系方式 / 引流（逐个替换掉，不整行删：投稿是一段话，整行删会丢内容） */
const CONTACT_PATTERNS: RegExp[] = [
  /https?:\/\/\S+/gi,
  /\b(?:t|telegram)\.me\/\S+/gi,
  /\b[\w.-]+\.(?:com|net|org|cn|vip|top|xyz|cc|me|io)(?:\/\S*)?/gi,
  /(^|[^A-Za-z0-9_.])@[A-Za-z][A-Za-z0-9_]{3,}/g,
  /[\w.+-]+@[\w-]+\.[\w.]+/g,
  /(微信|威信|薇信|v信|vx|wx|扣扣|qq|电话|手机|tg|飞机)\s*[:：号]?\s*[A-Za-z0-9_-]{5,}/gi,
  /(?<!\d)\+?\d[\d\s-]{6,}\d(?!\d)/g,
];

export interface CleanResult {
  text: string;
  removedContacts: boolean;
}

function squash(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 全角字母 / 数字 / @ ． ／ 转半角（防「１３８…」「ｗｘ」绕过），中文标点（，：。）不动 */
function halfwidthAscii(s: string): string {
  return s.replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A\uFF20\uFF0E\uFF0F]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/** 去掉链接 / @ / 邮箱 / 微信 QQ 号 / 7 位以上数字串，压缩空白 */
export function cleanSubmission(raw: string): CleanResult {
  const before = squash(halfwidthAscii(String(raw ?? '')).replace(/[\u200b-\u200f\u2060\ufeff]/g, ''));
  let text = before;
  for (const re of CONTACT_PATTERNS) {
    text = text.replace(re, (m, lead) => (typeof lead === 'string' && m.startsWith(lead) ? lead : ''));
  }
  text = squash(text);
  return { text, removedContacts: text !== before };
}

export function hasCrisisSignal(text: string): boolean {
  return CRISIS.test(String(text ?? '').replace(/\s+/g, ''));
}

export type RuleVerdict =
  | { action: 'too_short' }
  | { action: 'too_long' }
  | { action: 'reject'; reason: string }
  | { action: 'hold'; reason: string; crisis?: boolean }
  | { action: 'pass'; note: string };

/**
 * 规则这一层：长度 → 广告（带联系方式的直接拒，只命中关键词的扣下，比如「老公赌博欠债」这种真心事）→ 自伤信号。
 * 通过的再交给 AI。
 */
export function ruleCheck(raw: string, cleaned: CleanResult): RuleVerdict {
  const len = [...cleaned.text].length;
  if (len < MIN_LEN) return { action: 'too_short' };
  if ([...String(raw)].length > MAX_LEN * 1.5 || len > MAX_LEN) return { action: 'too_long' };
  const spam = spamReason(raw);
  if (spam && cleaned.removedContacts) return { action: 'reject', reason: `像广告：${spam}` };
  if (hasCrisisSignal(cleaned.text)) return { action: 'hold', reason: '可能有自伤 / 轻生风险，需要人工看', crisis: true };
  if (spam) return { action: 'hold', reason: `命中广告规则（${spam}），可能是误判` };
  return { action: 'pass', note: cleaned.removedContacts ? '已去掉联系方式' : '' };
}

export interface AiVerdict {
  ok: boolean;
  risk: string;
  reason: string;
  reply: string;
}

export const AI_RISKS = ['none', 'self_harm', 'sexual', 'minor', 'violence', 'ad', 'privacy', 'hate', 'illegal', 'other'] as const;

export const AI_SYSTEM =
  '你是匿名树洞频道的投稿审核员，也是一个温和的倾听者。用户会发来一段想匿名公开的心事。\n' +
  '判断它能不能公开发布，并给投稿人写一句回应。只输出一个 JSON 对象，不要别的文字：\n' +
  '{"ok": true/false, "risk": "none|self_harm|sexual|minor|violence|ad|privacy|hate|illegal|other", "reason": "不能发的原因，能发就空字符串", "reply": "给投稿人的一句回应"}\n' +
  '规则：\n' +
  '- 能发：倾诉情感、恋爱、婚姻、家庭、工作、学业、遗憾、秘密、吐槽，哪怕带脏话或提到性经历，只要不露骨。\n' +
  '- 不能发：露骨色情描写（sexual）、任何涉及未成年人的性内容（minor）、威胁 / 煽动暴力（violence）、广告引流 / 卖东西（ad）、' +
  '写出了可以认出具体某人的真实姓名 + 单位 / 学校 / 住址等隐私（privacy）、歧视仇恨（hate）、违法交易或教唆犯罪（illegal）。\n' +
  '- 流露出想自杀、自残、活不下去：ok=false，risk=self_harm。\n' +
  '- reply：中文，不超过 50 个字，像朋友一样真诚、具体地回应内容，不说教、不提「审核」，不要用「亲」。self_harm 时表达关心，劝对方找人倾诉。';

/** 校验 AI 的 JSON，不合格抛错（freeJson 会换下一个模型） */
export function parseAiVerdict(j: any): AiVerdict {
  if (typeof j?.ok !== 'boolean') throw new Error('缺 ok');
  const risk = String(j.risk ?? 'none');
  if (!(AI_RISKS as readonly string[]).includes(risk)) throw new Error(`risk 不认识：${risk}`);
  const reply = String(j.reply ?? '').trim();
  if (!reply) throw new Error('缺 reply');
  return { ok: j.ok && risk === 'none', risk, reason: String(j.reason ?? '').slice(0, 200), reply: reply.slice(0, 120) };
}

/** AI 说不能发时：明显违规的直接拒，拿不准的（隐私、自伤、其他）扣下给人看 */
export function aiAction(v: AiVerdict): 'pass' | 'hold' | 'reject' {
  if (v.ok) return 'pass';
  if (['sexual', 'minor', 'violence', 'ad', 'hate', 'illegal'].includes(v.risk)) return 'reject';
  return 'hold';
}

export const FALLBACK_REPLIES = [
  '谢谢你愿意说出来，这些话被听见了。',
  '抱抱你，说出来会轻松一点吧。',
  '你的心事已经安放在树洞里了。',
  '辛苦了，愿你今晚能睡个好觉。',
];
