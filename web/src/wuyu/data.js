// 相亲物语 —— 数据。
// 【现在全部是假数据】城市、人数、名字、那句话、共同点都是编的，头像是代码画的像素头像。
// 接真实数据时只改这个文件：CITIES 换成接口返回的城市列表，people() 换成按城市取异性用户（头像地址、昵称、年龄、
// 是否真人认证、AI 那句话 ai.summary、共同点 match），点头像 / 打招呼时拿用户 id 去开画像页 / 聊天页。
// 接之前要先定的事记在 AI进度文档.md §8.2.1（每个城市放哪些人、谁排前面、对方能不能不出现、3 条招呼的细则）。
import { rng } from './pix.js';

/** 界面文字（游戏页是单独的一页，不走 App 的翻译文件；只有这十几句） */
const TEXT = {
  zh: {
    title: '相亲物语', people: '{n} 人', me: '我', hi: '打招呼',
    hint: '点路面走过去 · 按住拖动也能走 · 左上角换城市',
    demoCard: '示例人物。接入真实用户后，点头像会打开 TA 的画像',
    demoChat: '示例人物。接入真实用户后，这里可以给 TA 发消息',
    day: '白天', dusk: '黄昏', night: '夜晚', clear: '晴', rain: '雨', snow: '雪',
    sakura: '樱花道', ginkgo: '银杏道', pine: '雪松道', lantern: '灯笼街',
    noGl: '这台设备打不开游戏画面（不支持 WebGL）',
  },
  en: {
    title: 'Love Story', people: '{n} people', me: 'Me', hi: 'Say hi',
    hint: 'Tap the road to walk · drag to steer · pick a city at top left',
    demoCard: 'Sample person. With real members, tapping opens their profile',
    demoChat: 'Sample person. With real members, you can message them here',
    day: 'Day', dusk: 'Dusk', night: 'Night', clear: 'Clear', rain: 'Rain', snow: 'Snow',
    sakura: 'Sakura Road', ginkgo: 'Ginkgo Road', pine: 'Pine Road', lantern: 'Lantern Street',
    noGl: 'This device cannot show the game (WebGL is not supported)',
  },
};
export function makeT(lang) {
  const tb = TEXT[lang] || TEXT.zh;
  return (k, args) => { let s = tb[k] ?? TEXT.zh[k] ?? k; if (args) for (const a of Object.keys(args)) s = s.split(`{${a}}`).join(String(args[a])); return s; };
}

/** 城市列表（假数据）。scene 是这个城市用哪种风景，见 scenes.js 的 SCENES */
export const CITIES = [
  { id: 'chengdu', name: '成都', en: 'Chengdu', scene: 'sakura', count: 320 },
  { id: 'chongqing', name: '重庆', en: 'Chongqing', scene: 'lantern', count: 260 },
  { id: 'xian', name: '西安', en: "Xi'an", scene: 'ginkgo', count: 240 },
  { id: 'harbin', name: '哈尔滨', en: 'Harbin', scene: 'pine', count: 180 },
];

const NAMES_F = '小林 阿禾 安然 书瑶 可欣 晓雯 思琪 雨桐 梓涵 佳怡 诗涵 欣妍 雅婷 梦瑶 一诺 若曦 静怡 语嫣 婉清 子衿 念念 知夏 南乔 青禾 小满 十七 糖糖 阿宁 木子 清欢 晚晚 予安 星遥 朝颜 夏至 半夏 云舒 时雨 柚子 小鹿 橙子 阿茶 棠棠 七七 苏苏 可可 米粒 阿离 初见 听雨'.split(' ');
const NAMES_M = '周明 阿哲 子轩 浩然 一鸣 俊杰 嘉树 景行 明远 思远 云帆 承宇 子墨 知行 大川 阿杰 老陈 小北 向阳 长风 星河 青山 远山 阿凯 木木 石头 南风 北辰 沐阳 之恒 以诚 家明 志远 立夏 小满哥 阿森 路遥 河川 一航 乐天'.split(' ');
const SAYS = ['开朗爱笑，会做饭，周末爱往外跑', '慢热，喜欢在茶馆坐一下午，想找个聊得来的人', '每天晨跑五公里，做事有计划', '爱看书，话不多，但很会照顾人', '爱拍照爱旅行，去过十二个省', '爱热闹，朋友多，周末常约人逛集市', '工作认真，下班喜欢自己做顿好的', '养了一只猫，喜欢安静的小日子', '喜欢爬山和露营，想找个能一起出门的人', '性格直，有话当面说，不喜欢猜', '会弹一点吉他，周末常去看演出', '顾家，和父母关系好，想两年内结婚'];
const COMMON = [['同城', '都爱做饭'], ['同城'], ['都想两年内结婚'], ['同城', '都爱运动'], ['都爱旅行'], ['都喜欢安静'], ['同城', '都爱看书'], ['都爱小动物']];

/**
 * 这个城市里要站到路两边的人（假数据，每次打开都一样）。female：这些人是不是女的（= 看的人是男的）。
 * 返回的每一项：{ name, age, real 做过真人认证, say AI 那句话, common 共同点, seed 画像素头像用 }
 */
export function people(city, female) {
  const r = rng(31 + city.count + (female ? 0 : 7)), names = female ? NAMES_F : NAMES_M, out = [];
  for (let i = 0; i < city.count; i++) {
    out.push({ name: names[(r() * names.length) | 0], age: 23 + ((r() * 11) | 0), real: r() > 0.25, say: SAYS[(r() * SAYS.length) | 0], common: COMMON[(r() * COMMON.length) | 0], seed: 9000 + i * 7 + city.count + (female ? 0 : 3) });
  }
  return out;
}
