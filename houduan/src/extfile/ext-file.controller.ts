import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Injectable,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { unlink } from 'fs/promises';
import type { Response } from 'express';
import { AdminGuard } from '../admin/admin.guard';
import { Throttle } from '../common/rate-limit.guard';
import { clientIp } from '../invite/invite.controller';
import { EXT_MAX_SIZE, ExtFileService } from './ext-file.service';

/** 接入密钥：Authorization: Bearer hxf_xxx 或 X-Api-Key: hxf_xxx。守卫先于 multer 执行，没密钥不会落盘 */
@Injectable()
export class ExtKeyGuard implements CanActivate {
  constructor(private readonly files: ExtFileService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const auth = String(req.headers['authorization'] ?? '');
    const raw = (req.headers['x-api-key'] as string) || (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '');
    req.extKey = await this.files.auth(raw);
    return true;
  }
}

/** 对外接口：放在 /api/upload/ 下才能用上 nginx 给上传路径放开的包体限制 */
@Controller('upload/ext/files')
@UseGuards(ExtKeyGuard)
export class ExtFileOpenController {
  constructor(private readonly files: ExtFileService) {}

  @Post()
  @Throttle(60, 60)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: EXT_MAX_SIZE, files: 1, fields: 10 },
    }),
  )
  async upload(@Req() req: any, @UploadedFile() file?: Express.Multer.File, @Body() body?: { name?: string; note?: string }) {
    if (!file) throw new BadRequestException('缺少文件（form-data 字段名 file）');
    try {
      return await this.files.save(req.extKey, file, { name: body?.name, note: body?.note, ip: clientIp(req) });
    } finally {
      unlink(file.path).catch(() => undefined);
    }
  }

  @Get(':id')
  @Throttle(300, 60)
  info(@Req() req: any, @Param('id') id: string) {
    return this.files.info(req.extKey, id);
  }
}

@Controller('admin/ext-files')
@UseGuards(AdminGuard)
export class ExtFileAdminController {
  constructor(private readonly files: ExtFileService) {}

  @Get()
  list(@Query() q: { page?: number; size?: number; q?: string; keyId?: number }) {
    return this.files.list(q);
  }

  @Get('keys')
  keys() {
    return this.files.listKeys();
  }

  @Post('keys')
  createKey(@Body() body: { name?: string }) {
    return this.files.createKey(body?.name ?? '');
  }

  @Post('keys/:id/enabled')
  setKey(@Param('id', ParseIntPipe) id: number, @Body() body: { enabled?: boolean }) {
    return this.files.setKeyEnabled(id, !!body?.enabled);
  }

  @Post(':id/link')
  link(@Param('id') id: string) {
    return this.files.link(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.files.remove(id);
  }
}

/** 浏览器直接打开的下载地址，凭后台生成的 5 分钟签名放行 */
@Controller('ext-files')
export class ExtFileDownloadController {
  constructor(private readonly files: ExtFileService) {}

  @Get('download/:id')
  @Throttle(120, 60)
  async download(@Param('id') id: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    const { row, stream } = await this.files.openDownload(id, exp, sig);
    const ascii = row.name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(row.size));
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
