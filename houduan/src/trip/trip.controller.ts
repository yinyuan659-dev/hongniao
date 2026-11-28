import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Throttle } from '../common/rate-limit.guard';
import { TripService } from './trip.service';

function toId(raw: unknown): bigint {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,19}$/.test(s)) throw new BadRequestException('参数不正确');
  return BigInt(s);
}

/**
 * 领队旅行（都要登录）。规则见 trip.service.ts 顶上。
 *   给用户：
 *     GET  /trip/home               大厅「旅行」首页：我的领队 + 他的线路 + 排行榜前三名
 *     GET  /trip/leaders            领队排行榜
 *     GET  /trip/leader/:id         领队页
 *     GET  /trip/detail/:id         线路详情（btn 是底下按钮的样子）
 *     POST /trip/detail/:id/order   约单 = 进这条线路的群 → { groupId, conversationId, name }
 *   给领队（不是领队 403）：
 *     GET  /trip/mine               领队后台首页
 *     POST /trip/create             发布线路 { title, videoUrl, coverUrl, startDate, days, gatherPlace, price, quota, itinerary, feeNote }
 *     POST /trip/mine/:id/update    改线路内容（上架后改的要重新审）
 *     POST /trip/mine/:id/quota     改名额 { quota?, confirmed? }
 *     POST /trip/mine/:id/off       下架
 *     GET  /trip/mine/:id/orders    约单的人
 *     POST /trip/intro              改一句话介绍 { intro }
 *     POST /trip/ai                 发布线路时和 AI 聊 { text, draft } → { draft, missing, reply }
 */
@Controller('trip')
@UseGuards(JwtAuthGuard)
export class TripController {
  constructor(private readonly trips: TripService) {}

  @Get('home')
  home(@CurrentUser() userId: bigint) {
    return this.trips.home(userId);
  }

  @Get('leaders')
  leaders(@CurrentUser() userId: bigint) {
    return this.trips.leaderboard(userId);
  }

  @Get('leader/:id')
  leader(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.trips.leaderPage(userId, toId(id));
  }

  @Get('detail/:id')
  detail(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.trips.detail(userId, toId(id));
  }

  @Post('detail/:id/order')
  @Throttle(20, 60)
  order(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.trips.order(userId, toId(id));
  }

  @Get('mine')
  mine(@CurrentUser() userId: bigint) {
    return this.trips.mine(userId);
  }

  @Post('create')
  @Throttle(10, 60)
  create(@CurrentUser() userId: bigint, @Body() dto: any) {
    return this.trips.create(userId, dto);
  }

  @Post('mine/:id/update')
  @Throttle(10, 60)
  update(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: any) {
    return this.trips.update(userId, toId(id), dto);
  }

  @Post('mine/:id/quota')
  quota(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { quota?: number; confirmed?: number }) {
    return this.trips.setQuota(userId, toId(id), dto ?? {});
  }

  @Post('mine/:id/off')
  off(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.trips.off(userId, toId(id));
  }

  @Get('mine/:id/orders')
  orders(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.trips.orders(userId, toId(id));
  }

  @Post('intro')
  @Throttle(10, 60)
  intro(@CurrentUser() userId: bigint, @Body() dto: { intro?: string }) {
    return this.trips.setIntro(userId, dto?.intro);
  }

  @Post('ai')
  @Throttle(20, 60)
  ai(@CurrentUser() userId: bigint, @Body() dto: { text?: string; draft?: unknown }) {
    return this.trips.ai(userId, dto ?? {});
  }
}
