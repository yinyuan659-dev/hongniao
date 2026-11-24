import { Controller, Post, UploadedFile, UseGuards, UseInterceptors, Param, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { unlink } from 'fs/promises';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../admin/admin.guard';
import { Throttle } from '../common/rate-limit.guard';
import { FILE_MAX_SIZE, UploadService, VIDEO_MAX_SIZE } from './upload.service';

@Controller('upload')
export class UploadController {
  constructor(private readonly uploads: UploadService) {}

  /** 注册头像上传：注册时还没有 token，免登录，仅图片、限 10MB、按 IP 限频 */
  @Post('avatar')
  @Throttle(15, 3600)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  avatar(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('缺少文件');
    return this.uploads.upload('image', file);
  }

  /**
   * 后台上传 Android 安装包（管理员）：存到 MinIO apk/ 目录，返回可直接填进「APK 地址」的完整下载链接。
   * 放在 /api/upload/ 下是为了复用 nginx 对上传路径放开的 210m 包体限制。
   */
  @Post('apk')
  @UseGuards(AdminGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  apk(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('缺少文件');
    return this.uploads.uploadApk(file);
  }

  /** 后台上传图片（管理员 token；后台录入树洞配图等） */
  @Post('admin-image')
  @UseGuards(AdminGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  adminImage(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('缺少文件');
    return this.uploads.upload('image', file);
  }

  /** 聊天任意文件（≤ 100MB），返回 { url, name, size, mime }，客户端原样放进 file 消息。要写在 :kind 前面 */
  @Post('file')
  @UseGuards(JwtAuthGuard)
  @Throttle(60, 3600)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir() }),
      // busboy 读满 fileSize 就算超限，正好 100MB 的会被拒；多放 1 字节，真正的上限由 uploadChatFile 判
      limits: { fileSize: FILE_MAX_SIZE + 1, files: 1, fields: 5 },
    }),
  )
  async chatFile(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('缺少文件');
    try {
      return await this.uploads.uploadChatFile(file);
    } finally {
      unlink(file.path).catch(() => undefined);
    }
  }

  /** 视频（≤ 200MB）：落盘再流式写进 MinIO，不放内存。要写在 :kind 前面 */
  @Post('video')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir() }),
      // busboy 读满 fileSize 就算超限，多放 1 字节，真正的上限由 uploadVideoFile 判
      limits: { fileSize: VIDEO_MAX_SIZE + 1, files: 1, fields: 5 },
    }),
  )
  async video(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('缺少文件');
    try {
      return await this.uploads.uploadVideoFile(file);
    } finally {
      unlink(file.path).catch(() => undefined);
    }
  }

  /** kind: image | audio（video 走上面的落盘接口），form-data 字段名 file */
  @Post(':kind')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  upload(@Param('kind') kind: string, @UploadedFile() file?: Express.Multer.File) {
    if (kind !== 'image' && kind !== 'audio') throw new BadRequestException('kind 非法');
    if (!file) throw new BadRequestException('缺少文件');
    return this.uploads.upload(kind, file);
  }
}
