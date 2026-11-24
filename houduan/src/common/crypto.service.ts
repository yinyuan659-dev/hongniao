import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * 消息加密：每个会话一把 AES-256-GCM 密钥；
 * 会话密钥再用服务端主密钥（MASTER_KEY）AES-256-GCM 包裹后落库，库内无明文。
 * 密文格式统一为 base64(iv):base64(tag):base64(cipher)
 */
@Injectable()
export class CryptoService {
  private readonly masterKey: Buffer;

  constructor(config: ConfigService) {
    const hex = config.get<string>('MASTER_KEY');
    if (!hex || hex.length !== 64) {
      throw new Error('MASTER_KEY 必须是 64 位 hex（32 字节）');
    }
    this.masterKey = Buffer.from(hex, 'hex');
  }

  generateConversationKey(): Buffer {
    return crypto.randomBytes(32);
  }

  wrapKey(key: Buffer): string {
    return this.encryptWith(this.masterKey, key.toString('base64'));
  }

  unwrapKey(wrapped: string): Buffer {
    return Buffer.from(this.decryptWith(this.masterKey, wrapped), 'base64');
  }

  /** 用主密钥直接加密一小段文字（用户自己的模型 Key、AI 深聊记录），库里不存明文 */
  seal(plaintext: string): string {
    return this.encryptWith(this.masterKey, plaintext);
  }

  open(payload: string): string {
    return this.decryptWith(this.masterKey, payload);
  }

  /**
   * 身份证号的带密钥哈希（一证一号用）。身份证号位数少、结构固定，裸 SHA-256 能被穷举，
   * 所以用 HMAC-SHA256，密钥从主密钥派生（带域分隔前缀，和消息加密互不相同）。库里只存这个哈希、不存证号明文。
   */
  idHash(idNo: string): string {
    return crypto.createHmac('sha256', this.masterKey).update(`idcard:${idNo.trim().toUpperCase()}`).digest('hex');
  }

  encrypt(convKey: Buffer, plaintext: string): string {
    return this.encryptWith(convKey, plaintext);
  }

  decrypt(convKey: Buffer, ciphertext: string): string {
    return this.decryptWith(convKey, ciphertext);
  }

  private encryptWith(key: Buffer, plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }

  private decryptWith(key: Buffer, payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }
}
