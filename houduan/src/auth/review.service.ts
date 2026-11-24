import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** App Store 审核用演示账号：账号 11111111111，密码 DEMO_PASSWORD（默认 123456），只在审核模式开着时能登 */
export const DEMO_USERNAME = '11111111111';
const demoPassword = () => process.env.DEMO_PASSWORD || '123456';
export const DEMO_DEVICE_ID = 'demo_' + DEMO_USERNAME;
const KEY_REVIEW_IOS = 'review_mode_ios';

/**
 * iOS 审核模式：
 * - 开关 review_mode_ios（后台可切，默认开）。开着时 iOS 启动显示「账号 + 密码」登录页；关掉后回到一机一号逻辑。
 * - 演示账号内容从平台第一个男用户复制（昵称/头像/年龄/签名），城市固定成都。
 */
@Injectable()
export class ReviewService {
  private readonly logger = new Logger('Review');

  constructor(private readonly prisma: PrismaService) {}

  /** 公开：客户端启动时读取 */
  async publicStatus() {
    const row = await this.prisma.sysSetting.findUnique({ where: { key: KEY_REVIEW_IOS } });
    // 未设置过 = 默认开启
    return { ios: row ? row.value === '1' : true };
  }

  async adminStatus() {
    const s = await this.publicStatus();
    const demo = await this.prisma.user.findUnique({ where: { deviceId: DEMO_DEVICE_ID } });
    return {
      ...s,
      demo: demo
        ? { id: demo.id, shortId: demo.shortId, nickname: demo.nickname, cityName: demo.cityName, username: DEMO_USERNAME, password: demoPassword() }
        : null,
    };
  }

  async setIos(enabled: boolean) {
    await this.prisma.sysSetting.upsert({
      where: { key: KEY_REVIEW_IOS },
      update: { value: enabled ? '1' : '0' },
      create: { key: KEY_REVIEW_IOS, value: enabled ? '1' : '0' },
    });
    if (enabled) await this.ensureDemoUser();
    return this.adminStatus();
  }

  /** 账号密码登录（仅演示账号；密码不校验，只要账号对） */
  async demoLogin(username: string, password: string) {
    // 2026-10-14 收紧:以前密码不校验、审核模式关了也能登,任何人都能拿这个号。
    // 现在:只在 iOS 审核模式开着时可用,密码要对(环境变量 DEMO_PASSWORD,默认 123456,和 App Store Connect 里给审核员的一致)。
    if (!(await this.publicStatus()).ios) throw new BadRequestException('账号或密码错误');
    if ((username ?? '').trim() !== DEMO_USERNAME) throw new BadRequestException('账号或密码错误');
    if (!(password ?? '').trim()) throw new BadRequestException('请输入密码');
    if ((password ?? '').trim() !== demoPassword()) throw new BadRequestException('账号或密码错误');
    const user = await this.ensureDemoUser();
    if (user.status !== 0) throw new BadRequestException('账号异常');
    return user;
  }

  /** 创建/刷新演示账号：从第一个男用户复制资料，城市成都 */
  async ensureDemoUser(refresh = false) {
    let user = await this.prisma.user.findUnique({ where: { deviceId: DEMO_DEVICE_ID } });
    const src = await this.prisma.user.findFirst({ where: { gender: 1, deviceId: { not: DEMO_DEVICE_ID } }, orderBy: { id: 'asc' } });
    const profile = {
      nickname: src?.nickname || '心之音体验',
      avatar: src?.avatar || '',
      age: src?.age && src.age >= 18 ? src.age : 26,
      signature: src?.signature || '',
      cityCode: '510100',
      cityName: '成都',
      latitude: 30.5728,
      longitude: 104.0668,
    };
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          deviceId: DEMO_DEVICE_ID,
          shortId: await this.genShortId(),
          gender: 1,
          ...profile,
        },
      });
      this.logger.log(`demo user created #${user.id} from #${src?.id}`);
    } else if (refresh) {
      user = await this.prisma.user.update({ where: { id: user.id }, data: profile });
    }
    // 复制源用户的照片墙（演示账号没有时）
    if (src) {
      const has = await this.prisma.userAlbum.count({ where: { userId: user.id } });
      if (has === 0) {
        const albums = await this.prisma.userAlbum.findMany({ where: { userId: src.id }, orderBy: { sort: 'asc' } });
        if (albums.length) {
          await this.prisma.userAlbum.createMany({ data: albums.map((a) => ({ userId: user!.id, type: a.type, url: a.url, coverUrl: a.coverUrl, sort: a.sort })) });
        }
      }
    }
    return user;
  }

  isDemo(deviceId: string) {
    return deviceId === DEMO_DEVICE_ID;
  }

  private async genShortId(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const id = String(Math.floor(100000 + Math.random() * 900000));
      if (!(await this.prisma.user.findUnique({ where: { shortId: id } }))) return id;
    }
    throw new Error('短号生成失败');
  }
}
