import { createHmac, randomUUID } from 'crypto';
import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * 实人认证供应商抽象：真实用阿里云金融级实人认证（身份证 + 活体刷脸，一次完成），
 * 测试期用 mock（不花钱、固定通过）。用环境变量 KYC_PROVIDER 切换（默认 mock），
 * 和 AI_API_KEY 的做法一致。
 */

export interface KycStartInput {
  name: string;
  idNo: string;
  /** 我们这边的业务流水号（传给供应商做幂等 / 回查） */
  bizId: string;
  /** 浏览器环境参数：网页端用阿里云的 getMetaInfo() 取到的 JSON 字符串。阿里云要用它决定给哪种刷脸页；mock 不用 */
  metaInfo?: string;
  /** 是不是手机 / 平板浏览器（阿里云的手机刷脸页和电脑刷脸页不一样） */
  mobile?: boolean;
}

export interface KycStartResult {
  /** 供应商流水号（阿里云 CertifyId）或测试期自生成的 id，用来查结果 */
  certifyId: string;
  /** 刷脸页地址：客户端打开它做活体（阿里云的页面，或 mock 的本地页） */
  url: string;
}

export interface KycResult {
  passed: boolean;
  reason?: string;
  /** 没刷完就回来了（中途退出、还在处理）：不算失败，这次认证还可以接着查或者重新发起 */
  unfinished?: boolean;
}

export interface KycProvider {
  readonly name: string;
  start(input: KycStartInput): Promise<KycStartResult>;
  result(certifyId: string): Promise<KycResult>;
}

/** 测试假核验：发起直接返回一个本地刷脸页，查结果固定「通过」。 */
class MockKycProvider implements KycProvider {
  readonly name = 'mock';

  async start(input: KycStartInput): Promise<KycStartResult> {
    const certifyId = `mock_${input.bizId}`;
    // 本地 mock 刷脸页：网页端自己的路由，点「模拟完成」后客户端再调 /kyc/finish
    const base = process.env.PUBLIC_BASE || '';
    return { certifyId, url: `${base}/#/kyc-mock?c=${encodeURIComponent(certifyId)}` };
  }

  async result(_certifyId: string): Promise<KycResult> {
    // 测试期：走到这一步就算通过（格式、未成年、一证一号在发起时已拦）。
    return { passed: true };
  }
}

/** 阿里云要求的编码：除了字母数字和 - _ . ~ 以外全部转成 %XX */
function pe(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** InitFaceVerify 返回的业务码 → 给用户看的话 */
const INIT_ERR: Record<string, string> = {
  '401': '姓名或身份证号不正确，请核对后重试',
  '414': '这台设备不支持刷脸认证，请换一台设备',
  '415': '当前浏览器版本太旧，不支持刷脸认证',
  '416': '当前系统版本太旧，不支持刷脸认证',
  '417': '这个身份信息暂时无法刷脸认证，请联系客服',
  '427': '认证太频繁或存在风险，请稍后再试',
};

/** DescribeFaceVerify 的 ResultObject.SubCode → 给用户看的没通过原因 */
const SUB_REASON: Record<string, string> = {
  '201': '姓名和身份证号对不上，请核对后重新认证',
  '202': '查不到这个身份信息，请联系客服',
  '203': '查不到证件照片，暂时无法认证，请联系客服',
  '204': '人脸和身份证本人对不上。如果是本人，请在光线好、脸没有遮挡的地方重试',
  '205': '刷脸检测没有通过，请本人在光线充足的地方重试',
  '206': '这台设备或这个身份认证太频繁或存在风险，请稍后再试',
  '209': '认证数据源暂时异常，请稍后再试',
};

/**
 * 阿里云金融级实人认证，网页（PC / 手机 H5）接入：
 *   InitFaceVerify 发起 → 拿到 CertifyId 和阿里云的刷脸页地址 → 用户刷完跳回 ReturnUrl → DescribeFaceVerify 查最终结果。
 * 方案 ID_PRO：姓名和证号由我们传，用户只刷脸。
 * 不留存人脸照片（控制台场景里没开 OSS 留存，这里也不读返回的照片字段）。
 * 日志里不写姓名、证号、MetaInfo；阿里云网关层报错的 Message 会带上请求参数，所以那种情况只记返回码。
 *
 * 环境变量：KYC_ALIYUN_ACCESS_KEY_ID / KYC_ALIYUN_ACCESS_KEY_SECRET / KYC_ALIYUN_SCENE_ID 必填；
 *   KYC_ALIYUN_MODEL 活体动作（默认 MOVE_ACTION：远近移动 + 眨眼，阿里云网页接入推荐的那种）；
 *   KYC_ALIYUN_ENDPOINT 接入地址（逗号分隔，前一个连不上换下一个）；
 *   KYC_RETURN_BASE 刷完跳回的网站地址（默认用 SITE_BASE），跳回的页面是 /kyc-return.html。
 */
class AliyunKycProvider implements KycProvider {
  readonly name = 'aliyun';
  private readonly log = new Logger('KycAliyun');
  private readonly ak = process.env.KYC_ALIYUN_ACCESS_KEY_ID || '';
  private readonly sk = process.env.KYC_ALIYUN_ACCESS_KEY_SECRET || '';
  private readonly sceneId = process.env.KYC_ALIYUN_SCENE_ID || '';
  private readonly model = process.env.KYC_ALIYUN_MODEL || 'MOVE_ACTION';
  private readonly endpoints = (process.env.KYC_ALIYUN_ENDPOINT || 'cloudauth.aliyuncs.com,cloudauth.cn-beijing.aliyuncs.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
  private readonly returnBase = (process.env.KYC_RETURN_BASE || process.env.SITE_BASE || '').replace(/\/+$/, '');

  async start(input: KycStartInput): Promise<KycStartResult> {
    const meta = (input.metaInfo ?? '').trim();
    if (!meta) throw new BadRequestException('没取到浏览器环境信息，请刷新页面后重试');
    if (!this.returnBase) throw new ServiceUnavailableException('实人认证服务还没配置好');

    const r = await this.call('InitFaceVerify', {
      SceneId: this.sceneId,
      OuterOrderNo: input.bizId,
      ProductCode: 'ID_PRO',
      Model: this.model,
      CertType: 'IDENTITY_CARD',
      CertName: input.name,
      CertNo: input.idNo,
      // 不带 # 的普通网页：阿里云往带 # 的地址后面拼结果参数的方式很怪，这里用一个静态页接住再转进网页端的路由
      ReturnUrl: `${this.returnBase}/kyc-return.html`,
      MetaInfo: meta,
      CertifyUrlType: input.mobile ? 'H5' : 'WEB',
    });
    const code = String(r?.Code ?? '');
    const obj = r?.ResultObject;
    if (code !== '200' || !obj?.CertifyId || !obj?.CertifyUrl) {
      this.warn('InitFaceVerify', r);
      throw new BadRequestException({ message: INIT_ERR[code] ?? '实人认证暂时发起不了，请稍后再试', reason: 'kyc_init_failed' });
    }
    return { certifyId: String(obj.CertifyId), url: String(obj.CertifyUrl) };
  }

  async result(certifyId: string): Promise<KycResult> {
    const r = await this.call('DescribeFaceVerify', { SceneId: this.sceneId, CertifyId: certifyId });
    const code = String(r?.Code ?? '');
    // 424：还没刷、中途放弃、还在处理；403：认证未完成。都不算失败。
    if (code === '424' || code === '403') return { passed: false, unfinished: true, reason: '刷脸还没有完成' };
    if (code !== '200' || !r?.ResultObject) {
      this.warn('DescribeFaceVerify', r);
      throw new ServiceUnavailableException('暂时查不到认证结果，请稍后再试');
    }
    // 以 Passed 为准（T 通过 / F 没通过）
    if (r.ResultObject.Passed === 'T') return { passed: true };
    return { passed: false, reason: SUB_REASON[String(r.ResultObject.SubCode ?? '')] ?? '认证未通过' };
  }

  /** 记一条不含个人信息的告警：业务码（数字）可以带上阿里云的说明，网关层报错只记返回码 */
  private warn(action: string, r: any) {
    const code = String(r?.Code ?? '');
    const msg = /^\d+$/.test(code) ? ` message=${String(r?.Message ?? '').slice(0, 60)}` : '';
    this.log.warn(`${action} code=${code}${msg} requestId=${String(r?.RequestId ?? '')}`);
  }

  /** 调阿里云 OpenAPI（RPC 风格、签名版本 1.0）。返回阿里云的 JSON；网络不通、5xx 换下一个接入地址。 */
  private async call(action: string, params: Record<string, string>): Promise<any> {
    if (!this.ak || !this.sk || !this.sceneId) throw new ServiceUnavailableException('实人认证服务还没配置好');
    let last = '';
    for (const host of this.endpoints) {
      const all: Record<string, string> = {
        ...params,
        Action: action,
        Version: '2019-03-07',
        Format: 'JSON',
        AccessKeyId: this.ak,
        SignatureMethod: 'HMAC-SHA1',
        SignatureVersion: '1.0',
        SignatureNonce: randomUUID(),
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
      const canon = Object.keys(all).sort().map((k) => `${pe(k)}=${pe(all[k])}`).join('&');
      const signature = createHmac('sha1', `${this.sk}&`).update(`POST&%2F&${pe(canon)}`).digest('base64');
      try {
        const res = await fetch(`https://${host}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `${canon}&Signature=${pe(signature)}`,
          signal: AbortSignal.timeout(10_000),
        });
        const json: any = await res.json().catch(() => null);
        if (json && typeof json === 'object' && res.status < 500) return json;
        last = `http ${res.status}`;
      } catch (e) {
        last = (e as Error)?.name || 'error';
      }
    }
    this.log.warn(`${action} 连不上阿里云: ${last}`);
    throw new ServiceUnavailableException('实人认证服务暂时连不上，请稍后再试');
  }
}

export function createKycProvider(): KycProvider {
  return (process.env.KYC_PROVIDER || 'mock') === 'aliyun' ? new AliyunKycProvider() : new MockKycProvider();
}

/** 新业务流水号（32 位字母数字） */
export function newBizId(): string {
  return randomUUID().replace(/-/g, '');
}
