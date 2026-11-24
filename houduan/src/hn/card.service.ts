import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HnService } from './hn.service';
import { DeepPortrait, normalize } from './deep.service';
import { PORTRAIT_ROWS } from './deep.prompt';

const thisYear = () => new Date().getFullYear();

/** 每一项在画像网页上显示成什么样的小标签；没列出来的直接显示回答本身 */
const TEXT: Record<string, (v: string[]) => string> = {
  birthYear: (v) => `${v[0]} 年 · ${thisYear() - Number(v[0])} 岁`,
  height: (v) => `${v[0]} cm`,
  city: (v) => `现居${v[0]}`,
  hometown: (v) => `老家${v[0]}`,
  income: (v) => `月收入 ${v[0]}`,
  wantKids: (v) => ({ 想要: '想要孩子', 不想要: '不想要孩子', 看情况: '要不要孩子看情况' } as Record<string, string>)[v[0]] ?? v[0],
  marryPlan: (v) => (v[0] === '顺其自然' ? '结婚顺其自然' : `${v[0].replace(/内$/, '')}内结婚`),
  smoke: (v) => (v[0] === '不抽烟' ? v[0] : `${v[0]}烟`),
  drink: (v) => (v[0] === '不喝酒' ? v[0] : `${v[0]}酒`),
  prefAge: (v) => (v[0] === '不限' ? '年龄不限' : `年龄${v[0]}`),
  prefHeight: (v) => (v[0] === '不限' ? '身高不限' : `身高 ${v[0]}`),
  prefEducation: (v) => (v[0] === '不限' ? '学历不限' : `学历${v[0]}`),
  prefMarital: (v) => (v[0] === '都可以' ? '婚史不限' : v[0]),
  prefIncome: (v) => (v[0] === '不限' ? '收入不限' : `月收入 ${v[0]}`),
  prefHouse: (v) => (v[0] === '不限' ? '住房不限' : v[0]),
  dealbreakers: (v) => `不能接受：${v.join('、')}`,
  brideGive: (v) => (v[0] === '不打算给彩礼' ? v[0] : `彩礼能给：${v[0]}`),
  brideWant: (v) => (v[0] === '不要彩礼' ? v[0] : `彩礼想要：${v[0]}`),
  bridePay: (v) => (v[0].includes('不涉及') ? '' : `彩礼${v[0]}`),
  kidsBefore: (v) => (v[0].includes('不涉及') ? '' : v[0] === '没有特别要求' ? '要孩子的前提：没有特别要求' : v[0]),
};

/** 「不限 / 都可以」这类回答没有信息量：自己能看到（方便改），别人看时不占地方 */
const NO_LIMIT = new Set(['不限', '都可以']);
/** 照片下面压着的那几个小标签 */
const HERO = ['city', 'height', 'education', 'job', 'marital'];

interface Chip {
  key: string;
  label: string;
  text: string;
  /** 还没填（答了「先不说」）：只有自己能看到，显示成「＋ 老家」这样的空标签 */
  empty: boolean;
}

/**
 * 相亲画像网页的数据：头像、昵称、照片、点选问答的每一项、AI 深聊整理的画像，全在这一个接口里。
 * 别人看到的和自己看到的一样（用户 2026-11-23 定的）：收入、不能接受的事、AI 整理的每一行、需要注意的事都给对方看。
 * 只有两处不同：自己能看到还没点确认的草稿和没填的空项（方便补），别人看到的是确认过的内容。
 */
@Injectable()
export class CardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hn: HnService,
  ) {}

  async card(viewerId: bigint, targetId: bigint) {
    const self = viewerId === targetId;
    const [viewer, target] = await Promise.all([
      self ? null : this.prisma.user.findUnique({ where: { id: viewerId }, select: { gender: true } }),
      this.prisma.user.findUnique({ where: { id: targetId }, include: { albums: { where: { type: 1 }, orderBy: { sort: 'asc' } } } }),
    ]);
    if (!target || target.status !== 0) throw new NotFoundException('用户不存在');
    // 和主页一样：只能看异性
    if (!self && viewer && viewer.gender === target.gender) throw new ForbiddenException('无法查看该用户');

    const sheet = await this.hn.sheet(targetId, target.gender);
    // 别人只能看到确认过的资料；自己能看到填到一半的
    const visible = self || sheet.confirmed;
    const chips = (pref: boolean): Chip[] =>
      !visible ? [] : sheet.items
        .filter((q) => q.pref === pref && q.key !== 'intro' && q.key !== 'hobbies' && q.value !== undefined)
        .filter((q) => self || (q.value!.length > 0 && !NO_LIMIT.has(q.value![0])))
        .map((q) => {
          const c = this.chip(q);
          // 「不涉及」这类回答（比如不要彩礼的人，「彩礼怎么给」那一项）：别人看时不显示；自己还能看到，方便点进去改
          return self && !c.text ? { ...c, text: `${q.label}：${q.value!.join('、')}` } : c;
        })
        .filter((c) => c.text);

    const deep = normalize(sheet.deep);
    const draft = self ? normalize(sheet.deepDraft) : null;
    // 自己看：有没确认的草稿就看草稿（聊天里那张卡片点开要看到刚整理的内容）
    const shown: DeepPortrait | null = draft ?? deep;
    const row = (key: string) => shown?.rows.find((r) => r.key === key)?.value ?? '';

    const session = self ? await this.prisma.deepSession.findFirst({ where: { userId: targetId }, orderBy: { id: 'desc' }, select: { status: true } }) : null;
    const follow = self ? null : await this.prisma.follow.findUnique({ where: { followerId_targetId: { followerId: viewerId, targetId } } });

    return {
      self,
      user: { id: target.id, nickname: target.nickname, avatar: target.avatar, gender: target.gender, age: target.age, cityName: target.cityName },
      /** 真人认证：做过实人认证就在画像上显示绿标（用户 2026-11-23 定，标名「真人认证」） */
      realname: target.realStatus === 1,
      /** 顶上左右滑的大图：头像 + 照片墙 */
      photos: [...new Set([target.avatar, ...target.albums.map((a) => a.url)].filter(Boolean))],
      /** 压在照片下方的几个小标签 */
      hero: !visible ? [] : HERO.map((k) => sheet.items.find((q) => q.key === k)).filter((q) => q?.value?.length).map((q) => (q!.key === 'height' ? `${q!.value![0]}cm` : q!.value![0])),
      /** 点选问答确认了没有 */
      profileDone: sheet.confirmed,
      /** AI 那段话：深聊过用 AI 写的，没深聊过用点选问答自动拼的 */
      ai: !visible ? null : { byAi: !!shown, draft: !!draft, summary: shown?.summary ?? sheet.soft.summary, tags: shown?.tags ?? sheet.soft.tags },
      intro: visible ? sheet.soft.intro : '',
      facts: chips(false),
      hobbies: visible ? sheet.soft.hobbies : [],
      /** 想找的人：AI 写的一句话 + 点选问答里选的条件 */
      partner: row('partner'),
      prefs: chips(true),
      /** AI 深聊整理的每一行（性格、生活、花钱、家庭、感情、不能接受）；「想找的人」单独在上面的 partner 里 */
      rows: !visible ? [] : PORTRAIT_ROWS.filter((r) => r.key !== 'partner' && row(r.key)).map((r) => ({ key: r.key as string, label: r.label as string, text: row(r.key) })),
      /** 需要注意的事：AI 在深聊里听到本人自己说的严重问题。本人改不了，谁看都有 */
      flags: sheet.flags,
      /** none 没聊过 | chatting 聊到一半 | draft 画像等确认 | done 已确认（只有自己看时有） */
      deepStatus: !self ? null : deep && (!session || session.status === 'done') ? 'done' : (session?.status ?? 'none'),
      isFollowing: !!follow,
    };
  }

  private chip(q: { key: string; label: string; value?: string[] }): Chip {
    const v = q.value ?? [];
    return { key: q.key, label: q.label, text: v.length ? (TEXT[q.key]?.(v) ?? v.join('、')) : q.label, empty: v.length === 0 };
  }
}
