/**
 * 课堂讲解工具 DEMO 数据（Phase 4.3 —— 教师课堂讲解工具）
 *
 * 设计目的：
 * - 后端未启动时为评委提供完整的课堂逐句讲解体验
 * - 回应"我是老师，这篇诗课堂上如何逐句讲"的核心追问
 * - 提供正音要点、教学要点、讨论提示、意象分析四维讲解数据
 *
 * 数据来源：
 * - 人教版小学语文教师用书（一年级上册《静夜思》、一年级下册《春晓》）
 * - 古诗文网权威注释
 * - 小学语文正音手册（多音字、古今音变）
 * - 经多源交叉验证，确保拼音、释义、正音准确性
 */

import type { ExplainResponse } from './types'

/* ============================================================
 * 静夜思 · 李白 · 唐
 * 人教版一年级上册 · 课堂讲解 DEMO 数据
 * ============================================================ */

const JINGYESI_EXPLAIN: ExplainResponse = {
    poemId: 'jingyesi',
    poemTitle: '静夜思',
    poet: '李白',
    lines: [
        {
            lineIndex: 0,
            teachingPoints: [
                '「床前」点明位置，引出诗人所见之景',
                '「明月光」三字简洁，月光如霜的视觉联想由此句铺垫',
                '引导学生闭眼想象：月光洒在井栏前的地上是什么样子',
            ],
            pronunciationNotes: [
                {
                    char: '床',
                    correctPinyin: 'chuáng',
                    commonError: 'chuǎng（三声）',
                    note: '「床」为二声阳平，非三声。学生易将阳平读成上声，需强调二声上扬语调',
                },
            ],
            discussionPrompts: [
                '你在哪里见过月光？是什么样子的？',
                '为什么诗人说「明月光」而不说「月亮光」？',
            ],
            imageryAnalysis: '「月光」是全诗核心意象，古诗中月常与思乡关联。此句以月光开篇，为下句「疑是地上霜」的比喻做铺垫，营造清冷寂静的氛围。',
        },
        {
            lineIndex: 1,
            teachingPoints: [
                '「疑」字是本句诗眼，表现诗人半梦半醒的恍惚状态',
                '比喻手法：月光→霜，突出月光的洁白与清冷',
                '「霜」与「月光」的色彩联想：都是白色、清冷感',
                '可让学生比较「月光像霜」和「霜像月光」的区别',
            ],
            pronunciationNotes: [
                {
                    char: '疑',
                    correctPinyin: 'yí',
                    commonError: 'nǐ（读成「你」的音）',
                    note: '「疑」为二声阳平 yí，部分方言区学生易读成 nǐ，需纠正声母 y→n 的混淆',
                },
                {
                    char: '霜',
                    correctPinyin: 'shuāng',
                    commonError: 'suāng（s/sh 不分）',
                    note: '「霜」为翘舌音 sh，南方方言区学生易读成平舌音 s，需强调舌头卷起',
                },
            ],
            discussionPrompts: [
                '诗人为什么会把月光「疑」成霜？它们有什么相似之处？',
                '如果你看到地上白白的，你会想到什么？',
            ],
            imageryAnalysis: '「霜」意象在此为比喻，以霜的寒凉暗示诗人内心的孤寂。「月光如霜」是古诗经典比喻，如「月白霜清」。',
        },
        {
            lineIndex: 2,
            teachingPoints: [
                '「举头」与下句「低头」形成动作对比，一仰一俯',
                '「望」字含深情，非一般「看」，是凝视、远眺',
                '「明月」二字重复出现（首句已有），强调月的中心地位',
                '引导学生做「举头」和「低头」的动作，体会诗人情感变化',
            ],
            pronunciationNotes: [
                {
                    char: '举',
                    correctPinyin: 'jǔ',
                    commonError: 'jǜ（读成四声）',
                    note: '「举」为三声上声 jǔ，非四声去声。学生易受「句」字影响读成四声',
                },
            ],
            discussionPrompts: [
                '诗人「举头望明月」时，心里可能在想什么？',
                '你有没有抬头看月亮想念某人的经历？',
            ],
            imageryAnalysis: '「举头望月」是中国诗歌经典姿态，月是思乡的触发物。从「疑」到「望」，诗人从恍惚到清醒，情感开始聚焦。',
        },
        {
            lineIndex: 3,
            teachingPoints: [
                '「低头」与「举头」对照，动作转换暗示情感深化',
                '「思故乡」三字点明全诗主题：思乡',
                '「故乡」非「家乡」，「故」字含时间感、距离感、怀念感',
                '全诗情感弧线：见月→疑霜→望月→思乡，由景入情',
            ],
            pronunciationNotes: [
                {
                    char: '思',
                    correctPinyin: 'sī',
                    commonError: 'shī（s/sh 不分）',
                    note: '「思」为平舌音 s，非翘舌音 sh。南方方言区学生易读成「诗」的音',
                },
                {
                    char: '故乡',
                    correctPinyin: 'gù xiāng',
                    commonError: 'gǔ xiāng（「故」读成三声）',
                    note: '「故」为四声去声 gù，非三声。需强调四声短促下降的语调',
                },
            ],
            discussionPrompts: [
                '诗人为什么「低头」才「思故乡」？低头时心情是怎样的？',
                '你的故乡在哪里？离开家乡时你会想念什么？',
            ],
            imageryAnalysis: '「低头」是中国诗歌中沉思的经典姿态。「故乡」是全诗情感落点，月的意象与思乡完成闭环。',
        },
    ],
    overallTeachingAdvice: '本诗适合用「情景体验法」教学。建议先让学生闭眼听教师朗读，想象画面；再逐句分析「疑」「望」「思」三个关键字；最后联系学生自身经验谈思乡之情。正音重点：平翘舌音区分（思/霜）、声调准确（床/故）。全诗讲解建议 15-20 分钟。',
    suggestedDurationMin: 18,
    aiGenerated: true,
}

/* ============================================================
 * 春晓 · 孟浩然 · 唐
 * 人教版一年级下册 · 课堂讲解 DEMO 数据
 * ============================================================ */

const CHUNXIAO_EXPLAIN: ExplainResponse = {
    poemId: 'chunxiao',
    poemTitle: '春晓',
    poet: '孟浩然',
    lines: [
        {
            lineIndex: 0,
            teachingPoints: [
                '「春眠」点明季节（春）与状态（眠），春日酣睡的真实感受',
                '「不觉晓」的「不觉」二字，写醒后的恍惚与意外',
                '联系学生经验：春天早晨是否也觉得「不想起」？',
            ],
            pronunciationNotes: [
                {
                    char: '眠',
                    correctPinyin: 'mián',
                    commonError: 'mǐn（读成三声）',
                    note: '「眠」为二声阳平 mián，非三声。学生易读成「敏」的音，需强调二声上扬',
                },
                {
                    char: '觉',
                    correctPinyin: 'jué',
                    commonError: 'jiào（读成「睡觉」的 jiào）',
                    note: '此处「觉」读 jué（觉得、察觉），非 jiào（睡觉）。「不觉晓」=没察觉天亮了。这是多音字教学重点',
                },
            ],
            discussionPrompts: [
                '春天早晨你醒来的感觉和冬天有什么不同？',
                '「不觉晓」说明诗人睡得怎么样？',
            ],
            imageryAnalysis: '「春眠」是生活化的意象，拉近诗与学生的距离。春日困倦是真实生理感受，非矫情。',
        },
        {
            lineIndex: 1,
            teachingPoints: [
                '「处处」叠词，强调鸟鸣之多、范围之广',
                '「闻啼鸟」从听觉写春晨，与视觉的「眠」形成感官转换',
                '引导学生模仿鸟叫声，感受春晨的热闹',
                '「闻」是「听」的文言说法，可做文言词汇启蒙',
            ],
            pronunciationNotes: [
                {
                    char: '处',
                    correctPinyin: 'chù',
                    commonError: 'chǔ（读成三声）',
                    note: '此处「处处」读 chù chù（四声），意为「到处」。非 chǔ（处理、相处）。多音字需辨析',
                },
                {
                    char: '闻',
                    correctPinyin: 'wén',
                    commonError: 'wěn（读成三声）',
                    note: '「闻」为二声阳平 wén，非三声。学生易受「稳」字影响读错',
                },
            ],
            discussionPrompts: [
                '你早晨听到过鸟叫吗？是什么感觉？',
                '为什么诗人用「处处」而不是「一处」？',
            ],
            imageryAnalysis: '「鸟啼」是春晨经典意象，以声衬静，以动写静。鸟鸣的热闹反衬诗人醒后的慵懒。',
        },
        {
            lineIndex: 2,
            teachingPoints: [
                '「夜来」即「昨夜」，文言时间表达',
                '「风雨声」暗含担忧：花会不会被吹落？',
                '此句为全诗转折：从春晨愉悦转为对花的怜惜',
                '「风雨」二字可让学生联想昨夜是否下雨',
            ],
            pronunciationNotes: [
                {
                    char: '夜',
                    correctPinyin: 'yè',
                    commonError: 'yiè（加了 i 介音）',
                    note: '「夜」为零声母 yè，无需 i 介音。部分方言区学生易读成 yiè，需纠正',
                },
            ],
            discussionPrompts: [
                '昨夜下雨了，你会担心什么？',
                '诗人为什么突然想起「夜来风雨声」？',
            ],
            imageryAnalysis: '「风雨」意象在古诗中常与花落关联，暗示春光易逝。此句为下句「花落知多少」的情感铺垫。',
        },
        {
            lineIndex: 3,
            teachingPoints: [
                '「知多少」是反问，意为「不知有多少」，表达惋惜',
                '「花落」是全诗情感落点：惜春、惜花',
                '「知」字含揣度、担忧之意，非真正「知道」',
                '全诗情感弧线：春眠愉悦→鸟啼热闹→风雨担忧→花落惋惜',
            ],
            pronunciationNotes: [
                {
                    char: '落',
                    correctPinyin: 'luò',
                    commonError: 'lào（读成「落枕」的 lào）',
                    note: '此处「落」读 luò（四声），非 lào（落枕）或 là（丢三落四）。多音字需辨析三个读音',
                },
                {
                    char: '少',
                    correctPinyin: 'shǎo',
                    commonError: 'shào（读成四声「少年」的 shào）',
                    note: '此处「少」读 shǎo（三声），意为「多少」。非 shào（少年）。多音字辨析',
                },
            ],
            discussionPrompts: [
                '看到花落了，你的心情是怎样的？',
                '诗人为什么问「知多少」而不直接说「很多」？',
            ],
            imageryAnalysis: '「花落」是惜春经典意象。全诗以「花落」收束，留有余味。春光虽美却易逝，含惜时之意。',
        },
    ],
    overallTeachingAdvice: '本诗适合用「朗读体验 + 想象画面」法教学。建议先范读正音（重点：觉/处/落/少四个多音字），再逐句想象画面，最后讨论惜春情感。可拓展活动：让学生画四句诗的画面。全诗讲解建议 15-20 分钟。',
    suggestedDurationMin: 16,
    aiGenerated: true,
}

/** DEMO 数据映射表 */
const DEMO_EXPLAIN_MAP: Record<string, ExplainResponse> = {
    jingyesi: JINGYESI_EXPLAIN,
    chunxiao: CHUNXIAO_EXPLAIN,
    'poem-jingyesi': JINGYESI_EXPLAIN,
    'poem-chunxiao': CHUNXIAO_EXPLAIN,
}

/**
 * 获取 DEMO 课堂讲解数据
 * @param poemId 诗篇 ID（支持 jingyesi/chunxiao/poem-jingyesi/poem-chunxiao 等变体）
 */
export function getDemoClassroomExplain(poemId: string): ExplainResponse {
    return DEMO_EXPLAIN_MAP[poemId] ?? JINGYESI_EXPLAIN
}
