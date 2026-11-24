import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { TgGrowthService } from './tg-growth.service';

/** 推广频道增长（投稿机器人 + 统计）：只有后台接口，控制器 TgGrowthController 挂在 AdminModule */
@Module({
  imports: [TelegramModule],
  providers: [TgGrowthService],
  exports: [TgGrowthService],
})
export class TgGrowthModule {}
