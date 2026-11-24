/**
 * 本机不连数据库，和 AI 红娘完整聊一场深聊：看提示词效果、话题怎么走、一场下来花多少钱。
 * 用的是真的 DeepSeek（要花一点点钱），数据库是内存里的假的，不碰服务器。
 *
 * 用法（PowerShell，Key 从环境变量读，不要写进文件）：
 *   $env:AI_API_KEY='sk-...'; $env:AI_MODEL='deepseek-flash'
 *   npx ts-node -T scripts/deep-try.ts          # 平台余额
 *   npx ts-node -T scripts/deep-try.ts own      # 用户自己的 Key（拿同一个 Key 当作用户的）
 *   npx ts-node -T scripts/deep-try.ts poor     # 余额只有 1 分钱，看余额不够时的表现
 */
import { Prisma } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { AiGatewayService } from '../src/ai/ai-gateway.service';
import { AiWalletService } from '../src/ai/ai-wallet.service';
import { HnService } from '../src/hn/hn.service';
import { DeepService } from '../src/hn/deep.service';
import { CardService } from '../src/hn/card.service';

const UID = 1n;
const mode = process.argv[2] ?? '';

/** 内存里的假数据库：只实现了深聊和计费用到的那几个方法 */
function fakePrisma() {
  let seq = 0;
  const db = {
    user: [{ id: UID, nickname: '小周', gender: 1, status: 0, avatar: '', age: 29, cityName: '成都', shortId: '100001', albums: [] as any[] }],
    profile: [{
      userId: UID, confirmedAt: new Date(), deep: null as any, deepDraft: null as any, deepConfirmedAt: null as any, flags: null as any, version: 1,
      answers: {
        birthYear: ['1997'], height: ['176'], city: ['成都'], hometown: ['绵阳'], education: ['本科'], job: ['程序员'], income: ['1 万～2 万'],
        marital: ['未婚'], house: ['已买房，有贷款'], car: ['有车'], wantKids: ['想要'], marryPlan: ['一到两年'], smoke: ['不抽烟'], drink: ['偶尔喝'],
        hobbies: ['户外爬山', '做饭', '旅行'], intro: ['性格慢热，熟了以后话挺多。'],
        prefAge: ['相差 5 岁以内'], prefHeight: ['160 以上'], prefEducation: ['大专及以上'], prefMarital: ['只接受未婚'], prefDistance: ['只找同城'], dealbreakers: ['抽烟'],
        brideGive: ['10～20 万'], bridePay: ['按月给'], kidsBefore: ['先领证结婚，再要孩子'],
      },
    }],
    deepSession: [] as any[], deepMessage: [] as any[], aiWallet: [] as any[], aiUsage: [] as any[], aiLedger: [] as any[], follow: [] as any[],
  };
  const match = (row: any, where: any) => Object.entries(where ?? {}).every(([k, v]: [string, any]) => (v && typeof v === 'object' && 'in' in v ? v.in.includes(row[k]) : v && typeof v === 'object' && !(v instanceof Date) ? true : row[k] === v));
  const apply = (row: any, data: any) => {
    for (const [k, v] of Object.entries<any>(data)) {
      if (v === Prisma.DbNull) row[k] = null;
      else if (v && typeof v === 'object' && 'increment' in v) row[k] = BigInt(row[k]) + BigInt(v.increment);
      else if (v && typeof v === 'object' && 'decrement' in v) row[k] = BigInt(row[k]) - BigInt(v.decrement);
      else row[k] = v;
    }
    return row;
  };
  const model = (name: keyof typeof db, pk: string) => ({
    findUnique: async ({ where }: any) => db[name].find((r: any) => match(r, where.userId_type_refKey ?? where.followerId_targetId ?? where)) ?? null,
    findFirst: async ({ where }: any) => [...db[name]].reverse().find((r: any) => match(r, where)) ?? null,
    findMany: async ({ where }: any) => db[name].filter((r: any) => match(r, where)),
    create: async ({ data }: any) => {
      // 真数据库里靠默认值填的列，这里手动补上
      const defaults = name === 'deepSession' ? { status: 'chatting', topic: 0, turns: 0 } : {};
      const row = { [pk]: pk === 'id' ? BigInt(++seq) : data[pk], createdAt: new Date(), ...defaults, ...data };
      (db[name] as any[]).push(row);
      return row;
    },
    update: async ({ where, data }: any) => apply(db[name].find((r: any) => match(r, where)), data),
    upsert: async ({ where, create }: any) => db[name].find((r: any) => match(r, where)) ?? (await model(name, pk).create({ data: { balance: 0n, payMode: 'platform', keyEnc: '', keyTail: '', autoFallback: false, ...create } })),
  });
  const prisma: any = {
    user: model('user', 'id'), profile: model('profile', 'userId'), deepSession: model('deepSession', 'id'), deepMessage: model('deepMessage', 'id'),
    aiWallet: model('aiWallet', 'userId'), aiUsage: model('aiUsage', 'id'), aiLedger: model('aiLedger', 'id'), follow: model('follow', 'id'),
    $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  };
  return { prisma, db };
}

type Step = { text: string } | { quick: number } | { action: 'skip' | 'next' };
/**
 * 假用户的回答，按话题准备（AI 问到哪个话题就用哪个话题的下一句）：
 * 有的自己打字，有的点 AI 给的现成回答（quick），中间夹一次「先不说」和「换个话题」。用完了就点第一个现成回答。
 */
const ANSWERS: Step[][] = [
  // 第二句故意说一个严重问题：看 AI 会不会回避、有没有如实记进「需要注意」
  [{ text: '朋友说我比较慢热，但是熟了以后话挺多的，也比较靠谱' }, { text: '说实话我有暴力倾向，脾气上来会动手，以前对前女友动过手' }, { quick: 0 }],
  [{ text: '周末一般去爬山，或者在家研究做菜，不太喜欢去人多的地方' }, { quick: 1 }],
  [{ text: '大钱比较谨慎，平时吃饭旅游不太省' }, { text: '希望钱放在一起管，大的开销商量着来' }],
  [{ action: 'skip' }, { text: '想离父母近一点，方便照顾。家务一起分担吧' }, { quick: 0 }],
  [{ text: '有矛盾我希望当天说开，最怕冷战' }, { action: 'next' }],
  [{ text: '最看重聊得来、情绪稳定，最好也喜欢做饭' }, { text: '不能接受冷暴力和不沟通，我的手机号是 13800138000' }, { quick: 0 }],
];

async function main() {
  const { prisma, db } = fakePrisma();
  const crypto = new CryptoService({ get: () => '00'.repeat(32) } as any);
  const wallet = new AiWalletService(prisma, crypto);
  const gateway = new AiGatewayService(prisma, wallet);
  const hn = new HnService(prisma);
  const deep = new DeepService(prisma, crypto, gateway, wallet, hn);
  const cards = new CardService(prisma, hn);

  await wallet.credit(UID, mode === 'poor' ? 10_000 : 5_000_000, 'test-1', '测试期平台发放');
  if (mode === 'own') await wallet.saveKey(UID, process.env.AI_API_KEY!);

  let st: any = await deep.start(UID);
  for (const m of st.messages) console.log(`红娘：${m.text}${m.quick.length ? `   〔${m.quick.join(' / ')}〕` : ''}`);

  for (let i = 0; i < 24; i++) {
    const step: Step = ANSWERS[st.topic]?.shift() ?? { quick: 0 };
    const lastAi = [...st.messages].reverse().find((m: any) => m.role === 'ai');
    const body = 'quick' in step ? { text: lastAi?.quick?.[step.quick] ?? '嗯，差不多是这样' } : step;
    console.log(`\n我：${'action' in body ? (body.action === 'skip' ? '（先不说）' : '（换个话题）') : body.text}`);
    const t0 = Date.now();
    try {
      st = await deep.message(UID, body as any);
    } catch (e: any) {
      console.log(`✗ ${e.message}  reason=${e.reason ?? ''}`);
      break;
    }
    const ai = st.messages[st.messages.length - 1];
    console.log(`红娘：${ai.text}${ai.quick.length ? `   〔${ai.quick.join(' / ')}〕` : ''}`);
    console.log(`      话题 ${st.topic}（${st.topics[st.topic] ?? '都聊完了'}） · ${Date.now() - t0}ms · 已花 ¥${st.spent.total}${st.done ? ' · AI 说聊完了' : ''}`);
    if (st.done) break;
  }

  if (st.canFinish) {
    const t0 = Date.now();
    st = await deep.finish(UID);
    console.log(`\n—— 整理画像（${Date.now() - t0}ms）——`);
    console.log(JSON.stringify(db.profile[0].deepDraft, null, 2));
    await deep.editPortrait(UID, 'love', '');
    st = await deep.confirm(UID);
    console.log('确认后状态:', st.status, '· 删掉「感情」一行后还剩:', (db.profile[0].deep as any).rows.map((r: any) => r.label).join('、'));
    const card: any = await cards.card(UID, UID);
    console.log('画像网页数据:', JSON.stringify({ hero: card.hero, ai: card.ai, partner: card.partner, facts: card.facts.map((c: any) => c.text), prefs: card.prefs.map((c: any) => c.text), rows: card.rows.map((c: any) => `${c.label}:${c.text}`), flags: card.flags, deepStatus: card.deepStatus }, null, 1));
    console.log('需要注意（库里）:', JSON.stringify(db.profile[0].flags));
  }

  const sum = (f: (u: any) => number) => db.aiUsage.reduce((s: number, u: any) => s + f(u), 0);
  console.log(`\n—— 费用 ——`);
  console.log(`调用 ${db.aiUsage.length} 次；输入命中缓存 ${sum((u) => u.hitTokens)} / 未命中 ${sum((u) => u.missTokens)} / 输出 ${sum((u) => u.outTokens)} tokens；空闲时段=${db.aiUsage[0]?.offpeak}`);
  console.log(`模型费 ¥${(sum((u) => Number(u.costMicro)) / 1e6).toFixed(4)}，手续费 ¥${(sum((u) => Number(u.feeMicro)) / 1e6).toFixed(4)}，余额 ¥${(Number(db.aiWallet[0].balance) / 1e6).toFixed(4)}`);
  const ledger = await wallet.ledger(UID, undefined, undefined);
  console.log('明细:', JSON.stringify(ledger.items.map((i: any) => `${i.title} ${i.kind === 'topup' ? '+' : '-'}${i.amount}${i.ownKey ? '（自己的 Key）' : ''}`)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
