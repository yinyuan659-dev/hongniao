import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CONFIRMED, INTRO, OUTRO, Question, TEMPLATE_VERSION, templateFor } from './interview.template';

/** 回答统一存成字符串数组：单选 / 填空一个元素，多选多个，「先不说」是空数组 */
type Answers = Record<string, string[]>;

const SKIP_TEXT = '先不说';

/**
 * AI 红娘资料收集（模板聊天）+ 相亲画像。
 * 页面是聊天样式，但问题来自 interview.template.ts 的固定模板，不调大模型。
 * 回答一题存一题（中途退出下次接着问）；全部答完并点「确认」后 confirmedAt 才有值，才算完成。
 */
@Injectable()
export class HnService {
  constructor(private readonly prisma: PrismaService) {}

  /** 当前进度：题目、已有回答、是否答完、是否已确认、画像 */
  async state(userId: bigint) {
    const user = await this.mustUser(userId);
    const row = await this.prisma.profile.findUnique({ where: { userId } });
    return this.view(templateFor(user.gender), this.clean(templateFor(user.gender), row?.answers), !!row?.confirmedAt);
  }

  /** 回答（或修改）一题；value 空数组 = 先不说（只有可跳过的题能这样） */
  async answer(userId: bigint, key: string, value: unknown) {
    const user = await this.mustUser(userId);
    const questions = templateFor(user.gender);
    const q = questions.find((x) => x.key === key);
    if (!q) throw new BadRequestException('没有这个问题');
    const v = this.validate(q, value);

    const row = await this.prisma.profile.findUnique({ where: { userId } });
    const answers: Answers = { ...this.clean(questions, row?.answers), [key]: v };
    const data = { answers, ...this.build(answers), version: TEMPLATE_VERSION };
    await this.prisma.profile.upsert({ where: { userId }, create: { userId, ...data }, update: data });

    // 年龄、城市同步到基本资料（广场 / 遇见 / 主页都读 user 表）
    if (key === 'birthYear') {
      await this.prisma.user.update({ where: { id: userId }, data: { age: new Date().getFullYear() - Number(v[0]) } });
    } else if (key === 'city') {
      await this.prisma.user.update({ where: { id: userId }, data: { cityName: v[0], cityCode: v[0] } });
    }
    return this.view(questions, answers, !!row?.confirmedAt);
  }

  /** 确认画像：必须全部问题都答过（可跳过的题点过「先不说」也算） */
  async confirm(userId: bigint) {
    const user = await this.mustUser(userId);
    const questions = templateFor(user.gender);
    const row = await this.prisma.profile.findUnique({ where: { userId } });
    const answers = this.clean(questions, row?.answers);
    if (!row || !questions.every((q) => q.key in answers)) throw new BadRequestException('还有问题没回答完');
    if (!row.confirmedAt) await this.prisma.profile.update({ where: { userId }, data: { confirmedAt: new Date() } });
    return this.view(questions, answers, true);
  }

  /** 给别人看的相亲资料卡：没完成返回 null；不含 hidden 的题（收入）和「先不说」的题 */
  async publicCard(userId: bigint, gender: number) {
    const row = await this.prisma.profile.findUnique({ where: { userId } });
    if (!row?.confirmedAt) return null;
    const questions = templateFor(gender);
    const answers = this.clean(questions, row.answers);
    const rows = (pref: boolean) =>
      questions
        .filter((q) => !q.hidden && !!q.pref === pref && q.key !== 'intro' && (answers[q.key]?.length ?? 0) > 0)
        .map((q) => ({ label: q.label, value: this.display(q, answers[q.key]) }));
    const { soft } = this.build(answers);
    return { summary: soft.summary, tags: soft.tags, intro: soft.intro, about: rows(false), prefs: rows(true) };
  }

  /** 给 AI 深聊用：这个人的基本情况摘要（放进提示词，AI 就不用再问一遍） */
  async brief(userId: bigint) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { nickname: true, gender: true } });
    if (!user) throw new NotFoundException('用户不存在');
    const row = await this.prisma.profile.findUnique({ where: { userId }, select: { answers: true } });
    const { soft } = this.build(this.clean(templateFor(user.gender), row?.answers));
    return { nickname: user.nickname, gender: user.gender, summary: soft.summary, intro: soft.intro };
  }

  /**
   * 画像网页用：点选问答的每一项。
   * value 是原始回答（空数组 = 先不说，undefined = 还没答到）；hidden = 只用来匹配、不给别人看。
   */
  async sheet(userId: bigint, gender: number) {
    const row = await this.prisma.profile.findUnique({ where: { userId } });
    const questions = templateFor(gender);
    const answers = this.clean(questions, row?.answers);
    const { soft } = this.build(answers);
    return {
      confirmed: !!row?.confirmedAt,
      deep: row?.deep ?? null,
      deepDraft: row?.deepDraft ?? null,
      flags: Array.isArray(row?.flags) ? (row!.flags as unknown[]).filter((f): f is string => typeof f === 'string') : [],
      soft,
      items: questions.map((q) => ({ key: q.key, label: q.label, pref: !!q.pref, hidden: !!q.hidden, value: answers[q.key] as string[] | undefined })),
    };
  }

  // ---------- 内部 ----------

  private async mustUser(userId: bigint) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, gender: true } });
    if (!user) throw new NotFoundException('用户不存在');
    return user;
  }

  /** 库里的 answers 只保留当前模板里有、且格式还合法的（模板改过选项后旧答案自动作废，重新问） */
  private clean(questions: Question[], raw: unknown): Answers {
    const out: Answers = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const q of questions) {
      const v = (raw as Record<string, unknown>)[q.key];
      if (v === undefined) continue;
      try {
        out[q.key] = this.validate(q, v);
      } catch {
        /* 不合法的当没答过 */
      }
    }
    return out;
  }

  private validate(q: Question, value: unknown): string[] {
    if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) throw new BadRequestException('回答格式不对');
    const list = [...new Set((value as string[]).map((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter(Boolean))];
    if (list.length === 0) {
      if (q.optional) return [];
      throw new BadRequestException('这个问题需要回答');
    }
    switch (q.type) {
      case 'single':
        if (list.length === 1 && q.options!.includes(list[0])) return list;
        // 带 custom 的题（职业）：选项里没有可以自己填
        if (list.length === 1 && q.custom) {
          if (list[0].length > (q.max ?? 20)) throw new BadRequestException(`最多 ${q.max ?? 20} 个字`);
          return list;
        }
        throw new BadRequestException('请从选项里选一个');
      case 'multi':
        if (list.length > (q.max ?? 99)) throw new BadRequestException(`最多选 ${q.max} 个`);
        if (list.some((x) => !q.options!.includes(x))) throw new BadRequestException('请从选项里选');
        // 按模板里的顺序存，显示稳定
        return q.options!.filter((o) => list.includes(o));
      case 'number': {
        const n = /^\d{1,4}$/.test(list[0]) ? Number(list[0]) : NaN;
        if (list.length !== 1 || !(n >= (q.min ?? 0) && n <= (q.max ?? 9999))) {
          throw new BadRequestException(`请输入 ${q.min}～${q.max} 之间的数字`);
        }
        return [String(n)];
      }
      case 'city':
        if (list.length !== 1 || list[0].length > 30) throw new BadRequestException('请选择城市');
        return list;
      default:
        if (list.length !== 1) throw new BadRequestException('回答格式不对');
        if (list[0].length > (q.max ?? 100)) throw new BadRequestException(`最多 ${q.max} 个字`);
        return list;
    }
  }

  /** 一题的回答怎么显示 */
  private display(q: Question, v: string[] | undefined): string {
    if (!v) return '';
    if (v.length === 0) return SKIP_TEXT;
    if (q.key === 'birthYear') return `${v[0]} 年（${new Date().getFullYear() - Number(v[0])} 岁）`;
    if (q.type === 'number') return `${v[0]}${q.unit ? ` ${q.unit}` : ''}`;
    return v.join('、');
  }

  /** number 题滚轮上每一格的文字（出生年份会带上岁数，比自己算方便） */
  private wheel(q: Question): string[] {
    const out: string[] = [];
    for (let n = q.min ?? 0; n <= (q.max ?? 0); n++) out.push(this.display(q, [String(n)]));
    return out;
  }

  /** 回答 → 画像（hard 硬条件 / soft 标签 + 一段话摘要），对应开发文档 §5.2 的 Profile */
  private build(a: Answers) {
    const one = (k: string) => a[k]?.[0] ?? '';
    const birthYear = Number(one('birthYear')) || 0;
    const height = Number(one('height')) || 0;
    const hobbies = a.hobbies ?? [];
    const hard = {
      birthYear, height,
      city: one('city'), education: one('education'), income: one('income'), marital: one('marital'),
      house: one('house'), car: one('car'), wantKids: one('wantKids'), marryPlan: one('marryPlan'),
      smoke: one('smoke'), drink: one('drink'),
      prefAge: one('prefAge'), prefHeight: one('prefHeight'), prefEducation: one('prefEducation'),
      prefMarital: one('prefMarital'), prefDistance: one('prefDistance'),
      prefIncome: one('prefIncome'), prefHouse: one('prefHouse'),
      // 彩礼：男方是「能给多少」，女方是「想要多少」；怎么给（一次性 / 按月）；要孩子的前提
      bride: one('brideGive') || one('brideWant'), bridePay: one('bridePay'), kidsBefore: one('kidsBefore'),
      dealbreakers: a.dealbreakers ?? [],
    };
    const bride = hard.bride
      ? `彩礼：${hard.bride}${hard.bridePay && !hard.bridePay.includes('不涉及') ? `，${hard.bridePay}` : ''}`
      : '';
    const kidsBefore = hard.kidsBefore && !hard.kidsBefore.includes('不涉及') && hard.kidsBefore !== '没有特别要求' ? hard.kidsBefore : '';

    const join = (parts: string[], sep = '，') => parts.filter(Boolean).join(sep);
    const marry = one('marryPlan');
    const kids = one('wantKids');
    const want = [
      one('prefDistance'),
      hard.prefAge && hard.prefAge !== '不限' ? `年龄${hard.prefAge}` : '',
      hard.prefHeight && hard.prefHeight !== '不限' ? `身高 ${hard.prefHeight}` : '',
      hard.prefEducation && hard.prefEducation !== '不限' ? `学历${hard.prefEducation}` : '',
      hard.prefMarital === '都可以' ? '婚史不限' : hard.prefMarital,
    ];
    const sentences = [
      join([birthYear ? `${new Date().getFullYear() - birthYear} 岁` : '', height ? `${height}cm` : '', hard.city ? `现居${hard.city}` : '', one('hometown') ? `老家${one('hometown')}` : '']),
      join([hard.education, one('job')]),
      join([
        hard.marital,
        !marry ? '' : marry === '顺其自然' ? '结婚的事顺其自然' : `希望${marry.replace(/内$/, '')}内结婚`,
        kids === '想要' ? '想要孩子' : kids === '不想要' ? '不想要孩子' : kids === '看情况' ? '要不要孩子看情况' : kids,
      ]),
      hobbies.length ? `平时喜欢${hobbies.join('、')}` : '',
      join(want, '、') ? `想找：${join(want, '、')}` : '',
      join([bride, kidsBefore]),
    ];
    const soft = {
      hometown: one('hometown'),
      job: one('job'),
      hobbies,
      intro: one('intro'),
      tags: [hard.education, one('job'), hard.marital, hard.smoke === '不抽烟' ? '不抽烟' : '', ...hobbies.slice(0, 3)].filter(Boolean),
      summary: sentences.filter(Boolean).map((s) => `${s}。`).join(''),
    };
    return { hard: hard as Prisma.InputJsonObject, soft: soft as Prisma.InputJsonObject & typeof soft };
  }

  private view(questions: Question[], answers: Answers, confirmed: boolean) {
    const complete = questions.every((q) => q.key in answers);
    const { soft } = this.build(answers);
    return {
      intro: INTRO,
      outro: OUTRO,
      confirmedText: CONFIRMED,
      skipText: SKIP_TEXT,
      questions: questions.map((q) => ({
        key: q.key,
        label: q.label,
        ask: q.ask,
        type: q.type,
        options: q.options ?? [],
        max: q.max ?? 0,
        min: q.min ?? 0,
        hint: q.hint ?? '',
        /** number 题的滚轮：每一格显示的文字，第 i 格对应的值是 min + i */
        wheel: q.type === 'number' ? this.wheel(q) : [],
        /** number 题滚轮一开始停在哪个值 */
        def: q.def ?? q.min ?? 0,
        /** single 题：选项里没有可以自己填 */
        custom: !!q.custom,
        /** text 题：示例句，点一下填进输入框 */
        samples: q.samples ?? [],
        optional: !!q.optional,
        pref: !!q.pref,
        answered: q.key in answers,
        value: answers[q.key] ?? [],
        display: this.display(q, answers[q.key]),
      })),
      /** 全部问题都答过了（还没点确认也算） */
      complete,
      /** 已确认 = 完成资料收集 */
      confirmed,
      profile: complete ? { summary: soft.summary, tags: soft.tags } : null,
    };
  }
}
