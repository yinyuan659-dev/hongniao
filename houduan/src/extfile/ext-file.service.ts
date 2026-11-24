import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { createReadStream } from 'fs';
import * as Minio from 'minio';
import { PrismaService } from '../prisma/prisma.service';

/** 单个文件上限 100MB（十进制）：再大 Cloudflare 免费版直接回 413，到不了源站 */
export const EXT_MAX_SIZE = 100_000_000;
const KEY_PREFIX = 'hxf_';
const LINK_TTL_S = 300;

export type ExtKey = { id: number; name: string };

/** busboy 把 multipart 里直接写的 UTF-8 文件名按 latin1 解码，中文会变乱码；能还原成合法 UTF-8 的就还原 */
export function fixName(n: string) {
  if (/[^\x00-\xff]/.test(n)) return n;
  const u = Buffer.from(n, 'latin1').toString('utf8');
  return u.includes('\ufffd') ? n : u;
}

export function cleanName(n: string) {
  const base = n.replace(/^.*[\\/]/, '').replace(/[\x00-\x1f\x7f"]/g, '').trim();
  return (base || 'file').slice(0, 255);
}

function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');

@Injectable()
export class ExtFileService implements OnModuleInit {
  private readonly logger = new Logger('ExtFile');
  private readonly client: Minio.Client;
  private readonly bucket: string;
  private readonly linkSecret: Buffer;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.bucket = config.get<string>('EXT_FILE_BUCKET') ?? 'peiwan-ext';
    this.client = new Minio.Client({
      endPoint: config.get<string>('MINIO_ENDPOINT') ?? '127.0.0.1',
      port: Number(config.get('MINIO_PORT') ?? 9000),
      useSSL: false,
      accessKey: config.get<string>('MINIO_ACCESS_KEY') ?? '',
      secretKey: config.get<string>('MINIO_SECRET_KEY') ?? '',
      // 分片默认 64MB 且整片放内存；8MB 一片，100MB 文件只多十几 MB 堆
      partSize: 8 * 1024 * 1024,
    });
    this.linkSecret = createHash('sha256').update(`ext-file-link:${config.get<string>('JWT_SECRET') ?? ''}`).digest();
  }

  /** 私有桶：不设公共读策略，/res/ 访问会被 MinIO 拒绝 */
  async onModuleInit() {
    try {
      if (!(await this.client.bucketExists(this.bucket))) await this.client.makeBucket(this.bucket);
    } catch (e) {
      this.logger.warn(`MinIO 初始化失败（本地无 MinIO 时可忽略）: ${e}`);
    }
  }

  // ---------- 接入密钥 ----------

  async auth(raw: string | undefined): Promise<ExtKey> {
    const k = (raw ?? '').trim();
    if (!k.startsWith(KEY_PREFIX)) throw new UnauthorizedException('缺少或无效的接入密钥');
    const row = await this.prisma.extApiKey.findUnique({ where: { keyHash: hashKey(k) } });
    if (!row || !row.enabled) throw new UnauthorizedException('缺少或无效的接入密钥');
    this.prisma.extApiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return { id: row.id, name: row.name };
  }

  async createKey(name: string) {
    const n = (name ?? '').trim().slice(0, 60);
    if (!n) throw new BadRequestException('请填写密钥名称（给谁用的）');
    const key = KEY_PREFIX + randomBytes(24).toString('base64url');
    const row = await this.prisma.extApiKey.create({ data: { name: n, prefix: key.slice(0, 10), keyHash: hashKey(key) } });
    return { id: row.id, name: row.name, key };
  }

  async listKeys() {
    const rows = await this.prisma.extApiKey.findMany({ orderBy: { id: 'desc' }, include: { _count: { select: { files: true } } } });
    return rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, enabled: r.enabled, lastUsedAt: r.lastUsedAt, createdAt: r.createdAt, files: r._count.files }));
  }

  async setKeyEnabled(id: number, enabled: boolean) {
    await this.prisma.extApiKey.update({ where: { id }, data: { enabled: !!enabled } }).catch(() => {
      throw new NotFoundException('密钥不存在');
    });
    return { ok: true };
  }

  // ---------- 文件 ----------

  async save(key: ExtKey, file: { path: string; originalname: string; mimetype: string; size: number }, opts: { name?: string; note?: string; ip?: string }) {
    if (file.size <= 0) throw new BadRequestException('文件是空的');
    if (file.size > EXT_MAX_SIZE) throw new BadRequestException('文件超过 100MB');
    const name = cleanName(opts.name?.trim() ? opts.name : fixName(file.originalname || 'file'));
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimetype ?? '') ? file.mimetype.slice(0, 120) : 'application/octet-stream';
    const sha256 = await sha256File(file.path);
    const object = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}`;
    await this.client.fPutObject(this.bucket, object, file.path, { 'Content-Type': 'application/octet-stream' });
    const row = await this.prisma.extFile.create({
      data: { keyId: key.id, name, size: BigInt(file.size), mime, sha256, note: (opts.note ?? '').trim().slice(0, 500), object, ip: (opts.ip ?? '').slice(0, 64) },
    });
    return this.view(row);
  }

  /** 调用方只能查自己这把密钥传的文件 */
  async info(key: ExtKey, id: string) {
    const row = await this.find(id);
    if (row.keyId !== key.id) throw new NotFoundException('文件不存在');
    return this.view(row);
  }

  async list(q: { page?: number; size?: number; q?: string; keyId?: number }) {
    const page = Math.max(1, Number(q.page) || 1);
    const size = Math.min(100, Math.max(1, Number(q.size) || 20));
    const kw = (q.q ?? '').trim();
    const where = {
      ...(kw ? { OR: [{ name: { contains: kw } }, { note: { contains: kw } }, { sha256: kw.toLowerCase() }] } : {}),
      ...(q.keyId ? { keyId: Number(q.keyId) } : {}),
    };
    const [rows, total, agg] = await Promise.all([
      this.prisma.extFile.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * size, take: size, include: { key: { select: { name: true } } } }),
      this.prisma.extFile.count({ where }),
      this.prisma.extFile.aggregate({ _sum: { size: true }, _count: true }),
    ]);
    return {
      list: rows.map((r) => ({ ...this.view(r), keyId: r.keyId, keyName: r.key.name, ip: r.ip, downloads: r.downloads })),
      total,
      stats: { files: agg._count, bytes: String(agg._sum.size ?? 0) },
    };
  }

  async remove(id: string) {
    const row = await this.find(id);
    await this.client.removeObject(this.bucket, row.object).catch((e) => this.logger.warn(`remove ${row.object}: ${e?.message ?? e}`));
    await this.prisma.extFile.delete({ where: { id: row.id } });
    return { ok: true };
  }

  // ---------- 下载：后台先要一个 5 分钟有效的签名链接，浏览器直接打开 ----------

  async link(id: string) {
    const row = await this.find(id);
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S;
    return { url: `/api/ext-files/download/${row.id}?exp=${exp}&sig=${this.sign(String(row.id), exp)}`, expiresIn: LINK_TTL_S };
  }

  async openDownload(id: string, exp: string, sig: string) {
    const e = Number(exp);
    if (!Number.isFinite(e) || e < Date.now() / 1000) throw new UnauthorizedException('下载链接已过期，请回后台重新点下载');
    const want = Buffer.from(this.sign(id, e));
    const got = Buffer.from(String(sig ?? ''));
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new UnauthorizedException('下载链接无效');
    const row = await this.find(id);
    const stream = await this.client.getObject(this.bucket, row.object);
    this.prisma.extFile.update({ where: { id: row.id }, data: { downloads: { increment: 1 } } }).catch(() => undefined);
    return { row, stream };
  }

  private sign(id: string, exp: number) {
    return createHmac('sha256', this.linkSecret).update(`${id}.${exp}`).digest('base64url');
  }

  private async find(id: string) {
    if (!/^\d{1,18}$/.test(String(id))) throw new NotFoundException('文件不存在');
    const row = await this.prisma.extFile.findUnique({ where: { id: BigInt(id) } });
    if (!row) throw new NotFoundException('文件不存在');
    return row;
  }

  private view(r: { id: bigint; name: string; size: bigint; mime: string; sha256: string; note: string; createdAt: Date }) {
    return { id: String(r.id), name: r.name, size: Number(r.size), mime: r.mime, sha256: r.sha256, note: r.note, createdAt: r.createdAt };
  }
}
