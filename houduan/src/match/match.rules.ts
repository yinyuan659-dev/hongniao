import { provinceOf } from './provinces';

/**
 * 推荐的规则（规则版，不用向量服务）：
 *   第一步 compatible()：双方的硬条件互相符合，对不上的直接不推荐；
 *   第二步 score()：按兴趣、生活节奏、画像的重合度打分，分高的排前面；
 *   common()：两个人的共同点，显示成推荐卡片上的小标签。
 * 全是不碰数据库的纯函数，改推荐规则只改这个文件。选项的文字要和 hn/interview.template.ts 里的一致。
 */

export interface Person {
  id: bigint;
  /** 1 男，其它按女 */
  gender: number;
  hard: Hard;
  soft: Soft;
  /** AI 深聊整理的画像里的标签 */
  deepTags: string[];
  /** 「需要注意」的记录 */
  flags: string[];
}

export interface Hard {
  birthYear: number; height: number;
  city: string; education: string; income: string; marital: string; house: string;
  wantKids: string; marryPlan: string; smoke: string; drink: string;
  prefAge: string; prefHeight: string; prefEducation: string; prefMarital: string; prefDistance: string;
  prefIncome: string; prefHouse: string;
  /** 男方是「能给多少」，女方是「想要多少」 */
  bride: string; bridePay: string; kidsBefore: string;
  dealbreakers: string[];
}

export interface Soft {
  hometown: string; job: string; hobbies: string[]; intro: string; summary: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

/** 库里的 profile.hard / soft（JSON）→ 有固定字段的结构，缺的补空 */
export function toPerson(id: bigint, gender: number, hard: unknown, soft: unknown, deep: unknown, flags: unknown): Person {
  const h = (hard && typeof hard === 'object' ? hard : {}) as Record<string, unknown>;
  const s = (soft && typeof soft === 'object' ? soft : {}) as Record<string, unknown>;
  const d = (deep && typeof deep === 'object' ? deep : {}) as Record<string, unknown>;
  return {
    id, gender,
    hard: {
      birthYear: num(h.birthYear), height: num(h.height),
      city: str(h.city), education: str(h.education), income: str(h.income), marital: str(h.marital), house: str(h.house),
      wantKids: str(h.wantKids), marryPlan: str(h.marryPlan), smoke: str(h.smoke), drink: str(h.drink),
      prefAge: str(h.prefAge), prefHeight: str(h.prefHeight), prefEducation: str(h.prefEducation), prefMarital: str(h.prefMarital),
      prefDistance: str(h.prefDistance), prefIncome: str(h.prefIncome), prefHouse: str(h.prefHouse),
      bride: str(h.bride), bridePay: str(h.bridePay), kidsBefore: str(h.kidsBefore),
      dealbreakers: list(h.dealbreakers),
    },
    soft: { hometown: str(s.hometown), job: str(s.job), hobbies: list(s.hobbies), intro: str(s.intro), summary: str(s.summary) },
    deepTags: list(d.tags),
    flags: list(flags),
  };
}

// ---------- 第一步：硬条件 ----------

const EDU = ['高中及以下', '大专', '本科', '硕士', '博士'];
const PREF_EDU: Record<string, number> = { '大专及以上': 1, '本科及以上': 2, '硕士及以上': 3 };
const PREF_AGE: Record<string, number> = { '相差 3 岁以内': 3, '相差 5 岁以内': 5, '相差 10 岁以内': 10 };
/** 能接受的婚史 */
const PREF_MARITAL: Record<string, string[]> = {
  '只接受未婚': ['未婚'],
  '可以接受离异未育': ['未婚', '离异未育'],
  '可以接受离异有孩子': ['未婚', '离异未育', '离异有孩子', '丧偶'],
};
/** 月收入每一档的下限（元） */
const INCOME_MIN: Record<string, number> = { '5 千以下': 0, '5 千～1 万': 5000, '1 万～2 万': 10000, '2 万～3 万': 20000, '3 万～5 万': 30000, '5 万以上': 50000 };
const PREF_INCOME: Record<string, number> = { '5 千以上': 5000, '1 万以上': 10000, '2 万以上': 20000, '3 万以上': 30000 };
const PREF_HOUSE: Record<string, string[]> = {
  '有房，有贷款也行': ['已买房，没有贷款', '已买房，有贷款'],
  '有房，没有贷款': ['已买房，没有贷款'],
};
/** 彩礼的档位，从低到高 */
const BRIDE_TIER = ['5 万以内', '5～10 万', '10～20 万', '20～30 万', '30 万以上'];
const KIDS_NONE = '不打算要孩子，不涉及';
/** 要孩子的前提：做到哪一步 */
const KIDS_LEVEL: Record<string, number> = { '先领证结婚，再要孩子': 1, '领证、彩礼都到位，再要孩子': 2 };

const wantsKids = (v: string) => v === '想要' || v === '已经有孩子，还想要';
const noKids = (v: string) => v === '不想要' || v === '已经有孩子，不再要';

/** p 的择偶要求，o 满足不满足。返回空字符串 = 满足，否则是卡在哪一项 */
function oneWay(p: Person, o: Person): string {
  const a = p.hard;
  const b = o.hard;
  const gap = PREF_AGE[a.prefAge];
  if (gap && a.birthYear && b.birthYear && Math.abs(a.birthYear - b.birthYear) > gap) return '年龄';
  const h = /^(\d{3}) 以上$/.exec(a.prefHeight);
  if (h && b.height && b.height < Number(h[1])) return '身高';
  const edu = PREF_EDU[a.prefEducation];
  if (edu && EDU.indexOf(b.education) < edu) return '学历';
  const marital = PREF_MARITAL[a.prefMarital];
  if (marital && !marital.includes(b.marital)) return '婚史';
  if (a.prefDistance === '只找同城' && a.city !== b.city) return '城市';
  if (a.prefDistance === '同省也可以' && a.city !== b.city) {
    const pa = provinceOf(a.city);
    // 城市不在表里（认不出是哪个省）就按不同省算
    if (!pa || pa !== provinceOf(b.city)) return '城市';
  }
  const income = PREF_INCOME[a.prefIncome];
  if (income && (INCOME_MIN[b.income] ?? -1) < income) return '收入';
  const house = PREF_HOUSE[a.prefHouse];
  if (house && !house.includes(b.house)) return '住房';
  // 「不能接受」里能从对方的回答直接看出来的几项；看不出来的（不上进、不顾家、乱花钱）不拿来卡人
  for (const d of a.dealbreakers) {
    if (d === '抽烟' && b.smoke && b.smoke !== '不抽烟') return '不能接受抽烟';
    if (d === '酗酒' && (b.drink === '经常喝' || o.flags.some((f) => f.includes('酗酒')))) return '不能接受酗酒';
    if (d === '不想要孩子' && noKids(b.wantKids)) return '不能接受不想要孩子';
    if (d === '赌博' && o.flags.some((f) => f.includes('赌'))) return '不能接受赌博';
    if (d === '脾气暴躁' && o.flags.some((f) => /暴力|动手|暴躁|打人/.test(f))) return '不能接受脾气暴躁';
  }
  return '';
}

/**
 * 彩礼、彩礼怎么给、要孩子的前提（用户 2026-11-23 定：这三题当硬条件，对不上的不互相推荐）：
 *   - 彩礼：女方「不要彩礼」和谁都对得上；女方要彩礼而男方「不打算给」对不上；
 *     两边都选了具体档位时，男方能给的档位不能低于女方想要的档位；有一边选「按当地习俗，可以商量」算对得上。
 *   - 怎么给：只有「女方要一次性给、男方只肯按月给」对不上。
 *   - 要孩子的前提：女方要求「领证、彩礼都到位」而男方只做到「先领证」对不上；
 *     一边不打算要孩子、另一边提了要孩子的前提，也对不上。
 */
function brideOk(male: Person, female: Person): string {
  const m = male.hard;
  const f = female.hard;
  if (!m.bride || !f.bride || !m.bridePay || !f.bridePay || !m.kidsBefore || !f.kidsBefore) return '彩礼三题没答完';
  const noBride = f.bride === '不要彩礼';
  if (!noBride) {
    if (m.bride === '不打算给彩礼') return '彩礼';
    const mi = BRIDE_TIER.indexOf(m.bride);
    const fi = BRIDE_TIER.indexOf(f.bride);
    if (mi >= 0 && fi >= 0 && mi < fi) return '彩礼';
    if (f.bridePay === '要一次性给' && m.bridePay === '按月给') return '彩礼怎么给';
  }
  const mk = KIDS_LEVEL[m.kidsBefore] ?? 0;
  // 女方不要彩礼时，「领证、彩礼都到位」里的彩礼那一半没有意义，按「先领证」算
  const fk = Math.min(KIDS_LEVEL[f.kidsBefore] ?? 0, noBride ? 1 : 2);
  if ((m.kidsBefore === KIDS_NONE) !== (f.kidsBefore === KIDS_NONE) && (mk || fk)) return '要孩子的前提';
  if (fk === 2 && mk === 1) return '要孩子的前提';
  return '';
}

/** 两个人的硬条件是不是互相符合。返回空字符串 = 符合；否则是第一处对不上的地方（只用来排查，不给用户看） */
export function compatible(a: Person, b: Person): string {
  if ((a.gender === 1) === (b.gender === 1)) return '同性';
  const [male, female] = a.gender === 1 ? [a, b] : [b, a];
  return oneWay(a, b) || oneWay(b, a) || brideOk(male, female);
}

// ---------- 第二步：打分 ----------

const PLAN = ['一年内', '一到两年', '两到三年'];

export function score(a: Person, b: Person): number {
  const x = a.hard;
  const y = b.hard;
  let s = 0;
  if (x.city && x.city === y.city) s += 15;
  if (a.soft.hometown && a.soft.hometown === b.soft.hometown) s += 6;
  s += Math.min(a.soft.hobbies.filter((h) => b.soft.hobbies.includes(h)).length, 3) * 8;
  s += Math.min(a.deepTags.filter((t) => b.deepTags.includes(t)).length, 3) * 4;
  // 结婚的节奏：一样加 10，差一档加 5；有一边「顺其自然」加 3
  if (x.marryPlan && y.marryPlan) {
    const i = PLAN.indexOf(x.marryPlan);
    const j = PLAN.indexOf(y.marryPlan);
    if (x.marryPlan === y.marryPlan) s += 10;
    else if (i < 0 || j < 0) s += 3;
    else if (Math.abs(i - j) === 1) s += 5;
  }
  // 要不要孩子：想法一致加分，相反扣分
  if (x.wantKids && x.wantKids === y.wantKids) s += 8;
  else if ((wantsKids(x.wantKids) && noKids(y.wantKids)) || (noKids(x.wantKids) && wantsKids(y.wantKids))) s -= 15;
  if (x.smoke === '不抽烟' && y.smoke === '不抽烟') s += 4;
  if (x.drink && x.drink === y.drink) s += 2;
  if (x.birthYear && y.birthYear && Math.abs(x.birthYear - y.birthYear) <= 3) s += 6;
  if (x.education && x.education === y.education) s += 3;
  if (x.bride === y.bride || [x.bride, y.bride].includes('按当地习俗，可以商量')) s += 3;
  // 对方有「需要注意」的记录：不拦，但往后排
  s -= Math.min(b.flags.length, 2) * 8;
  return s;
}

// ---------- 共同点 ----------

const HOBBY_TAG: Record<string, string> = {
  '运动健身': '都爱运动', '户外爬山': '都爱爬山', '旅行': '都爱旅行', '做饭': '都爱做饭', '美食探店': '都爱探店', '电影追剧': '都爱追剧',
  '看书': '都爱看书', '音乐': '都爱音乐', '游戏': '都爱游戏', '摄影': '都爱摄影', '养宠物': '都喜欢宠物', '宅在家': '都爱宅家',
};

/** 两个人的共同点，最多 max 个。只写真的一样的地方，没有就是空数组 */
export function common(a: Person, b: Person, max = 4): string[] {
  const x = a.hard;
  const y = b.hard;
  const out: string[] = [];
  if (x.city && x.city === y.city) out.push('同城');
  for (const h of a.soft.hobbies.filter((h) => b.soft.hobbies.includes(h)).slice(0, 2)) out.push(HOBBY_TAG[h] ?? `都喜欢${h}`);
  if (x.marryPlan && x.marryPlan === y.marryPlan && x.marryPlan !== '顺其自然') out.push('结婚节奏一致');
  if (a.soft.hometown && a.soft.hometown === b.soft.hometown) out.push(`老家都在${a.soft.hometown}`);
  if (wantsKids(x.wantKids) && wantsKids(y.wantKids)) out.push('都想要孩子');
  else if (noKids(x.wantKids) && noKids(y.wantKids)) out.push('都不打算要孩子');
  if (x.smoke === '不抽烟' && y.smoke === '不抽烟') out.push('都不抽烟');
  if (x.birthYear && y.birthYear && Math.abs(x.birthYear - y.birthYear) <= 2) out.push('年龄相近');
  if (x.education && x.education === y.education) out.push('学历相当');
  return out.slice(0, max);
}
