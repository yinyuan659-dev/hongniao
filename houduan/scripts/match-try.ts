/**
 * 本机不连数据库，把「每日推荐 → 喜欢 / 跳过 → 互相喜欢 → 能不能聊天」整套流程跑一遍，每一步自己核对结果。
 * 数据库是内存里的假的，AI 也是假的（不花钱），不碰服务器。
 *
 * 用法（PowerShell）：
 *   cd houduan; npx ts-node -T scripts/match-try.ts
 * 全部通过最后一行是「全部通过」；有一条不对会直接报错退出。
 */
import { HnService } from '../src/hn/hn.service';
import { MatchService } from '../src/match/match.service';
import { AiPayException } from '../src/ai/ai-gateway.service';
import { assertCanChat, assertCanVideo, getMatchConfig, nextRecAt, recDay, relationOf, setMatchConfig } from '../src/common/chat-gate';
import { templateFor } from '../src/hn/interview.template';

// ---------- 内存里的假数据库（只实现了用到的那些查询写法） ----------

function test(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries<any>(where).every(([k, v]) => {
    if (k === 'OR') return v.some((w: any) => test(row, w));
    if (k === 'AND') return v.every((w: any) => test(row, w));
    if (k === 'NOT') return !test(row, v);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      // 复合唯一键：{ userId_targetId: { userId, targetId } }
      if (k.includes('_') && !(k in row)) return test(row, v);
      const x = row[k];
      if ('in' in v && !v.in.includes(x)) return false;
      if ('notIn' in v && v.notIn.includes(x)) return false;
      if ('not' in v && x === v.not) return false;
      if ('startsWith' in v && !String(x ?? '').startsWith(v.startsWith)) return false;
      if ('lt' in v && !(x < v.lt)) return false;
      if ('gt' in v && !(x > v.gt)) return false;
      return true;
    }
    return row[k] === v;
  });
}

function fakeDb() {
  let seq = 100n;
  const tables: Record<string, any[]> = {};
  const DEFAULTS: Record<string, any> = {
    matchAction: { source: 'browse', quotaDay: null, likedAt: null, matchedAt: null, seen: false, matchSeen: false },
    matchReason: { text: '', icebreakers: null },
    matchRec: { sort: 0, score: 0 },
  };
  const model = (name: string) => {
    const rows = (tables[name] ??= []);
    const order = (list: any[], orderBy: any) => {
      const keys = ([] as any[]).concat(orderBy ?? []).flatMap((o) => Object.entries<string>(o));
      return [...list].sort((a, b) => {
        for (const [k, dir] of keys) {
          if (a[k] === b[k]) continue;
          return (a[k] > b[k] ? 1 : -1) * (dir === 'desc' ? -1 : 1);
        }
        return 0;
      });
    };
    const api = {
      findMany: async ({ where, orderBy, take }: any = {}) => order(rows.filter((r) => test(r, where)), orderBy).slice(0, take ?? 1e9),
      findFirst: async (a: any = {}) => (await api.findMany(a))[0] ?? null,
      findUnique: async ({ where }: any) => rows.find((r) => test(r, where)) ?? null,
      count: async ({ where }: any = {}) => rows.filter((r) => test(r, where)).length,
      create: async ({ data }: any) => {
        const row = { id: ++seq, createdAt: new Date(), updatedAt: new Date(), ...(DEFAULTS[name] ?? {}), ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => Object.assign(rows.find((r) => test(r, where)), data, { updatedAt: new Date() }),
      updateMany: async ({ where, data }: any) => rows.filter((r) => test(r, where)).forEach((r) => Object.assign(r, data)),
      upsert: async ({ where, create, update }: any) => {
        const row = rows.find((r) => test(r, where));
        return row ? Object.assign(row, update, { updatedAt: new Date() }) : api.create({ data: create });
      },
    };
    return api;
  };
  const prisma: any = new Proxy({ $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)) }, {
    get: (t: any, k: string) => t[k] ?? (t[k] = model(k)),
  });
  return { prisma, tables };
}

// ---------- 假用户 ----------

const MALE = {
  birthYear: ['1996'], height: ['176'], city: ['成都'], hometown: ['绵阳'], education: ['本科'], job: ['程序员'], income: ['1 万～2 万'],
  marital: ['未婚'], house: ['已买房，有贷款'], car: ['有车'], wantKids: ['想要'], marryPlan: ['一到两年'], smoke: ['不抽烟'], drink: ['偶尔喝'],
  hobbies: ['户外爬山', '做饭', '旅行'], intro: ['性格慢热，熟了以后话挺多。'],
  prefAge: ['相差 5 岁以内'], prefHeight: ['160 以上'], prefEducation: ['大专及以上'], prefMarital: ['只接受未婚'], prefDistance: ['只找同城'],
  brideGive: ['10～20 万'], bridePay: ['按月给'], kidsBefore: ['先领证结婚，再要孩子'], dealbreakers: ['抽烟'],
};
const FEMALE = {
  birthYear: ['1998'], height: ['163'], city: ['成都'], hometown: ['绵阳'], education: ['本科'], job: ['教师'], income: [],
  marital: ['未婚'], house: [], car: [], wantKids: ['想要'], marryPlan: ['一到两年'], smoke: ['不抽烟'], drink: ['不喝酒'],
  hobbies: ['做饭', '旅行', '看书'], intro: ['开朗爱笑。'],
  prefAge: ['相差 5 岁以内'], prefHeight: ['170 以上'], prefEducation: ['大专及以上'], prefMarital: ['只接受未婚'], prefDistance: ['只找同城'],
  prefIncome: ['1 万以上'], prefHouse: ['不限'],
  brideWant: ['10～20 万'], bridePay: ['可以按月给'], kidsBefore: ['先领证结婚，再要孩子'], dealbreakers: [],
};

let failed = 0;
function ok(cond: boolean, what: string) {
  console.log(`${cond ? '  ✓' : '  ✗'} ${what}`);
  if (!cond) failed++;
}
/** fn 应该被拒绝。reason 写了就还要核对原因码；写 '' 表示只要被拒绝就行 */
async function fails(fn: () => Promise<unknown>, reason: string, what: string) {
  try {
    await fn();
    ok(false, `${what}（应该被拒绝，却通过了）`);
  } catch (e: any) {
    if (!e?.getStatus) throw e; // 不是业务上的拒绝，是代码出错了
    const got = e?.reason ?? e?.code ?? '';
    ok(!reason || got === reason, `${what} → 被拒绝：${e?.message}${!reason || got === reason ? '' : `（原因码 ${got}，应该是 ${reason}）`}`);
  }
}

async function main() {
  const { prisma, tables } = fakeDb();
  const hn = new HnService(prisma);
  const frames: { to: string[]; frame: any }[] = [];
  const registry: any = { deliver: async (ids: bigint[], frame: any) => void frames.push({ to: ids.map(String), frame }) };
  const im: any = {
    getOrCreateSingleConversation: async (a: bigint, b: bigint) => {
      const [min, max] = a < b ? [a, b] : [b, a];
      return (await prisma.conversation.findUnique({ where: { pairKey: `${min}_${max}` } }))
        ?? prisma.conversation.create({ data: { pairKey: `${min}_${max}`, userAId: min, userBId: max, lastMsgAt: new Date() } });
    },
  };
  /** 假 AI：poor 里的人没有余额也没有 Key */
  const poor = new Set<string>();
  const aiCalls: string[] = [];
  const gateway: any = {
    chat: async (o: any) => {
      if (poor.has(o.userId.toString())) throw new AiPayException('no_balance', '余额不够了');
      aiCalls.push(`${o.feature}:${o.userId}:${o.groupKey}`);
      return { content: o.feature === 'ice' ? '{"lines":["听说你也喜欢做饭，最拿手哪道菜？","周末一般去哪儿爬山？"]}' : '{"reason":"你们都喜欢做饭和旅行，也都想一到两年内结婚。"}', payMode: 'platform', fellBack: false };
    },
  };
  const match = new MatchService(prisma, gateway, registry, im);

  /** 建一个人：答完点选问答并确认（skip 里的题不答，用来造「没填完」的人） */
  async function person(id: bigint, nickname: string, gender: number, patch: Record<string, string[]> = {}, opt: { skip?: string[]; noConfirm?: boolean } = {}) {
    await prisma.user.create({ data: { id, nickname, gender, avatar: '', age: 0, cityName: '', status: 0, hidden: false, deviceId: `web_${id}` } });
    const answers: Record<string, string[]> = { ...(gender === 1 ? MALE : FEMALE), ...patch };
    for (const q of templateFor(gender)) {
      if (opt.skip?.includes(q.key) || !(q.key in answers)) continue;
      await hn.answer(id, q.key, answers[q.key]);
    }
    if (!opt.noConfirm && !opt.skip?.length) await hn.confirm(id);
    // 老用户：确认过，但后来加的彩礼三题还没答
    if (opt.skip?.length && !opt.noConfirm) await prisma.profile.update({ where: { userId: id }, data: { confirmedAt: new Date() } });
  }

  console.log('\n【1】推荐日和设置');
  ok(recDay(new Date('2026-11-23T01:59:00Z')) === '2026-11-22', '北京时间 9:59 还算前一天');
  ok(recDay(new Date('2026-11-23T02:00:00Z')) === '2026-11-23', '北京时间 10:00 换成新的一天');
  ok(nextRecAt(new Date('2026-11-23T03:00:00Z')).toISOString() === '2026-11-24T02:00:00.000Z', '下一批是第二天上午 10 点');
  const cfg0 = await getMatchConfig(prisma, true);
  ok(cfg0.dailyRecs === 3 && cfg0.dailyLikes === 3 && cfg0.videoNeedLike === true, '默认：每天推荐 3 位、喜欢 3 个、视频见面要互相喜欢');

  console.log('\n【2】挑人：硬条件互相符合');
  const M = 1n;
  await person(M, '男·小周', 1);
  await person(11n, '女·合适甲', 2);
  await person(12n, '女·合适乙（兴趣少）', 2, { hobbies: ['游戏'], hometown: ['南充'], marryPlan: ['顺其自然'] });
  await person(13n, '女·合适丙（不要彩礼）', 2, { brideWant: ['不要彩礼'], bridePay: ['不要彩礼，不涉及'], hobbies: ['做饭'] });
  await person(14n, '女·合适丁', 2, { hobbies: ['户外爬山'], brideWant: ['按当地习俗，可以商量'] });
  await person(21n, '女·彩礼要 30 万以上', 2, { brideWant: ['30 万以上'] });
  await person(22n, '女·要一次性给', 2, { bridePay: ['要一次性给'] });
  await person(23n, '女·领证彩礼都到位才要孩子', 2, { kidsBefore: ['领证、彩礼都到位，再要孩子'] });
  await person(24n, '女·不打算要孩子', 2, { kidsBefore: ['不打算要孩子，不涉及'], wantKids: ['不想要'] });
  await person(25n, '女·外地', 2, { city: ['上海'] });
  await person(26n, '女·要对方 180 以上', 2, { prefHeight: ['180 以上'] });
  await person(27n, '女·要月收入 3 万以上', 2, { prefIncome: ['3 万以上'] });
  await person(28n, '女·抽烟', 2, { smoke: ['偶尔抽'] });
  await person(29n, '女·离异', 2, { marital: ['离异未育'] });
  await person(30n, '女·大 8 岁', 2, { birthYear: ['1988'] });
  await person(31n, '女·彩礼三题没答', 2, {}, { skip: ['brideWant', 'bridePay', 'kidsBefore'] });
  await person(32n, '女·问答没确认', 2, {}, { noConfirm: true });
  await person(33n, '男·同性', 1);
  await prisma.user.create({ data: { id: 34n, nickname: '女·被隐藏', gender: 2, avatar: '', age: 0, cityName: '', status: 0, hidden: true, deviceId: 'web_34' } });

  let t: any = await match.today(M);
  const names = async (ids: string[]) => (await prisma.user.findMany({ where: { id: { in: ids.map(BigInt) } } })).map((u: any) => u.nickname);
  ok(t.ready && t.list.length === 3, `给小周挑了 ${t.list.length} 位（应该 3 位）`);
  const first = t.list.map((x: any) => x.user.id.toString());
  ok(first[0] === '11', `排第一的是共同点最多的「合适甲」：${(await names(first)).join('、')}`);
  ok(first.every((id: string) => ['11', '12', '13', '14'].includes(id)), '挑出来的全是硬条件对得上的人，没有混进对不上的');
  ok(t.list[0].tags.includes('同城') && t.list[0].tags.includes('都爱做饭'), `共同点：${t.list[0].tags.join('、')}`);
  ok(t.list.every((x: any) => x.reason), `有余额时 AI 写了推荐理由：${t.list[0].reason}`);
  ok(aiCalls.length === 3 && aiCalls.every((c) => c === `reason:1:reason:${recDay()}`), `AI 调了 ${aiCalls.length} 次，都记在看推荐的人（小周）名下`);
  t = await match.today(M);
  ok(aiCalls.length === 3, '再进一次推荐页：理由用存下来的，没有再调 AI');
  ok(t.list.map((x: any) => x.user.id.toString()).join() === first.join(), '同一天再进来，还是这 3 位');

  console.log('\n【3】没有余额也没有 Key');
  poor.add('11');
  t = await match.today(11n);
  ok(t.list.length === 2 && t.list.some((x: any) => x.user.id === M), `女·合适甲 这边一共只有 2 位男生，有几位给几位（${t.list.length} 位）`);
  ok(t.list[0].reason === '' && t.list[0].tags.length > 0, `没有余额：没有 AI 理由，只显示共同点：${t.list[0].tags.join('、')}`);

  console.log('\n【4】没填完基本情况');
  t = await match.today(31n);
  ok(t.ready === false && t.list.length === 0, '彩礼三题没答的人：不给推荐，提示先填完');
  await fails(() => match.like(31n, M), 'need_profile', '彩礼三题没答的人点喜欢');
  await fails(() => match.like(32n, M), 'need_profile', '问答没确认的人点喜欢');

  console.log('\n【5】喜欢、跳过、名额');
  frames.length = 0;
  let r: any = await match.like(M, 11n);
  ok(r.state === 'liked' && !r.matched && r.quota.left === 3, '喜欢推荐里的「合适甲」：不占名额（还剩 3 个）');
  ok(frames.some((f) => f.to[0] === '11' && f.frame.event === 'liked'), '对方收到「有人喜欢你」的提醒');
  await match.pass(M, first[1] === '11' ? BigInt(first[2]) : BigInt(first[1]));
  t = await match.today(M);
  ok(t.list.filter((x: any) => x.state === 'none').length === 1, '喜欢 1 位、跳过 1 位后，还剩 1 位没看');
  // 遇见里自己点：占名额
  r = await match.like(M, 25n);
  ok(r.quota.left === 2, '在遇见里喜欢一个不在推荐里的人：占 1 个名额（还剩 2 个）');
  await match.unlike(M, 25n);
  ok((await match.relation(M, 25n)).state === 'none' && (await match.relation(M, 25n)).quota.left === 2, '取消喜欢：关系回到没表态，名额不退');
  r = await match.like(M, 25n);
  ok(r.quota.left === 2, '当天重新喜欢同一个人：不再多占名额');
  await match.like(M, 26n);
  await match.like(M, 27n);
  await fails(() => match.like(M, 28n), 'like_quota', '第 4 个');
  await setMatchConfig(prisma, { dailyLikes: 5 });
  r = await match.like(M, 28n);
  ok(r.quota.limit === 5 && r.quota.left === 1, '后台把每天的名额改成 5 个后，能继续喜欢');
  await fails(() => setMatchConfig(prisma, { dailyRecs: 99 }), '', '后台填 99 位');
  await fails(() => match.like(M, 33n), '', '喜欢同性');

  console.log('\n【6】喜欢列表');
  let l: any = await match.list(11n, 'likedMe');
  ok(l.list.length === 1 && l.list[0].user.id === M && l.list[0].isNew, '合适甲的「喜欢我的」里有小周，带新标记');
  let s: any = await match.summary(11n);
  ok(s.likedMe === 1 && s.likedMeNew === 0, '看过列表后，消息页的红点清掉（喜欢我的 1 人、新的 0 人）');
  l = await match.list(M, 'liked');
  ok(l.list.length === 5, `小周的「我喜欢的」有 ${l.list.length} 人`);

  console.log('\n【7】没互相喜欢：消息、语音放开，视频要互相喜欢');
  let rel: any = await assertCanChat(prisma, M, 11n);
  ok(rel.canChat && rel.chatReason === 'open' && rel.state === 'liked', '小周能给还没回应的合适甲发消息（关系：我喜欢了）');
  rel = await assertCanChat(prisma, 11n, M);
  ok(rel.canChat && rel.state === 'likedMe', '合适甲也能先给小周发消息（关系：对方先喜欢了我）');
  ok((await assertCanChat(prisma, M, 14n)).state === 'none' && (await assertCanChat(prisma, 31n, M)).canChat, '都没表态的两个人、没填完基本情况的人，也都能发');
  ok(rel.canVideo === false && rel.videoReason === 'need_like', '关系里写着：现在还不能视频（没互相喜欢）');
  await fails(() => assertCanVideo(prisma, M, 11n), 'need_like', '小周给还没回应的合适甲打视频');
  await fails(() => assertCanVideo(prisma, 11n, M), 'need_like', '合适甲给小周打视频');
  await fails(() => setMatchConfig(prisma, { videoNeedLike: 'no' as any }), '', '后台把开关填成不是 true / false 的东西');
  ok((await setMatchConfig(prisma, { videoNeedLike: false })).videoNeedLike === false, '后台把「视频见面要互相喜欢」关掉');
  rel = await assertCanVideo(prisma, M, 11n);
  ok(rel.canVideo && rel.videoReason === 'ok' && rel.state === 'liked', '开关关着：没互相喜欢也能视频（测试用）');
  ok((await setMatchConfig(prisma, { dailyRecs: 3 })).videoNeedLike === false, '改别的设置不会动这个开关');
  ok((await setMatchConfig(prisma, { videoNeedLike: true })).videoNeedLike === true, '再打开');
  await fails(() => assertCanVideo(prisma, M, 11n), 'need_like', '开关打开后，没互相喜欢的视频又被拒绝');

  console.log('\n【8】互相喜欢');
  frames.length = 0;
  r = await match.like(11n, M);
  ok(r.matched && r.state === 'mutual' && !!r.conversationId, '合适甲点「也喜欢」：马上互相喜欢，返回会话');
  ok(r.quota.used === 0, '回应对方的喜欢不占名额');
  ok(frames.some((f) => f.to[0] === '1' && f.frame.event === 'matched' && f.frame.data.peer.id === '11'), '小周那边同时收到「互相喜欢了」');
  ok((await assertCanChat(prisma, M, 11n)).chatReason === 'mutual' && (await assertCanChat(prisma, 11n, M)).canChat, '两边照常能发消息');
  ok((await assertCanVideo(prisma, M, 11n)).canVideo && (await assertCanVideo(prisma, 11n, M)).videoReason === 'ok', '互相喜欢了：两边都能视频');
  s = await match.summary(M);
  ok(s.mutual === 1 && s.newMatches.length === 1 && s.newMatches[0].peer.id === 11n, '小周下次打开 App：有 1 个还没看过的互相喜欢（补弹庆祝页）');
  await match.seen(M, 11n);
  ok((await match.summary(M)).newMatches.length === 0 && (await match.summary(11n)).newMatches.length === 0, '看过以后不再弹；点喜欢的那一方当场已经看过');
  const ice = await match.icebreakers(M, 11n);
  ok(ice.lines.length === 2, `AI 给小周想了开场白：${ice.lines.join(' / ')}`);
  const n = aiCalls.length;
  await match.icebreakers(M, 11n);
  ok(aiCalls.length === n, '开场白写过一次就存下来，不重复调 AI');
  ok((await match.icebreakers(11n, M)).lines.length === 0, '合适甲没有余额：没有开场白');
  ok((await match.icebreakers(M, 25n)).lines.length === 0, '没互相喜欢的人：不给开场白');
  await fails(() => match.pass(M, 11n), '', '已经互相喜欢后点「跳过」');
  const card: any = await match.forCard(M, 11n);
  ok(card.state === 'mutual' && card.recommended && card.reason && card.tags.length > 0, '画像网页：互相喜欢、有「为什么推荐给你」');
  ok((await match.forCard(M, 25n)).recommended === false, '不是推荐来的人：画像上没有「为什么推荐给你」');

  console.log('\n【9】跳过 / 不合适：对方不知道，以后不再互相推荐');
  await match.pass(13n, M);
  ok((await match.list(13n, 'likedMe')).list.length === 0, '合适丙跳过了小周');
  t = await match.today(13n);
  ok(t.list.every((x: any) => x.user.id !== M), '合适丙的推荐里不再有小周');
  frames.length = 0;
  await match.like(M, 13n).catch(() => undefined);
  ok(!frames.some((f) => f.to[0] === '13'), '小周喜欢合适丙：对方跳过了他，不提醒对方');
  ok((await match.list(13n, 'likedMe')).list.length === 0, '合适丙的「喜欢我的」里也看不到小周');

  console.log('\n【10】不合适，不再联系');
  frames.length = 0;
  await match.end(11n, M);
  await fails(() => assertCanChat(prisma, M, 11n), 'chat_ended', '对方结束后，小周再发消息');
  await fails(() => assertCanChat(prisma, 11n, M), 'chat_ended', '结束的那一方自己再发消息');
  await fails(() => assertCanVideo(prisma, M, 11n), 'chat_ended', '结束后打视频');
  rel = await relationOf(prisma, M, 11n);
  ok(rel.state === 'ended' && rel.endedBy === 'peer' && !rel.canChat && !rel.canVideo && rel.videoReason === 'ended', '小周这边显示「对方已结束聊天」');
  ok(frames.some((f) => f.to[0] === '1' && f.frame.event === 'ended'), '小周在线的话聊天页马上变成不能发');
  await fails(() => match.like(M, 11n), '', '结束后再点喜欢');

  console.log('\n【11】「不再联系」任何时候都能点');
  // 14 和小周互相都没表态：以前这种情况点不了（「你们还没有开始聊天」），现在谁都可能先发来消息，所以放开
  ok((await relationOf(prisma, 14n, M)).state === 'none', '合适丁和小周之间什么关系都没有');
  frames.length = 0;
  r = await match.end(14n, M);
  ok(r.state === 'ended', '合适丁对没表态过的小周点「不再联系」');
  await fails(() => assertCanChat(prisma, M, 14n), 'chat_ended', '之后小周再给合适丁发消息');
  ok((await relationOf(prisma, M, 14n)).chatReason === 'ended_peer' && (await relationOf(prisma, 14n, M)).chatReason === 'ended_me', '两边看到的原因各自是对的');
  // 26 是小周单方面喜欢的人：对方可以直接结束
  await match.end(26n, M);
  await fails(() => assertCanChat(prisma, M, 26n), 'chat_ended', '被我喜欢的人点了「不再联系」后，我再发消息');
  ok((await match.end(26n, M)).state === 'ended', '重复点一次不报错');
  await fails(() => match.end(M, 9999n), '', '对不存在的人点「不再联系」');
  await setMatchConfig(prisma, { videoNeedLike: false });
  await fails(() => assertCanVideo(prisma, M, 14n), 'chat_ended', '就算把视频的开关关了，结束了联系的两个人也不能视频');
  await setMatchConfig(prisma, { videoNeedLike: true });

  console.log(`\n库里：喜欢记录 ${tables.matchAction.length} 条，推荐记录 ${tables.matchRec.length} 条，AI 理由 ${tables.matchReason.length} 条，AI 调用 ${aiCalls.length} 次`);
  if (failed) {
    console.log(`\n有 ${failed} 条不对`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
