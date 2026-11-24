/**
 * AI 红娘资料收集的标准问题模板：男 / 女各一套。
 *
 * 这里是「模板聊天」：问题和选项是写死的，不调大模型，所以不花 token、没配 AI Key 也能用。
 * 改问题、改选项、调整必答 / 可跳过，只改这个文件，三端页面不用动（页面按接口返回的题目渲染）。
 * 改动会影响已有用户的画像时，把 TEMPLATE_VERSION 加 1。
 */

/** 2：加了彩礼、彩礼怎么给、要孩子的前提三题；收入改成对方能看到 */
export const TEMPLATE_VERSION = 2;

/**
 * 题型同时决定了页面上用什么方式回答（每道题都尽量点一下就能答完，少打字）：
 *   number → 滚轮，默认停在 def，拨一下点「确定」
 *   single → 一排选项，点一下就提交；带 custom 的下面多一个输入框，选项里没有可以自己填
 *   multi  → 多选选项 + 「选好了」
 *   city   → 当前城市和热门城市直接点，没有再点「其他城市」打开完整列表
 *   text   → 多行输入框，带字数；有 samples 的会列出示例句，点一句填进去再改
 */
export type QuestionType = 'single' | 'multi' | 'text' | 'number' | 'city';

export interface Question {
  /** 存库用的 key，定了以后不要改 */
  key: string;
  /** 画像里显示的名字 */
  label: string;
  /** AI 红娘问的话 */
  ask: string;
  type: QuestionType;
  /** single / multi 的选项 */
  options?: string[];
  /** multi 最多选几个；text 最多几个字；number 的最大值 */
  max?: number;
  /** number 的最小值 */
  min?: number;
  /** number：滚轮一开始停在哪个值 */
  def?: number;
  /** single：选项里没有合适的，可以自己填（最多 max 个字） */
  custom?: boolean;
  /** text：示例句，点一下填进输入框 */
  samples?: string[];
  /** 输入框里的提示 */
  hint?: string;
  /** 显示时跟在后面的单位 */
  unit?: string;
  /** 可以点「先不说」跳过 */
  optional?: boolean;
  /** 只用来匹配，不显示在别人看到的资料卡里 */
  hidden?: boolean;
  /** 属于「想找什么样的人」 */
  pref?: boolean;
}

/** 开场白（每句一个气泡）。第一句必须说明自己是 AI（开发文档 §1 第 7 条） */
export const INTRO = [
  '你好，我是 AI 红娘，是人工智能，不是真人。',
  '我先了解一下你的基本情况和想找什么样的人，大概 3 分钟。带「先不说」的可以跳过，答完以后随时能改。你填的内容，对方在你的画像里都能看到，请如实填。',
  '资料收集完成后，你才能主动找人聊天。我们开始吧。',
];

export const OUTRO = '都问完了。下面是我整理的相亲画像，你看看对不对。哪一项不对点一下就能改，没问题就点「确认」。';
export const CONFIRMED = '你的资料已经收集完成，可以去找人聊天了。想改哪一项，点一下那一行就行。';

const thisYear = () => new Date().getFullYear();

/** 「关于你」的公共问题；income / house / car 男生必答、女生可跳过 */
function aboutYou(male: boolean): Question[] {
  return [
    {
      key: 'birthYear', label: '出生年份', type: 'number', unit: '年',
      ask: '你是哪一年出生的？',
      hint: '例如 1995', min: thisYear() - 70, max: thisYear() - 18, def: thisYear() - (male ? 28 : 26),
    },
    {
      key: 'height', label: '身高', type: 'number', unit: 'cm',
      ask: '身高多少厘米？',
      hint: male ? '例如 175' : '例如 162', min: 140, max: 210, def: male ? 175 : 162,
    },
    { key: 'city', label: '现居城市', type: 'city', ask: '现在在哪个城市生活？' },
    { key: 'hometown', label: '老家', type: 'city', optional: true, ask: '老家是哪个城市的？' },
    {
      key: 'education', label: '学历', type: 'single',
      ask: '你的学历是？',
      options: ['高中及以下', '大专', '本科', '硕士', '博士'],
    },
    {
      key: 'job', label: '职业', type: 'single', custom: true, max: 20,
      ask: '做什么工作？选一个最接近的，没有就自己填。', hint: '没有合适的？自己填，例如 律师',
      options: [
        '公务员', '事业单位', '国企员工', '教师', '医生', '护士', '程序员', '工程师', '销售',
        '金融 / 财务', '设计', '行政 / 人事', '个体经营', '自由职业', '工人 / 技工', '服务业', '学生',
      ],
    },
    {
      // 用户 2026-11-23 定：别人看到的画像和自己看到的一样，所以收入也给对方看（原来是只用来匹配、不显示）
      key: 'income', label: '月收入', type: 'single', optional: !male,
      ask: '每个月收入大概在哪个范围？对方在你的画像里能看到。',
      options: ['5 千以下', '5 千～1 万', '1 万～2 万', '2 万～3 万', '3 万～5 万', '5 万以上'],
    },
    {
      key: 'marital', label: '婚史', type: 'single',
      ask: '你的婚姻状况是？',
      options: ['未婚', '离异未育', '离异有孩子', '丧偶'],
    },
    {
      key: 'house', label: '住房', type: 'single', optional: !male,
      ask: '现在的住房情况是？',
      options: ['已买房，没有贷款', '已买房，有贷款', '和父母同住', '租房', '其他'],
    },
    {
      key: 'car', label: '车', type: 'single', optional: !male,
      ask: '有车吗？',
      options: ['有车', '没有车'],
    },
    {
      key: 'wantKids', label: '要孩子的想法', type: 'single',
      ask: '关于要孩子，你是怎么想的？',
      options: ['想要', '不想要', '看情况', '已经有孩子，还想要', '已经有孩子，不再要'],
    },
    {
      key: 'marryPlan', label: '结婚打算', type: 'single',
      ask: '遇到合适的人，你希望多久内结婚？',
      options: ['一年内', '一到两年', '两到三年', '顺其自然'],
    },
    {
      key: 'smoke', label: '抽烟', type: 'single',
      ask: '你抽烟吗？',
      options: ['不抽烟', '偶尔抽', '经常抽'],
    },
    {
      key: 'drink', label: '喝酒', type: 'single',
      ask: '喝酒吗？',
      options: ['不喝酒', '偶尔喝', '经常喝'],
    },
    {
      key: 'hobbies', label: '兴趣爱好', type: 'multi', max: 5,
      ask: '平时喜欢做什么？最多选 5 个。',
      options: ['运动健身', '户外爬山', '旅行', '做饭', '美食探店', '电影追剧', '看书', '音乐', '游戏', '摄影', '养宠物', '宅在家'],
    },
    {
      key: 'intro', label: '自我介绍', type: 'text', max: 100, optional: true,
      ask: '用一两句话介绍一下自己吧，这段话对方能看到。', hint: '写一两句话，或者点上面的示例再改',
      samples: [
        '性格慢热，熟了以后话挺多。周末喜欢爬山、做饭。',
        '工作稳定，生活规律，想找个能好好过日子的人。',
        '比较顾家，喜欢安静，也愿意陪另一半出去走走。',
        '开朗爱笑，喜欢旅行和美食，希望遇到聊得来的人。',
      ],
    },
  ];
}

/** 「想找什么样的人」；女生多两题（对方收入、住房） */
function lookingFor(male: boolean): Question[] {
  const list: Question[] = [
    {
      key: 'prefAge', label: '年龄', type: 'single', pref: true,
      ask: '接下来说说你想找什么样的人。年龄上能接受相差多少？',
      options: ['相差 3 岁以内', '相差 5 岁以内', '相差 10 岁以内', '不限'],
    },
    {
      key: 'prefHeight', label: '身高', type: 'single', pref: true,
      ask: '对对方的身高有要求吗？',
      options: male
        ? ['不限', '155 以上', '160 以上', '165 以上', '170 以上']
        : ['不限', '165 以上', '170 以上', '175 以上', '180 以上'],
    },
    {
      key: 'prefEducation', label: '学历', type: 'single', pref: true,
      ask: '对对方的学历有要求吗？',
      options: ['不限', '大专及以上', '本科及以上', '硕士及以上'],
    },
    {
      key: 'prefMarital', label: '婚史', type: 'single', pref: true,
      ask: '能接受对方有过婚史吗？',
      options: ['只接受未婚', '可以接受离异未育', '可以接受离异有孩子', '都可以'],
    },
    {
      key: 'prefDistance', label: '城市', type: 'single', pref: true,
      ask: '能接受异地吗？',
      options: ['只找同城', '同省也可以', '可以接受异地'],
    },
  ];
  if (!male) {
    list.push(
      {
        key: 'prefIncome', label: '月收入', type: 'single', pref: true, optional: true,
        ask: '对对方的月收入有要求吗？',
        options: ['不限', '5 千以上', '1 万以上', '2 万以上', '3 万以上'],
      },
      {
        key: 'prefHouse', label: '住房', type: 'single', pref: true, optional: true,
        ask: '对对方的住房有要求吗？',
        options: ['不限', '有房，有贷款也行', '有房，没有贷款'],
      },
    );
  }
  // 彩礼和要孩子的前提（用户 2026-11-23 要求加）：两边都把话说在前面、写在画像里给对方看，
  // 为的是防两种事：收了彩礼就跑（所以男方可以选按月给），和没名没分就让女方生孩子（所以问清要孩子的前提）。
  // 都是必答，不能「先不说」。平台不经手彩礼，只负责让双方的想法摆在明面上。
  list.push(
    male
      ? {
        key: 'brideGive', label: '彩礼', type: 'single', pref: true,
        ask: '说说彩礼。你能接受给多少？如实选，对方能看到。',
        options: ['不打算给彩礼', '按当地习俗，可以商量', '5 万以内', '5～10 万', '10～20 万', '20～30 万', '30 万以上'],
      }
      : {
        key: 'brideWant', label: '彩礼', type: 'single', pref: true,
        ask: '说说彩礼。你的想法是？如实选，对方能看到。',
        options: ['不要彩礼', '按当地习俗，可以商量', '5 万以内', '5～10 万', '10～20 万', '20～30 万', '30 万以上'],
      },
    male
      ? {
        key: 'bridePay', label: '彩礼怎么给', type: 'single', pref: true,
        ask: '彩礼你打算怎么给？一次性给，还是按月给？',
        options: ['一次性给', '按月给', '都可以，和对方商量', '不给彩礼，不涉及'],
      }
      : {
        key: 'bridePay', label: '彩礼怎么给', type: 'single', pref: true,
        ask: '彩礼希望对方怎么给？能接受按月给吗？',
        options: ['要一次性给', '可以按月给', '都可以，和对方商量', '不要彩礼，不涉及'],
      },
    {
      key: 'kidsBefore', label: '要孩子的前提', type: 'single', pref: true,
      ask: male ? '要孩子之前，你能做到哪一步？' : '要孩子之前，你要求先做到哪一步？',
      options: ['先领证结婚，再要孩子', '领证、彩礼都到位，再要孩子', '没有特别要求', '不打算要孩子，不涉及'],
    },
  );
  list.push({
    key: 'dealbreakers', label: '不能接受', type: 'multi', max: 3, pref: true, optional: true,
    ask: '最后一个问题：对方身上你最不能接受的是什么？最多选 3 个。',
    options: ['抽烟', '酗酒', '赌博', '不想要孩子', '脾气暴躁', '不上进', '不顾家', '乱花钱'],
  });
  return list;
}

/** gender：1 = 男，其它按女 */
export function templateFor(gender: number): Question[] {
  const male = gender === 1;
  return [...aboutYou(male), ...lookingFor(male)];
}
