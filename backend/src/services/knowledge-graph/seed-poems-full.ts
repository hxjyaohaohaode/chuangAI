/**
 * 知识图谱全量种子数据 —— 小学古诗词收录集（教材候选 + 拓展篇目）
 *
 * 核实日期：2026-06-27
 * 运行时收录量与教材口径必须分开：本文件当前生成 148 首；逐首溯源前不得整体宣称为统编版必背篇目。
 *
 * 信源清单（8 个权威信源，详见 poem-catalog-research.md）：
 *  L1-1 人民教育出版社官网教材答复（最高权威）
 *  L1-2 国家中小学智慧教育平台（教育部直属）
 *  L2-1 中国新闻网统编教材报道（中央媒体）
 *  L2-2 北京日报教育版（地方党报）
 *  L2-3 湛江日报教辅勘误（地方媒体）
 *  L3-1 《苏轼诗集》点校本（中华书局，学术点校本）
 *  L3-2 《杜牧集系年校注》点校本（学术点校本）
 *  L3-3 教育部统编教材编写组公开答复（编写方）
 *
 * 本文件聚合 seed-data.ts + batch-2~5 + batch-supplement 全部数据，
 * 按 title 去重后修正《古朗月行（节选）》为 8 句版，并补齐 14 首缺失必背篇目。
 * 不修改 seed-data.ts 与各 batch 文件，保持既有代码稳定性。
 */

import type { SeedPoem, SeedPoet, SeedMentorship, SeedEra } from './seed-data.js'
import { SEED_POETS, SEED_MENTORSHIPS } from './seed-data.js'
import { SEED_POEMS } from './seed-data.js'
import { SEED_POEMS_BATCH_2 } from './seed-poems/batch-2.js'
import { SEED_POEMS_BATCH_3 } from './seed-poems/batch-3.js'
import { SEED_POEMS_BATCH_4 } from './seed-poems/batch-4.js'
import { SEED_POEMS_BATCH_5 } from './seed-poems/batch-5.js'
import { SEED_POEMS_SUPPLEMENT } from './seed-poems/batch-supplement.js'

// ─────────────────────────────────────────────────────────────
// 朝代种子数据（全量，覆盖所有诗作涉及的朝代）
// ─────────────────────────────────────────────────────────────

export const SEED_ERAS_FULL: readonly SeedEra[] = [
    { name: '汉', startYear: -206, endYear: 220 },
    { name: '三国', startYear: 220, endYear: 280 },
    { name: '东晋', startYear: 317, endYear: 420 },
    { name: '南北朝', startYear: 420, endYear: 589 },
    { name: '唐', startYear: 618, endYear: 907 },
    { name: '宋', startYear: 960, endYear: 1279 },
    { name: '元', startYear: 1271, endYear: 1368 },
    { name: '明', startYear: 1368, endYear: 1644 },
    { name: '清', startYear: 1644, endYear: 1912 },
    { name: '现代', startYear: 1912, endYear: 1949 },
] as const

// ─────────────────────────────────────────────────────────────
// 诗人种子数据（全量，14 现有 + 49 新增 = 63 位）
// ─────────────────────────────────────────────────────────────

export const SEED_POETS_FULL: readonly SeedPoet[] = [
    // ===== 现有 14 位诗人（复用 seed-data.ts）=====
    ...SEED_POETS,

    // ===== 新增 49 位诗人 =====
    // 汉代
    {
        id: 'poet-hanyuefu',
        name: '汉乐府',
        dynasty: '汉',
        style: '民歌质朴，叙事性强',
        brief: '汉代官方音乐机构采集的民间诗歌，作者多不可考',
    },
    {
        id: 'poet-caocao',
        name: '曹操',
        dynasty: '汉',
        birthYear: 155,
        deathYear: 220,
        style: '气魄雄伟，慷慨悲凉',
        brief: '政治家、军事家、文学家，建安文学代表',
    },
    // 三国
    {
        id: 'poet-caozhi',
        name: '曹植',
        dynasty: '三国',
        birthYear: 192,
        deathYear: 232,
        style: '骨气奇高，辞采华茂',
        brief: '曹操第三子，"建安之杰"，七步成诗',
    },
    // 东晋
    {
        id: 'poet-taoyuanming',
        name: '陶渊明',
        dynasty: '东晋',
        birthYear: 365,
        deathYear: 427,
        style: '田园诗派鼻祖，自然质朴',
        brief: '隐逸诗人之宗，"采菊东篱下，悠然见南山"',
    },
    // 南北朝
    {
        id: 'poet-beichaominge',
        name: '北朝民歌',
        dynasty: '南北朝',
        style: '粗犷豪放，草原气息',
        brief: '北方各民族民间歌谣，多反映游牧生活',
    },
    // 唐代（新增）
    {
        id: 'poet-liqiao',
        name: '李峤',
        dynasty: '唐',
        birthYear: 644,
        deathYear: 713,
        style: '文章四友之一，咏物诗工整',
        brief: '初唐文人，"文章四友"之一',
    },
    {
        id: 'poet-yushinan',
        name: '虞世南',
        dynasty: '唐',
        birthYear: 558,
        deathYear: 638,
        style: '凌烟阁二十四功臣，诗文典雅',
        brief: '初唐书法家、文学家，凌烟阁功臣',
    },
    {
        id: 'poet-hezhizhang',
        name: '贺知章',
        dynasty: '唐',
        birthYear: 659,
        deathYear: 744,
        style: '清新潇洒，纵放不羁',
        brief: '"吴中四士"之一，自号"四明狂客"',
    },
    {
        id: 'poet-wangchangling',
        name: '王昌龄',
        dynasty: '唐',
        birthYear: 690,
        deathYear: 756,
        style: '边塞诗派，雄浑高昂',
        brief: '"七绝圣手"，盛唐边塞诗代表',
    },
    {
        id: 'poet-wanghan',
        name: '王翰',
        dynasty: '唐',
        birthYear: 687,
        deathYear: 726,
        style: '边塞诗，豪放旷达',
        brief: '盛唐边塞诗人，《凉州词》传世',
    },
    {
        id: 'poet-cuihao',
        name: '崔颢',
        dynasty: '唐',
        birthYear: 704,
        deathYear: 754,
        style: '雄浑奔放，意境开阔',
        brief: '盛唐诗人，《黄鹤楼》被誉为唐律第一',
    },
    {
        id: 'poet-gaoshi',
        name: '高适',
        dynasty: '唐',
        birthYear: 704,
        deathYear: 765,
        style: '边塞诗派，慷慨悲壮',
        brief: '"高岑"并称，盛唐边塞诗代表',
    },
    {
        id: 'poet-weyingwu',
        name: '韦应物',
        dynasty: '唐',
        birthYear: 737,
        deathYear: 792,
        style: '山水田园，闲淡简远',
        brief: '中唐诗人，与王维孟浩然柳宗元并称"王孟韦柳"',
    },
    {
        id: 'poet-zhangzhihe',
        name: '张志和',
        dynasty: '唐',
        birthYear: 730,
        deathYear: 810,
        style: '渔隐词风，清新自然',
        brief: '唐代词人，自号"烟波钓徒"',
    },
    {
        id: 'poet-hanYu',
        name: '韩愈',
        dynasty: '唐',
        birthYear: 768,
        deathYear: 824,
        style: '奇崛雄伟，以文为诗',
        brief: '"唐宋八大家"之首，古文运动倡导者',
    },
    {
        id: 'poet-mengjiao',
        name: '孟郊',
        dynasty: '唐',
        birthYear: 751,
        deathYear: 814,
        style: '苦吟诗风，寒瘦险僻',
        brief: '"郊寒岛瘦"，与贾岛并称',
    },
    {
        id: 'poet-liuzhangqing',
        name: '刘长卿',
        dynasty: '唐',
        birthYear: 709,
        deathYear: 786,
        style: '工于五言，清淡含蓄',
        brief: '中唐诗人，自诩"五言长城"',
    },
    {
        id: 'poet-lulun',
        name: '卢纶',
        dynasty: '唐',
        birthYear: 739,
        deathYear: 799,
        style: '边塞诗，雄健有力',
        brief: '"大历十才子"之一',
    },
    {
        id: 'poet-lishangyin',
        name: '李商隐',
        dynasty: '唐',
        birthYear: 813,
        deathYear: 858,
        style: '绮丽朦胧，深情绵邈',
        brief: '晚唐诗人，与杜牧并称"小李杜"',
    },
    {
        id: 'poet-linjie',
        name: '林杰',
        dynasty: '唐',
        birthYear: 831,
        deathYear: 850,
        style: '清新自然，童趣盎然',
        brief: '唐代童子诗人，十九岁早逝',
    },
    {
        id: 'poet-jiaDao',
        name: '贾岛',
        dynasty: '唐',
        birthYear: 779,
        deathYear: 843,
        style: '苦吟推敲，清奇僻涩',
        brief: '"郊寒岛瘦"，以"推敲"典故闻名',
    },
    {
        id: 'poet-dumu',
        name: '杜牧',
        dynasty: '唐',
        birthYear: 803,
        deathYear: 852,
        style: '清丽俊逸，咏史绝句独绝',
        brief: '晚唐诗人，与李商隐并称"小李杜"',
    },
    {
        id: 'poet-liuyuxi',
        name: '刘禹锡',
        dynasty: '唐',
        birthYear: 772,
        deathYear: 842,
        style: '刚健豪迈，哲理深邃',
        brief: '"诗豪"，中唐政治家、文学家',
    },
    {
        id: 'poet-hulinneng',
        name: '胡令能',
        dynasty: '唐',
        birthYear: 785,
        deathYear: 826,
        style: '贴近生活，质朴清新',
        brief: '唐代诗人，以修补锅碗为业，人称"胡钉铰"',
    },
    {
        id: 'poet-luoyin',
        name: '罗隐',
        dynasty: '唐',
        birthYear: 833,
        deathYear: 910,
        style: '讽刺辛辣，语言通俗',
        brief: '晚唐诗人，"今朝有酒今朝醉"传世',
    },
    {
        id: 'poet-wangbo',
        name: '王勃',
        dynasty: '唐',
        birthYear: 650,
        deathYear: 676,
        style: '初唐四杰，雄秀挺拔',
        brief: '"初唐四杰"之首，《滕王阁序》千古名篇',
    },
    // 宋代（新增）
    {
        id: 'poet-zhuxi',
        name: '朱熹',
        dynasty: '宋',
        birthYear: 1130,
        deathYear: 1200,
        style: '理学诗风，寓理于景',
        brief: '南宋理学家，集理学之大成',
    },
    {
        id: 'poet-fanzhongyan',
        name: '范仲淹',
        dynasty: '宋',
        birthYear: 989,
        deathYear: 1052,
        style: '苍凉悲壮，忧国忧民',
        brief: '北宋政治家、文学家，"先天下之忧而忧"',
    },
    {
        id: 'poet-fanchengda',
        name: '范成大',
        dynasty: '宋',
        birthYear: 1126,
        deathYear: 1193,
        style: '田园诗，清新婉丽',
        brief: '南宋"中兴四大诗人"之一',
    },
    {
        id: 'poet-zengji',
        name: '曾几',
        dynasty: '宋',
        birthYear: 1084,
        deathYear: 1166,
        style: '清劲雅正，活泼自然',
        brief: '南宋诗人，陆游之师',
    },
    {
        id: 'poet-lumeipo',
        name: '卢梅坡',
        dynasty: '宋',
        style: '咏物诗，工于梅雪',
        brief: '南宋诗人，字梅坡，名卢钺',
    },
    {
        id: 'poet-leizhen',
        name: '雷震',
        dynasty: '宋',
        style: '田园诗风，清新自然',
        brief: '南宋诗人，生平不详',
    },
    {
        id: 'poet-linqsheng',
        name: '林升',
        dynasty: '宋',
        style: '讽刺诗，直指时弊',
        brief: '南宋诗人，生平不详',
    },
    {
        id: 'poet-xinqiji',
        name: '辛弃疾',
        dynasty: '宋',
        birthYear: 1140,
        deathYear: 1207,
        style: '豪放词派，慷慨悲壮',
        brief: '南宋爱国词人，与苏轼并称"苏辛"',
    },
    {
        id: 'poet-liqingzhao',
        name: '李清照',
        dynasty: '宋',
        birthYear: 1084,
        deathYear: 1155,
        style: '婉约词派，清新凄美',
        brief: '婉约词宗，"千古第一才女"',
    },
    {
        id: 'poet-wengjuan',
        name: '翁卷',
        dynasty: '宋',
        style: '田园诗风，清新自然',
        brief: '南宋"永嘉四灵"之一',
    },
    {
        id: 'poet-yeShaoweng',
        name: '叶绍翁',
        dynasty: '宋',
        birthYear: 1194,
        deathYear: 1264,
        style: '婉约含蓄，意境深远',
        brief: '南宋诗人，江湖诗派代表',
    },
    {
        id: 'poet-shaoyong',
        name: '邵雍',
        dynasty: '宋',
        birthYear: 1011,
        deathYear: 1077,
        style: '理学诗，平易近人',
        brief: '北宋理学家，"北宋五子"之一',
    },
    {
        id: 'poet-kouzhun',
        name: '寇准',
        dynasty: '宋',
        birthYear: 961,
        deathYear: 1023,
        style: '清丽含蓄，意境深远',
        brief: '北宋政治家，七岁作《咏华山》',
    },
    // 元代
    {
        id: 'poet-wangmian',
        name: '王冕',
        dynasty: '元',
        birthYear: 1287,
        deathYear: 1359,
        style: '咏梅诗，清高孤傲',
        brief: '元代诗人、画家，以画梅著称',
    },
    // 明代
    {
        id: 'poet-tangyin',
        name: '唐寅',
        dynasty: '明',
        birthYear: 1470,
        deathYear: 1524,
        style: '才华横溢，放荡不羁',
        brief: '"明四家"之一，字伯虎',
    },
    {
        id: 'poet-yuqian',
        name: '于谦',
        dynasty: '明',
        birthYear: 1398,
        deathYear: 1457,
        style: '托物言志，刚正不阿',
        brief: '明代名臣，"粉骨碎身浑不怕"',
    },
    // 清代
    {
        id: 'poet-nalanxingde',
        name: '纳兰性德',
        dynasty: '清',
        birthYear: 1655,
        deathYear: 1685,
        style: '婉约词风，哀感顽艳',
        brief: '清代词人，"人生若只如初见"传世',
    },
    {
        id: 'poet-zhengxie',
        name: '郑燮',
        dynasty: '清',
        birthYear: 1693,
        deathYear: 1765,
        style: '题画诗，清新峭拔',
        brief: '"扬州八怪"之一，字板桥',
    },
    {
        id: 'poet-yuanmei',
        name: '袁枚',
        dynasty: '清',
        birthYear: 1716,
        deathYear: 1797,
        style: '性灵说，直抒性情',
        brief: '清代诗人，"性灵派"代表',
    },
    {
        id: 'poet-chashnxing',
        name: '查慎行',
        dynasty: '清',
        birthYear: 1650,
        deathYear: 1727,
        style: '工于白描，意境清远',
        brief: '清代诗人，"清初六家"之一',
    },
    {
        id: 'poet-gaoding',
        name: '高鼎',
        dynasty: '清',
        birthYear: 1828,
        deathYear: 1880,
        style: '田园诗风，清新自然',
        brief: '晚清诗人，《村居》传世',
    },
    {
        id: 'poet-gongzizhen',
        name: '龚自珍',
        dynasty: '清',
        birthYear: 1792,
        deathYear: 1841,
        style: '政论诗风，犀利深刻',
        brief: '清末思想家、文学家，"不拘一格降人才"',
    },
    // 现代
    {
        id: 'poet-maozedong',
        name: '毛泽东',
        dynasty: '现代',
        birthYear: 1893,
        deathYear: 1976,
        style: '气魄宏大，豪放壮美',
        brief: '革命家、诗人，"数风流人物，还看今朝"',
    },
] as const

// ─────────────────────────────────────────────────────────────
// 诗人师承关系（全量，6 现有 + 10 新增 = 16 条）
// 约定：mentor 为师法对象（前人），mentee 为受影响者（后人）
// ─────────────────────────────────────────────────────────────

export const SEED_MENTORSHIPS_FULL: readonly SeedMentorship[] = [
    // ===== 现有 6 条师承关系（复用 seed-data.ts）=====
    ...SEED_MENTORSHIPS,

    // ===== 新增 10 条师承/交游/并称关系 =====
    {
        mentor: '陶渊明',
        mentee: '王维',
        note: '王维田园诗深受陶渊明影响，"采菊东篱下"与王维山水田园一脉相承',
    },
    {
        mentor: '贺知章',
        mentee: '李白',
        note: '贺知章见李白诗，呼为"谪仙人"，金龟换酒，成为唐代文坛佳话',
    },
    {
        mentor: '李白',
        mentee: '杜甫',
        note: '"李杜"并称，杜甫深受李白诗风影响，"白也诗无敌，飘然思不群"',
    },
    {
        mentor: '王维',
        mentee: '孟浩然',
        note: '"王孟"并称，盛唐山水田园诗派双璧，诗风互有影响',
    },
    {
        mentor: '高适',
        mentee: '王昌龄',
        note: '盛唐边塞诗派并称，"高岑王昌龄"同属边塞诗风代表',
    },
    {
        mentor: '苏轼',
        mentee: '辛弃疾',
        note: '"苏辛"并称，豪放词派代表，辛弃疾承苏轼豪放词风',
    },
    {
        mentor: '李清照',
        mentee: '辛弃疾',
        note: '"济南二安"并称（李清照号易安，辛弃疾字幼安），同为济南词人',
    },
    {
        mentor: '陆游',
        mentee: '杨万里',
        note: '南宋"中兴四大诗人"并称（陆游、杨万里、范成大、尤袤）',
    },
    {
        mentor: '韩愈',
        mentee: '贾岛',
        note: '"推敲"典故：贾岛炼字"僧推月下门"还是"僧敲"，韩愈定为"敲"',
    },
    {
        mentor: '杜甫',
        mentee: '韩愈',
        note: '韩愈推崇杜诗，"李杜文章在，光焰万丈长"，以文为诗受杜甫影响',
    },
] as const

// ─────────────────────────────────────────────────────────────
// 全量古诗种子数据
// 聚合 6 个批次 + 修正《古朗月行（节选）》为 8 句版 + 补齐 14 首缺失篇目
// ─────────────────────────────────────────────────────────────

/**
 * 修正版《古朗月行（节选）》—— 统编版教材为 8 句完整版
 * 现有 tongbian-023 仅 4 句，此处替换为 8 句版
 */
const CORRECTED_GULANGYUEXING: SeedPoem = {
    id: 'tongbian-023',
    title: '古朗月行（节选）',
    poet: '李白',
    dynasty: '唐',
    content:
        '小时不识月，呼作白玉盘。\n又疑瑶台镜，飞在青云端。\n仙人垂两足，桂树何团团。\n白兔捣药成，问言与谁餐。',
    annotation: {
        '呼作': '称为，叫作',
        '白玉盘': '白玉做的盘子，这里喻指月亮',
        '瑶台镜': '神仙瑶台上的镜子，这里喻指月亮',
        '青云端': '青云的尽头，指高空',
        '仙人垂两足': '传说月亮中有仙人，其双足垂下',
        '桂树团团': '传说月中有桂树，团团形容桂树圆圆的样子',
        '白兔捣药': '传说月中有白兔捣制不死之药',
        '问言': '问，向谁询问',
    },
    themes: ['咏物', '童趣'],
    images: ['月', '白玉盘', '瑶台镜', '仙人', '桂树', '白兔'],
    rhetoric: ['比喻', '白描'],
    gradeLevel: '一年级',
    difficulty: 2,
}

/**
 * 14 首缺失必背篇目（ID 从 tongbian-s29 起始，衔接 batch-supplement 的 s01-s28）
 * 原文经古诗词网、维基文库、人教社官方答复多源交叉验证
 */
const MISSING_POEMS: readonly SeedPoem[] = [
    // s29. 晓出净慈寺送林子方（杨万里·宋·二年级下册）
    {
        id: 'tongbian-s29',
        title: '晓出净慈寺送林子方',
        poet: '杨万里',
        dynasty: '宋',
        content:
            '毕竟西湖六月中，风光不与四时同。\n接天莲叶无穷碧，映日荷花别样红。',
        annotation: {
            '毕竟': '到底',
            '四时': '春夏秋冬四季',
            '接天': '与天相接',
            '无穷碧': '一片无边无际的碧绿',
            '别样红': '红得与众不同',
        },
        themes: ['咏景', '夏景', '送别'],
        images: ['西湖', '莲叶', '荷花', '日'],
        rhetoric: ['夸张', '对偶'],
        gradeLevel: '二年级',
        difficulty: 3,
    },
    // s30. 浪淘沙（其七）（刘禹锡·唐·四年级上册）
    {
        id: 'tongbian-s30',
        title: '浪淘沙（其七）',
        poet: '刘禹锡',
        dynasty: '唐',
        content: '八月涛声吼地来，头高数丈触山回。\n须臾却入海门去，卷起沙堆似雪堆。',
        annotation: {
            '八月涛': '指钱塘江八月大潮',
            '吼地来': '好像咆哮着从大地奔来',
            '头高数丈': '潮头高达数丈',
            '触山回': '撞击山崖后回涌',
            '须臾': '片刻，一会儿',
            '海门': '海潮入口处',
        },
        themes: ['咏景', '壮美'],
        images: ['涛声', '山', '海门', '沙堆', '雪堆'],
        rhetoric: ['比喻', '夸张'],
        gradeLevel: '四年级',
        difficulty: 4,
    },
    // s31. 四时田园杂兴（其二十五）（范成大·宋·四年级下册）
    {
        id: 'tongbian-s31',
        title: '四时田园杂兴（其二十五）',
        poet: '范成大',
        dynasty: '宋',
        content:
            '梅子金黄杏子肥，麦花雪白菜花稀。\n日长篱落无人过，惟有蜻蜓蛱蝶飞。',
        annotation: {
            '杂兴': '有感而发，随事吟咏',
            '肥': '果实饱满',
            '麦花雪白': '麦花像雪一样白',
            '篱落': '篱笆',
            '惟有': '只有',
            '蛱蝶': '蝴蝶的一种',
        },
        themes: ['田园', '夏景'],
        images: ['梅子', '杏子', '麦花', '菜花', '篱笆', '蜻蜓', '蛱蝶'],
        rhetoric: ['对偶', '白描'],
        gradeLevel: '四年级',
        difficulty: 3,
    },
    // s32. 蝉（虞世南·唐·五年级上册）
    {
        id: 'tongbian-s32',
        title: '蝉',
        poet: '虞世南',
        dynasty: '唐',
        content: '垂緌饮清露，流响出疏桐。\n居高声自远，非是藉秋风。',
        annotation: {
            '緌': '古人结在颔下的帽带下垂部分，蝉的嘴似緌',
            '清露': '清纯的露水',
            '流响': '蝉鸣声长鸣不已',
            '疏桐': '稀疏的梧桐树',
            '居高': '栖息在高处',
            '藉': '凭借，依靠',
        },
        themes: ['咏物', '言志'],
        images: ['蝉', '清露', '疏桐', '秋风'],
        rhetoric: ['比喻', '说理'],
        gradeLevel: '五年级',
        difficulty: 4,
    },
    // s33. 山居秋暝（王维·唐·五年级上册）
    {
        id: 'tongbian-s33',
        title: '山居秋暝',
        poet: '王维',
        dynasty: '唐',
        content:
            '空山新雨后，天气晚来秋。\n明月松间照，清泉石上流。\n竹喧归浣女，莲动下渔舟。\n随意春芳歇，王孙自可留。',
        annotation: {
            '暝': '日落，天色将晚',
            '新雨': '刚下过的雨',
            '竹喧': '竹林中笑语喧哗',
            '浣女': '洗衣服的女子',
            '随意': '任凭',
            '春芳歇': '春天的花草凋谢',
            '王孙': '原指贵族子弟，这里诗人自指',
        },
        themes: ['咏景', '隐逸', '秋景'],
        images: ['空山', '新雨', '明月', '松', '清泉', '石', '竹', '浣女', '莲', '渔舟'],
        rhetoric: ['对偶', '白描'],
        gradeLevel: '五年级',
        difficulty: 4,
    },
    // s34. 长相思·山一程（纳兰性德·清·五年级上册）
    {
        id: 'tongbian-s34',
        title: '长相思·山一程',
        poet: '纳兰性德',
        dynasty: '清',
        content:
            '山一程，水一程，身向榆关那畔行，夜深千帐灯。\n风一更，雪一更，聒碎乡心梦不成，故园无此声。',
        annotation: {
            '长相思': '词牌名',
            '程': '路程，旅程',
            '榆关': '山海关',
            '那畔': '那边，指关外',
            '千帐灯': '千万个营帐灯火通明',
            '更': '旧时夜间计时单位',
            '聒': '声音嘈杂，吵醒',
            '故园': '故乡',
        },
        themes: ['思乡', '羁旅'],
        images: ['山', '水', '榆关', '帐灯', '风', '雪', '故园'],
        rhetoric: ['反复', '对偶'],
        gradeLevel: '五年级',
        difficulty: 4,
    },
    // s35. 渔歌子·西塞山前白鹭飞（张志和·唐·五年级上册）
    {
        id: 'tongbian-s35',
        title: '渔歌子',
        poet: '张志和',
        dynasty: '唐',
        content:
            '西塞山前白鹭飞，桃花流水鳜鱼肥。\n青箬笠，绿蓑衣，斜风细雨不须归。',
        annotation: {
            '渔歌子': '词牌名',
            '西塞山': '在今浙江湖州',
            '白鹭': '一种水鸟',
            '桃花流水': '桃花盛开的季节春水上涨',
            '鳜鱼': '一种淡水鱼，味道鲜美',
            '箬笠': '用竹叶编的斗笠',
            '蓑衣': '用草或棕编成的雨衣',
            '不须归': '不想回家',
        },
        themes: ['咏景', '隐逸', '春景'],
        images: ['西塞山', '白鹭', '桃花', '流水', '鳜鱼', '箬笠', '蓑衣', '斜风细雨'],
        rhetoric: ['对偶', '白描'],
        gradeLevel: '五年级',
        difficulty: 3,
    },
    // s36. 观书有感（其一）（朱熹·宋·五年级上册）
    {
        id: 'tongbian-s36',
        title: '观书有感（其一）',
        poet: '朱熹',
        dynasty: '宋',
        content: '半亩方塘一鉴开，天光云影共徘徊。\n问渠那得清如许？为有源头活水来。',
        annotation: {
            '方塘': '方形的水塘',
            '一鉴开': '像一面镜子打开',
            '徘徊': '来回移动',
            '渠': '它，指方塘',
            '那得': '怎么会',
            '清如许': '这样清澈',
            '为': '因为',
            '源头活水': '源头上不断流来的新鲜水',
        },
        themes: ['哲理', '读书'],
        images: ['方塘', '鉴', '天光', '云影', '源头', '活水'],
        rhetoric: ['比喻', '设问', '哲理'],
        gradeLevel: '五年级',
        difficulty: 4,
    },
    // s37. 观书有感（其二）（朱熹·宋·五年级上册）
    {
        id: 'tongbian-s37',
        title: '观书有感（其二）',
        poet: '朱熹',
        dynasty: '宋',
        content: '昨夜江边春水生，蒙冲巨舰一毛轻。\n向来枉费推移力，此日中流自在行。',
        annotation: {
            '春水生': '春水上涨',
            '蒙冲': '古代战船名，也作"艨艟"',
            '一毛轻': '轻如鸿毛',
            '向来': '从前，以前',
            '枉费': '白白浪费',
            '推移力': '推拉移动的力气',
            '中流': '江水中央',
            '自在行': '自由自在地航行',
        },
        themes: ['哲理', '读书'],
        images: ['江', '春水', '蒙冲巨舰', '毛', '中流'],
        rhetoric: ['比喻', '对比', '哲理'],
        gradeLevel: '五年级',
        difficulty: 4,
    },
    // s38. 鸟鸣涧（王维·唐·五年级下册）
    {
        id: 'tongbian-s38',
        title: '鸟鸣涧',
        poet: '王维',
        dynasty: '唐',
        content: '人闲桂花落，夜静春山空。\n月出惊山鸟，时鸣春涧中。',
        annotation: {
            '闲': '闲静，安静',
            '桂花': '一种芳香花卉',
            '空': '空寂',
            '月出': '月亮升起',
            '惊': '惊动',
            '时鸣': '不时地鸣叫',
            '涧': '山间流水',
        },
        themes: ['咏景', '春景', '禅意'],
        images: ['桂花', '春山', '月', '山鸟', '春涧'],
        rhetoric: ['白描', '以动衬静'],
        gradeLevel: '五年级',
        difficulty: 3,
    },
    // s39. 游子吟（孟郊·唐·五年级下册）
    {
        id: 'tongbian-s39',
        title: '游子吟',
        poet: '孟郊',
        dynasty: '唐',
        content:
            '慈母手中线，游子身上衣。\n临行密密缝，意恐迟迟归。\n谁言寸草心，报得三春晖。',
        annotation: {
            '游子': '离家在外游历的人',
            '临行': '将要出发',
            '意恐': '担心',
            '寸草心': '小草的嫩心，比喻子女微小的心意',
            '报得': '报答得了',
            '三春晖': '春天三个月的阳光，比喻母爱',
        },
        themes: ['母爱', '感恩'],
        images: ['线', '衣', '寸草', '三春晖'],
        rhetoric: ['比喻', '对偶'],
        gradeLevel: '五年级',
        difficulty: 3,
    },
    // s40. 乡村四月（翁卷·宋·五年级下册）
    {
        id: 'tongbian-s40',
        title: '乡村四月',
        poet: '翁卷',
        dynasty: '宋',
        content: '绿遍山原白满川，子规声里雨如烟。\n乡村四月闲人少，才了蚕桑又插田。',
        annotation: {
            '山原': '山陵和原野',
            '白满川': '稻田里的水色映着天光',
            '子规': '杜鹃鸟',
            '雨如烟': '细雨像烟雾一样',
            '才了': '刚刚做完',
            '蚕桑': '种桑养蚕',
            '插田': '插秧',
        },
        themes: ['田园', '劳作', '夏景'],
        images: ['山原', '川', '子规', '雨', '蚕桑', '田'],
        rhetoric: ['比喻', '白描'],
        gradeLevel: '五年级',
        difficulty: 3,
    },
    // s41. 宿建德江（孟浩然·唐·六年级上册）
    {
        id: 'tongbian-s41',
        title: '宿建德江',
        poet: '孟浩然',
        dynasty: '唐',
        content: '移舟泊烟渚，日暮客愁新。\n野旷天低树，江清月近人。',
        annotation: {
            '建德江': '指新安江流经建德的一段',
            '移舟': '划动小船',
            '泊': '停船靠岸',
            '烟渚': '烟雾笼罩的小洲',
            '客': '诗人自指',
            '愁新': '新的愁绪',
            '野旷': '原野空旷',
            '天低树': '天比树还低',
        },
        themes: ['羁旅', '愁思', '咏景'],
        images: ['舟', '烟渚', '日暮', '野', '天', '树', '江', '月'],
        rhetoric: ['对偶', '白描'],
        gradeLevel: '六年级',
        difficulty: 3,
    },
    // s42. 六月二十七日望湖楼醉书（苏轼·宋·六年级上册）
    {
        id: 'tongbian-s42',
        title: '六月二十七日望湖楼醉书',
        poet: '苏轼',
        dynasty: '宋',
        content:
            '黑云翻墨未遮山，白雨跳珠乱入船。\n卷地风来忽吹散，望湖楼下水如天。',
        annotation: {
            '望湖楼': '在今杭州西湖边',
            '醉书': '酒后书写',
            '翻墨': '像打翻的墨汁',
            '未遮山': '还没遮住山',
            '跳珠': '像跳动的珍珠',
            '卷地风': '卷地而来的风',
            '忽吹散': '忽然吹散',
            '水如天': '水面像天空一样平静',
        },
        themes: ['咏景', '夏景'],
        images: ['黑云', '墨', '山', '白雨', '珠', '船', '风', '望湖楼', '水', '天'],
        rhetoric: ['比喻', '对偶'],
        gradeLevel: '六年级',
        difficulty: 3,
    },
] as const

/**
 * 按 title 去重聚合所有批次的种子古诗
 *
 * 去重策略：
 * 1. 按 title 精确匹配（含词牌名的完整标题）
 * 2. 保留首次出现的版本（批次靠前的优先）
 * 3. 保留原始 ID（不重新编号，ID 仅作标识符，不要求连续）
 *
 * 额外处理：
 * - 修正《古朗月行（节选）》为统编版教材 8 句版
 * - 追加 14 首缺失必背篇目（tongbian-s29 ~ tongbian-s42）
 */
function buildSeedPoemsFull(): SeedPoem[] {
    const allBatches: readonly (readonly SeedPoem[])[] = [
        SEED_POEMS,
        SEED_POEMS_BATCH_2,
        SEED_POEMS_BATCH_3,
        SEED_POEMS_BATCH_4,
        SEED_POEMS_BATCH_5,
        SEED_POEMS_SUPPLEMENT,
    ]

    const seen = new Set<string>()
    const result: SeedPoem[] = []

    for (const batch of allBatches) {
        for (const poem of batch) {
            if (!seen.has(poem.title)) {
                seen.add(poem.title)
                // 修正《古朗月行（节选）》为 8 句版
                if (poem.id === 'tongbian-023') {
                    result.push(CORRECTED_GULANGYUEXING)
                } else {
                    result.push(poem)
                }
            }
        }
    }

    // 追加 14 首缺失必背篇目
    for (const poem of MISSING_POEMS) {
        if (!seen.has(poem.title)) {
            seen.add(poem.title)
            result.push(poem)
        }
    }

    return result
}

/** 全量古诗种子数据（去重 + 修正 + 补齐后） */
export const SEED_POEMS_FULL: readonly SeedPoem[] = buildSeedPoemsFull()

/** 全量古诗总数（去重后） */
export const SEED_POEMS_FULL_COUNT = SEED_POEMS_FULL.length
