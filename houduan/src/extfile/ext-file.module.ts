import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../admin/admin.guard';
import { ExtFileService } from './ext-file.service';
import { ExtFileAdminController, ExtFileDownloadController, ExtFileOpenController, ExtKeyGuard } from './ext-file.controller';

/** 外部文件接口：第三方凭接入密钥上传（≤100MB，存 MinIO 私有桶），后台查看 / 下载 / 管理密钥 */
@Module({
  imports: [AuthModule],
  controllers: [ExtFileOpenController, ExtFileAdminController, ExtFileDownloadController],
  providers: [ExtFileService, ExtKeyGuard, AdminGuard],
})
export class ExtFileModule {}
