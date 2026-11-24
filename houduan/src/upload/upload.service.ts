import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { readFile, rm, writeFile } from 'fs/promises';
import * as Minio from 'minio';
import { tmpdir } from 'os';
import { join } from 'path';

/** busboy 把 multipart 里直接写的 UTF-8 文件名按 latin1 解码，中文会变乱码；能还原成合法 UTF-8 的就还原 */
function fixName(n: string) {
  if (/[^\x00-\xff]/.test(n)) return n;
  const u = Buffer.from(n, 'latin1').toString('utf8');
  return u.includes('\ufffd') ? n : u;
}

function cleanName(n: string) {
  const base = n.replace(/^.*[\\/]/, '').replace(/[\x00-\x1f\x7f"]/g, '').trim();
  return (base || 'file').slice(0, 255);
}

/** 聊天文件上限 100MB（十进制）：再大 Cloudflare 免费版直接回 413，到不了源站 */
export const FILE_MAX_SIZE = 100_000_000;
export const VIDEO_MAX_SIZE = 200 * 1024 * 1024;

/** ffmpeg 转成 AAC m4a（单声道 64k） */
async function toM4a(input: Buffer): Promise<Buffer> {
  const base = join(tmpdir(), `voice-${randomUUID()}`);
  try {
    await writeFile(`${base}.in`, input);
    await new Promise<void>((res, rej) =>
      execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${base}.in`, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-f', 'mp4', `${base}.m4a`], { timeout: 30_000 }, (err, _o, stderr) =>
        err ? rej(new Error(`ffmpeg: ${String(stderr || err.message).slice(0, 200)}`)) : res(),
      ),
    );
    const out = await readFile(`${base}.m4a`);
    if (out.length < 100) throw new Error('ffmpeg 输出为空');
    return out;
  } finally {
    await rm(`${base}.in`, { force: true });
    await rm(`${base}.m4a`, { force: true });
  }
}

const ALLOWED: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/m4a', 'audio/x-m4a', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/3gpp', 'application/octet-stream'],
};

@Injectable()
export class UploadService implements OnModuleInit {
  private readonly logger = new Logger('Upload');
  private readonly client: Minio.Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>('MINIO_BUCKET') ?? 'peiwan';
    this.client = new Minio.Client({
      endPoint: config.get<string>('MINIO_ENDPOINT') ?? '127.0.0.1',
      port: Number(config.get('MINIO_PORT') ?? 9000),
      useSSL: false,
      accessKey: config.get<string>('MINIO_ACCESS_KEY') ?? '',
      secretKey: config.get<string>('MINIO_SECRET_KEY') ?? '',
      // 分片默认 64MB 且整片放内存，150MB 视频要多占 160MB 堆；8MB 一片只多十几 MB
      partSize: 8 * 1024 * 1024,
    });
  }

  async onModuleInit() {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket);
      }
      // 公共读：媒体通过 nginx /res/ 路径访问
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${this.bucket}/*`],
          },
        ],
      };
      await this.client.setBucketPolicy(this.bucket, JSON.stringify(policy));
    } catch (e) {
      this.logger.warn(`MinIO 初始化失败（本地无 MinIO 时可忽略）: ${e}`);
    }
  }

  /** 上传文件，返回可经 nginx /res/ 访问的相对路径 */
  async upload(kind: 'image' | 'video' | 'audio', file: { buffer: Buffer; mimetype: string; size: number }) {
    const allowed = ALLOWED[kind];
    if (!allowed?.includes(file.mimetype)) throw new BadRequestException('不支持的文件类型');
    const maxSize = kind === 'image' ? 20 * 1024 * 1024 : kind === 'audio' ? 10 * 1024 * 1024 : VIDEO_MAX_SIZE;
    if (file.size > maxSize) throw new BadRequestException('文件过大');
    // 网页版录音是 webm / ogg（Opus），iOS 播不了，统一转成 m4a
    if (kind === 'audio' && /webm|ogg/.test(file.mimetype)) {
      const m4a = await toM4a(file.buffer).catch((e) => {
        this.logger.warn(`语音转码失败: ${e}`);
        return null;
      });
      if (m4a) file = { buffer: m4a, mimetype: 'audio/mp4', size: m4a.length };
    }

    const ext = kind === 'audio' && file.mimetype === 'audio/mp4' ? 'm4a' : file.mimetype.split('/')[1].replace('quicktime', 'mov').replace('x-m4a', 'm4a').replace('mpeg', kind === 'audio' ? 'mp3' : 'mpeg').replace('octet-stream', 'm4a');
    const object = `${kind}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
    await this.client.putObject(this.bucket, object, file.buffer, file.size, {
      'Content-Type': file.mimetype,
    });
    return { url: `/res/${this.bucket}/${object}` };
  }

  /** 视频：和聊天文件一样落盘后 fPutObject，不进 Node 堆（api 容器只有 512MB 内存） */
  async uploadVideoFile(file: { path: string; mimetype: string; size: number }) {
    if (!ALLOWED.video.includes(file.mimetype)) throw new BadRequestException('不支持的文件类型');
    if (file.size <= 0) throw new BadRequestException('文件是空的');
    if (file.size > VIDEO_MAX_SIZE) throw new BadRequestException('文件过大');
    const ext = file.mimetype === 'video/quicktime' ? 'mov' : 'mp4';
    const object = `video/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
    await this.client.fPutObject(this.bucket, object, file.path, { 'Content-Type': file.mimetype });
    return { url: `/res/${this.bucket}/${object}` };
  }

  /**
   * 聊天里发的任意文件：multer 先落到临时文件，再流式写进 MinIO（api 容器只有 512MB 内存）。
   * /res/ 是同源公共读，存成 octet-stream + attachment，浏览器只会下载，不会把 html / svg 当页面打开。
   */
  async uploadChatFile(file: { path: string; originalname: string; mimetype: string; size: number }) {
    if (file.size <= 0) throw new BadRequestException('文件是空的');
    if (file.size > FILE_MAX_SIZE) throw new BadRequestException('文件超过 100MB');
    const name = cleanName(fixName(file.originalname || 'file'));
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimetype ?? '') ? file.mimetype.slice(0, 120) : 'application/octet-stream';
    const ext = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? 'bin').toLowerCase();
    const object = `file/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
    const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    await this.client.fPutObject(this.bucket, object, file.path, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
    });
    return { url: `/res/${this.bucket}/${object}`, name, size: file.size, mime };
  }

  /**
   * 服务端复制一份用户上传的媒体（image/ video/ audio/ file/ 目录），返回新地址；其它地址原样返回。
   * 转发消息时用：原消息的文件被删时，转发出去的那份不能跟着失效。
   */
  async copy(url: string) {
    const prefix = `/res/${this.bucket}/`;
    const i = url.indexOf(prefix);
    if (i < 0) return url;
    const src = url.slice(i + prefix.length).split(/[?#]/)[0];
    const m = /^(image|video|audio|file)\/[\w./-]+?\.(\w{1,8})$/.exec(src);
    if (!m) return url;
    const object = `${m[1]}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${m[2]}`;
    try {
      await this.client.copyObject(this.bucket, object, `/${this.bucket}/${src}`);
    } catch (e: any) {
      this.logger.warn(`copy ${src}: ${e?.message ?? e}`);
      return url;
    }
    return `${url.slice(0, i)}${prefix}${object}`;
  }

  /** 删除站内资源（只认本 bucket 的 /res/<bucket>/ 路径，其它忽略） */
  async remove(url: string) {
    const prefix = `/res/${this.bucket}/`;
    if (!url?.startsWith(prefix)) return;
    await this.client.removeObject(this.bucket, url.slice(prefix.length).split(/[?#]/)[0]).catch((e) => this.logger.warn(`remove ${url}: ${e?.message}`));
  }

  /**
   * 后台上传 apk：校验 zip 魔数（apk 就是 zip），按时间戳命名避免 CDN/浏览器缓存旧包，
   * 返回完整下载地址（PUBLIC_RES_BASE，默认 https://api.yyheart.com）供「App 版本」页直接保存。
   */
  async uploadApk(file: { buffer: Buffer; mimetype: string; size: number; originalname?: string }) {
    const b = file.buffer;
    const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
    if (!isZip || !/\.apk$/i.test(file.originalname ?? '.apk')) throw new BadRequestException('请上传 .apk 安装包');
    if (file.size > 200 * 1024 * 1024) throw new BadRequestException('安装包超过 200MB');

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const object = `apk/peiwan-${stamp}.apk`;
    await this.client.putObject(this.bucket, object, b, file.size, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="peiwan.apk"',
    });
    const base = (process.env.PUBLIC_RES_BASE || 'https://api.yyheart.com').replace(/\/$/, '');
    return { url: `${base}/res/${this.bucket}/${object}`, size: file.size, object };
  }
}
