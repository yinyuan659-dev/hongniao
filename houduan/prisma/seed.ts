import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  // 通话参数默认值（后台可调）
  const cfg = await prisma.callConfig.findFirst();
  if (!cfg) {
    await prisma.callConfig.create({ data: { width: 640, height: 480, fps: 25, bitrate: 800 } });
  } else if (cfg.fps === 30) {
    await prisma.callConfig.update({ where: { id: cfg.id }, data: { fps: 25 } });
  }

  // SRS 节点表为空时，把环境变量里的现网 SRS 录为默认节点（后台可继续增删；部署工具以默认节点为复制源）
  if ((await prisma.srsNode.count()) === 0) {
    const ip = (process.env.SRS_SERVER ?? '').trim();
    if (ip) {
      const port = Number(process.env.SRS_API?.match(/:(\d+)\/?$/)?.[1] ?? 1985) || 1985;
      await prisma.srsNode.create({
        data: { name: '节点1', ip, apiPort: port, priority: 100, maxConnections: 40, enabled: true, isDefault: true, remark: '由环境变量 SRS_SERVER 自动录入' },
      });
    }
  }

  // 计费配置：消息 0.1 积分/条；视频成本价 2 分/分钟（640x480@800kbps 双向流量费），平台倍率 x2
  const price = await prisma.priceConfig.findFirst();
  if (!price) {
    await prisma.priceConfig.create({ data: { msgPriceFen: 10, videoBaseFenPerMin: 2, videoPlatformX: 2 } });
  } else if (price.videoBaseFenPerMin === 300) {
    // 旧默认价（300 分 = 平台成本价体系）→ 新的流量成本价体系
    await prisma.priceConfig.update({ where: { id: price.id }, data: { videoBaseFenPerMin: 2, videoPlatformX: 2 } });
  }

  // 管理员账号 admin：初始密码取环境变量 ADMIN_INIT_PASSWORD（部署时必须设置）；没设置时才用本地开发默认值 peiwan@2026（scrypt 哈希）
  const admin = await prisma.adminUser.findUnique({ where: { username: 'admin' } });
  if (!admin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(process.env.ADMIN_INIT_PASSWORD || 'peiwan@2026', salt, 32).toString('hex');
    await prisma.adminUser.create({ data: { username: 'admin', passwordHash: `${salt}:${hash}` } });
  }

  // 给历史用户补 6 位短号
  const noShortId = await prisma.user.findMany({ where: { shortId: null }, select: { id: true } });
  for (const u of noShortId) {
    let sid = '';
    for (let i = 0; i < 20; i++) {
      const candidate = String(Math.floor(100000 + Math.random() * 900000));
      if (!(await prisma.user.findUnique({ where: { shortId: candidate } }))) {
        sid = candidate;
        break;
      }
    }
    if (sid) await prisma.user.update({ where: { id: u.id }, data: { shortId: sid } });
  }

  console.log('seed done');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
