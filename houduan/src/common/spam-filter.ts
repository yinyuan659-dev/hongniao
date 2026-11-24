/**
 * 内置广告 / 引流识别。
 *
 * 分几层：赌博词 / 色情招嫖词（命中一个就算）→「女性类型清单」→ 城市 / 话题 / 国旗刷屏 + 招揽词 → 联系方式 + 招揽词 → emoji 刷屏。
 * 判断在原文上做（去链接行之前），并把字符间插的 • · 空格、全角字符、零宽字符都抹平，防「外•围」这类拆字。
 */

/** 赌博 / 担保盘（原 SPAM_RE，去掉了已并入下面的「约炮」） */
const GAMBLING = /担保|充提|飞投|博彩|棋牌|娱乐城|开户|USDT|\.COM\b|\.VIP\b|加微|赌|下注|返水|上分|代理招募|一手盘|菠菜/i;

/** 色情招嫖：命中一个就算（在抹平后的文字上匹配）。「白嫖」是常见口语，不算 */
const SEX_TRADE = /外围(?!赛|设备|设施|防线|墙|区域|环境)|伴游|包养|楼凤|援交|约炮|一夜情|卖淫|(?<!白)嫖|招妓|色情服务|性服务|上门服务|裸聊|莞式|兼职妹|学生妹|处女包|全套服务|特殊服务|会员制门槛|过滤口嗨|高端外围|小姐上门|妹子上门|上门按摩|escort|sugar(daddy|baby|dating)|callgirl|prostitut|incall|outcall|onlyfans/i;

/** 招嫖广告里罗列的「女性类型」：出现 4 种及以上基本就是菜单 */
const GIRL_TYPES = ['模特', '空姐', '网红', '学生', '萝莉', '教师', '护士', '少妇', '御姐', '人妻', '熟女', '嫩模', '女大', '学妹', '外籍', '混血'];
const VIRGIN = /处女(?!座|作|地|航|秀|膜)/;

/** 招揽 / 经营类词（每组算一个；在抹平后的文字上匹配，所以只放中文） */
const AD_GROUPS: RegExp[] = [
  /会员|入会|门槛/, /非诚勿扰|口嗨/, /诚心经营|诚信经营|主要经营|经营/, /高端|顶级|极品/, /商务接待|接待/, /私人订制|私人/,
  /可约|约妹|随时约|全国约|同城约/, /兼职/, /空降|上门/, /资源/, /国内版|海外版/, /全国/,
  /唯一|客服|咨询/, /频道|纸飞机|电报/, /同城/, /价格|价位|报价|预约|包夜|快餐/, /颜值|身材/, /二次元/,
];
/** 招揽类的符号 / 英文缩写：在没抹平的文字上匹配（抹平后 sm 会粘进普通英文单词里） */
const AD_MARKS: RegExp[] = [/🉑/u, /✈/u, /(?<![a-z])(sm|cos|vip)(?![a-z])/];

/** 联系方式 / 引流：@用户名（前面不是字母数字点，排除邮箱）、t.me、微信号、QQ 号、手机号、✈ 符号 */
const CONTACT = /(^|[^A-Za-z0-9_.])@[A-Za-z][A-Za-z0-9_]{3,}|t\.me\/|telegram\.me|(微信|威信|薇信|v信|vx|wx|扣扣|qq)\s*[:：号]?\s*[A-Za-z0-9_-]{5,}|(?<!\d)1[3-9]\d{9}(?!\d)|✈|飞机号|纸飞机/i;

const CITIES = [
  '北京', '上海', '广州', '深圳', '杭州', '苏州', '厦门', '泉州', '成都', '重庆', '武汉', '长沙', '太原', '南昌', '南京', '台州', '海口', '三亚',
  '天津', '西安', '郑州', '青岛', '大连', '沈阳', '哈尔滨', '长春', '济南', '合肥', '福州', '昆明', '贵阳', '南宁', '石家庄', '宁波', '温州', '无锡',
  '东莞', '佛山', '珠海', '香港', '澳门', '台北', '多伦多', '温哥华', '新加坡', '吉隆坡', '悉尼', '墨尔本', '首尔', '东京', '大阪', '迪拜', '伦敦',
  '巴黎', '纽约', '洛杉矶', '旧金山', '曼谷', '金边', '胡志明', '马尼拉',
];

/** 统一成可比较的形态：全角转半角、小写、去零宽字符 */
function normalize(text: string): string {
  return (text ?? '').normalize('NFKC').toLowerCase().replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
}

/** 再抹掉空白、分隔符、emoji，防「外•围」「伴 游」「外🔥围」拆字 */
function compact(norm: string): string {
  return norm.replace(/[\s•·・.,，。、|_\-~*'"“”‘’!！?？:：;；()（）【】\[\]#]+/g, '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu, '');
}

/**
 * 判断一段文字是不是广告 / 引流 / 色情招嫖，是的话返回原因（给日志和后台看），否则 null。
 * 传进来的应是原文（去联系方式行之前），否则联系方式这一层看不到。
 */
export function spamReason(text: string): string | null {
  const norm = normalize(text);
  if (!norm.trim()) return null;
  const flat = compact(norm);

  const g = norm.match(GAMBLING) ?? flat.match(GAMBLING);
  if (g) return `赌博 / 担保词「${g[0]}」`;
  const s = flat.match(SEX_TRADE);
  if (s) return `色情招嫖词「${s[0]}」`;

  const girls = GIRL_TYPES.filter((w) => flat.includes(w)).length + (VIRGIN.test(flat) ? 1 : 0);
  const adHits = AD_GROUPS.filter((re) => re.test(flat)).length + AD_MARKS.filter((re) => re.test(norm)).length;
  const contact = CONTACT.test(norm);
  const cities = CITIES.filter((c) => flat.includes(c)).length;
  const hashtags = (norm.match(/#[^\s#]{1,20}/g) ?? []).length;
  const flags = (norm.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) ?? []).length;
  const listing = cities >= 5 || hashtags >= 8 || flags >= 3;

  // 「我妈是护士、我爸是教师…」这种家常话也能凑出几种，所以 4~5 种要再带一点招揽 / 联系方式 / 刷屏
  if (girls >= 6 || (girls >= 4 && (adHits >= 1 || contact || listing))) return `罗列 ${girls} 种女性类型`;

  if (listing && (adHits >= 2 || contact || girls >= 2)) return `城市 / 话题刷屏（城市 ${cities}、话题 ${hashtags}、国旗 ${flags}）+ 招揽`;
  if (contact && (adHits >= 3 || girls >= 2)) return `联系方式 + 招揽词 ${adHits} 组`;
  if (adHits >= 6) return `招揽词 ${adHits} 组`;

  const emojis = (norm.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (emojis >= 8 && emojis * 4 > norm.replace(/\s/g, '').length) return `emoji 刷屏（${emojis} 个）`;
  return null;
}

export function looksLikeSpam(text: string): boolean {
  return spamReason(text) !== null;
}

/** 去掉含 @用户名 / t.me / 网址的整行（频道签名、投稿引流），并压缩多余空行。
 *  @ 前面是全角冒号 / emoji 也算（10.15 那条「唯一✈：@xxx」以前没去掉）；邮箱（字母数字后面的 @）不算 */
export function stripLinkLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/(^|[^A-Za-z0-9_.])@[A-Za-z0-9_]{4,}/.test(line) && !/t\.me\//i.test(line) && !/https?:\/\//i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
