import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { TgGrowthService } from './tg-growth.service';

/** 后台：匿名投稿机器人 + 推广频道增长统计（挂在 AdminModule，复用 AdminGuard） */
@Controller('admin/tg-growth')
@UseGuards(AdminGuard)
export class TgGrowthController {
  constructor(private readonly growth: TgGrowthService) {}

  @Get('status')
  status() {
    return this.growth.status();
  }

  @Put('settings')
  saveSettings(@Body() body: { channel?: string; enabled?: boolean; ai?: boolean; auto?: boolean; daily?: number }) {
    return this.growth.saveSettings(body ?? {});
  }

  @Put('token')
  saveToken(@Body() body: { token?: string }) {
    return this.growth.saveToken(body?.token ?? '');
  }

  @Get('stats')
  stats(@Query('days') days?: string) {
    return this.growth.stats(Number(days) || 30);
  }

  @Post('stats/refresh')
  async refresh() {
    await this.growth.collectStats();
    return this.growth.stats(30);
  }

  @Get('submissions')
  submissions(@Query('status') status?: string, @Query('page') page?: string) {
    return this.growth.submissions(status, Number(page) || 1);
  }

  @Post('submissions/:id/publish')
  publish(@Param('id', ParseIntPipe) id: number) {
    return this.growth.adminPublish(id);
  }

  @Post('submissions/:id/reject')
  reject(@Param('id', ParseIntPipe) id: number) {
    return this.growth.adminReject(id);
  }
}
