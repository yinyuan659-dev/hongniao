import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Throttle } from '../common/rate-limit.guard';
import { MatchService } from './match.service';

function toId(v: string): bigint {
  if (!/^\d{1,19}$/.test(v)) throw new BadRequestException('用户不存在');
  return BigInt(v);
}

/** 每日推荐、喜欢 / 跳过、互相喜欢 */
@Controller('match')
@UseGuards(JwtAuthGuard)
export class MatchController {
  constructor(private readonly match: MatchService) {}

  /** 今天的推荐（广场 → 遇见 → 推荐） */
  @Get('today')
  today(@CurrentUser() userId: bigint) {
    return this.match.today(userId);
  }

  /** 消息页顶上的三个数字 + 还没看过的互相喜欢 */
  @Get('summary')
  summary(@CurrentUser() userId: bigint) {
    return this.match.summary(userId);
  }

  /** 喜欢列表：tab = likedMe | liked | mutual */
  @Get('list')
  list(@CurrentUser() userId: bigint, @Query('tab') tab = 'likedMe') {
    return this.match.list(userId, tab);
  }

  /** 我和某个人的关系：能不能聊、画像底部该显示哪种按钮 */
  @Get('relation/:id')
  relation(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.match.relation(userId, toId(id));
  }

  @Post('like/:id')
  @Throttle(60, 60)
  like(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.match.like(userId, toId(id));
  }

  /** 跳过 / 不合适 */
  @Post('pass/:id')
  pass(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.match.pass(userId, toId(id));
  }

  /** 取消喜欢（对方还没回应时） */
  @Post('unlike/:id')
  unlike(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.match.unlike(userId, toId(id));
  }

  /** 不合适，不再联系 */
  @Post('end/:id')
  end(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.match.end(userId, toId(id));
  }

  /** 举报这个人：{ reason } */
  @Post('report/:id')
  @Throttle(10, 60)
  report(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.match.report(userId, toId(id), String(body?.reason ?? ''));
  }

  /** 庆祝页看过了 */
  @Post('seen/:id')
  seen(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.match.seen(userId, toId(id));
  }

  /** 互相喜欢后，AI 帮我想的开场白（有余额或 Key 才有，没有返回空数组） */
  @Post('icebreakers/:id')
  @Throttle(20, 60)
  icebreakers(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.match.icebreakers(userId, toId(id));
  }
}
