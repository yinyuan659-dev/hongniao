/**
 * 本机不连数据库，直接调阿里云金融级实人认证，看「发起刷脸」和「查结果」通不通。
 * 只发起、不刷脸，所以不产生费用（阿里云是刷完出了结果才收钱）；用的是假身份（校验位合法、不是真人）。
 *
 * 用法（PowerShell，密钥从环境变量读，不要写进文件）：
 *   $env:KYC_PROVIDER='aliyun'
 *   $env:KYC_ALIYUN_ACCESS_KEY_ID / KYC_ALIYUN_ACCESS_KEY_SECRET / KYC_ALIYUN_SCENE_ID  （值在 企业资料与凭据-勿提交.md）
 *   $env:SITE_BASE='http://120.55.59.158'      # 刷完跳回的网站
 *   npx ts-node -T scripts/kyc-try.ts <MetaInfo 文件> [mobile]
 * MetaInfo 文件：浏览器里跑阿里云的 getMetaInfo() 得到的 JSON，存成一个文本文件（不能手写、不能复用别的设备的）。
 * 第二个参数写 mobile 就按手机浏览器发起（H5），不写按电脑浏览器（WEB）。
 */
import { readFileSync } from 'fs';
import { createKycProvider, newBizId } from '../src/kyc/kyc-provider';

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('要给一个 MetaInfo 文件');
  const metaInfo = readFileSync(file, 'utf8').trim();
  JSON.parse(metaInfo); // 不是 JSON 直接报错
  const mobile = process.argv[3] === 'mobile';

  const provider = createKycProvider();
  console.log(`provider=${provider.name} mobile=${mobile} metaInfo长度=${metaInfo.length}`);

  const started = await provider.start({ name: '测试', idNo: '110101199501010011', bizId: newBizId(), metaInfo, mobile });
  const u = new URL(started.url);
  console.log(`发起成功 certifyId长度=${started.certifyId.length} 刷脸页=${u.protocol}//${u.host}/…（地址长度 ${started.url.length}）`);

  const res = await provider.result(started.certifyId);
  console.log(`查结果（还没刷，预期是 unfinished）: ${JSON.stringify(res)}`);
  if (process.argv.includes('--show-url')) console.log(started.url);
}

main().catch((e) => {
  const r = (e as any)?.response;
  console.error('失败:', (e as Error).message, r ? JSON.stringify(r) : '');
  process.exit(1);
});
