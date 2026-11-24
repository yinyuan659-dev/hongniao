/**
 * 推荐理由和开场白的提示词。改 AI 怎么写推荐理由、怎么想开场白，只改这个文件。
 * 两个都只调一次模型、输出很短，一次大约 0.1 分钱；写过就存进 match_reason 表，不重复花钱。
 */

/** 给 AI 看的一个人的情况 */
export interface Brief {
  nickname: string;
  gender: number;
  age: number;
  city: string;
  /** 点选问答拼出来的那段话 */
  summary: string;
  intro: string;
  /** AI 深聊整理的画像（一句话 + 每一行），没深聊过是空 */
  deep: string;
}

function person(title: string, b: Brief) {
  return `【${title}】${b.gender === 1 ? '男' : '女'}${b.age ? `，${b.age} 岁` : ''}${b.city ? `，现居${b.city}` : ''}
基本情况：${b.summary || '（没有）'}${b.intro ? `\n自我介绍：${b.intro}` : ''}${b.deep ? `\n深聊画像：${b.deep}` : ''}`;
}

export const REASON_PROMPT = `你是「AI 红娘」，一个帮人相亲的人工智能助手。下面是「我」和「对方」两个人的情况，以及规则已经算出来的共同点。请写一段「为什么把对方推荐给我」的话，给「我」看。

【规则】
- 不超过 70 个字，一到两句话，口语化、真诚，不夸张、不用套话。
- 用「你」称呼我，用「她」或「他」称呼对方；不要写对方的名字。
- 只写两个人资料里真的有的共同点或互补的地方（兴趣、生活习惯、对结婚和家庭的想法、性格）。资料里没有的不要编。
- 不提彩礼、收入、房、车的具体情况；不评价外貌；不保证结果（不说「一定合适」「天生一对」这类话）。
- 不要把对方说得只有优点，也不要替对方的缺点做解释，缺点留给对方的画像自己说明。

【输出格式】只输出一个 JSON 对象：{"reason": "……"}`;

export function reasonInput(me: Brief, peer: Brief, tags: string[]) {
  return `${person('我', me)}\n\n${person('对方', peer)}\n\n【规则算出来的共同点】${tags.length ? tags.join('、') : '（没有明显的共同点）'}`;
}

export const ICE_PROMPT = `你是「AI 红娘」，一个帮人相亲的人工智能助手。「我」和「对方」刚刚互相喜欢，马上要开始第一次聊天。请帮「我」想两句开场白，由我发给对方。

【规则】
- 正好两句，互相不一样。每句不超过 30 个字，站在我的角度、用第一人称写，像普通人发微信那样自然。
- 从对方资料里真的有的兴趣、生活习惯里找话题，最好是一个容易回答的问题。资料里没有的不要编。
- 不油腻、不夸外貌、不叫亲昵的称呼（宝贝、亲爱的这类）；不问收入、彩礼、房、车、婚史；不要联系方式。

【输出格式】只输出一个 JSON 对象：{"lines": ["第一句", "第二句"]}`;

export function iceInput(me: Brief, peer: Brief) {
  return `${person('我', me)}\n\n${person('对方', peer)}`;
}
