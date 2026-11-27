/**
 * 本机不连数据库，核对「视频按分钟收牵豆」里几个算数的地方（common/video-fee.ts）。
 * 真正的扣费、挂断要在服务器上用两个测试号实测（deploy/video_fee_live_test.py）。
 *
 * 用法（PowerShell）：cd houduan; npx ts-node -T scripts/video-fee-try.ts
 */
import { beans, getVideoPriceMicro, minutesAffordable, minutesDue, payerOf, setVideoPrice } from '../src/common/video-fee';

let failed = 0;
function ok(cond: boolean, label: string) {
  if (!cond) failed++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
}

/** 只有 sys_setting 一张表的假数据库 */
function fakePrisma() {
  const rows = new Map<string, string>();
  return {
    sysSetting: {
      findUnique: async ({ where }: any) => (rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null),
      upsert: async ({ where, create, update }: any) => { rows.set(where.key, rows.has(where.key) ? update.value : create.value); },
    },
    rows,
  } as any;
}

async function main() {
  console.log('【牵豆的写法】');
  ok(beans(20_000) === '0.02', `0.02 牵豆 → ${beans(20_000)}`);
  ok(beans(4_980_000) === '4.98' && beans(1_000_000) === '1.00' && beans(0) === '0.00', '4.98、1.00、0.00');
  ok(beans(1_000) === '0.001' && beans(1_500) === '0.0015' && beans(80_000) === '0.08', '小数：0.001、0.0015、0.08');

  console.log('【够打几分钟】');
  ok(minutesAffordable(4_980_000, 20_000) === 249, '4.98 牵豆、0.02 一分钟 → 249 分钟');
  ok(minutesAffordable(19_999, 20_000) === 0 && minutesAffordable(20_000, 20_000) === 1, '差一点不够 1 分钟 → 0；正好够 → 1');
  ok(minutesAffordable(1_000_000, 0) === 0, '价格是 0 时不算分钟数');

  console.log('【通话到现在应该扣到第几分钟】');
  const t0 = new Date('2026-11-27T12:00:00Z');
  const at = (sec: number) => minutesDue(t0, new Date(t0.getTime() + sec * 1000));
  ok(at(0) === 1 && at(59.9) === 1, '接通那一刻、59.9 秒：第 1 分钟');
  ok(at(60) === 2 && at(119) === 2 && at(125) === 3, '60 秒进第 2 分钟，125 秒是第 3 分钟');
  ok(at(-5) === 1, '时钟有点偏差（现在比接通还早）也按第 1 分钟');

  console.log('【谁付】');
  ok(payerOf({ id: 1n, gender: 1 }, { id: 2n, gender: 2 }) === 1n, '男打给女：男付');
  ok(payerOf({ id: 2n, gender: 2 }, { id: 1n, gender: 1 }) === 1n, '女打给男：还是男付');

  console.log('【后台改价】');
  const prisma = fakePrisma();
  ok((await getVideoPriceMicro(prisma, true)) === 20_000, '没设置过：默认 0.02');
  ok((await setVideoPrice(prisma, 0.05)) === 50_000 && (await getVideoPriceMicro(prisma)) === 50_000, '改成 0.05，马上生效');
  ok((await setVideoPrice(prisma, 0)) === 0 && (await getVideoPriceMicro(prisma, true)) === 0, '改成 0 = 不收费');
  ok((await setVideoPrice(prisma, 0.0015)) === 1_500, '4 位小数可以');
  for (const bad of [-1, 101, 0.00001, NaN, '0.02', null, undefined]) {
    let threw = false;
    try { await setVideoPrice(prisma, bad as any); } catch { threw = true; }
    ok(threw, `填 ${String(bad)}（${typeof bad}）被拒绝`);
  }
  ok((await getVideoPriceMicro(prisma, true)) === 1_500, '被拒绝的那几次没有改到价格');
  prisma.rows.set('video_price_micro', 'abc');
  ok((await getVideoPriceMicro(prisma, true)) === 20_000, '库里存了乱七八糟的东西：按默认 0.02');

  console.log(failed ? `\n有 ${failed} 条不对` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main();
