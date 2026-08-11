/**
 * DEMO 模式教案数据（Phase 3 —— 教师教学流程闭环）
 *
 * 设计依据：评委无后端时仍可预览完整教师备课体验。
 *
 * 数据来源（多源交叉验证）：
 * 1. 《义务教育语文课程标准》第一学段古诗词教学要求
 * 2. 人教版小学语文教师教学用书（一年级上册/下册）
 * 3. 古诗文网（gushiwen.org）诗文原文与赏析
 * 4. 商务印书馆《古汉语常用字字典》第5版
 * 5. Bloom认知六阶分类法（修正版）
 *
 * 每份教案包含：
 * - 三维教学目标（知识/能力/情感）× Bloom六阶
 * - 教学重难点
 * - 教学准备
 * - 完整教学过程6环节（导入/识字/释义/感悟/拓展/练习+作业）
 * - 板书设计
 * - 作业布置（分层：基础+选做）
 * - 教学反思建议（基于诊断数据）
 *
 * 与 PoemContent（学生识字学诗）的区别：
 * - PoemContent 面向学生：拼音/译文/生字/默写
 * - LessonPlan 面向教师：教学目标/过程/板书/作业/反思
 */

import type {
    LessonPlan,
    LessonPlanListItem,
    LessonPlanGenerateRequest,
    LessonPlanGenerateResponse,
    LessonPlanSaveResponse,
    LessonPlanListResponse,
    BloomLevel,
    CreationGradeLevel,
} from './types'
import { releasedStarmapImagePath } from './poem-generated-images'

/* ============================================================
 * 静夜思 · 李白 · 唐 · 一年级上册
 * 教学时长：1课时（40分钟）
 * 教学依据：人教版一上第4单元"课文"第3课
 * ============================================================ */

const JINGYE_SI_LESSON_PLAN: LessonPlan = {
    id: 'demo-lp-jingyesi',
    poemId: 'jingyesi',
    poemTitle: '静夜思',
    poet: '李白',
    dynasty: '唐',
    gradeLevel: '1-2年级',
    classId: null,
    className: '一年级（1）班',
    teacherName: '王老师',
    title: '静夜思 · 一年级上册 · 第1课时',
    lessonCount: 1,
    goals: [
        {
            category: 'knowledge',
            bloomLevel: '记忆',
            description: '学生能正确认读"床、前、明、月、光、疑、举、低"8个生字，会写"床、前、明、低"4个生字',
            assessment: '识字卡片抽读 + 田字格默写检测',
        },
        {
            category: 'knowledge',
            bloomLevel: '记忆',
            description: '学生能正确、流利、有感情地朗读并背诵全诗',
            assessment: '诗音阁朗读评分 + 课堂齐背',
        },
        {
            category: 'ability',
            bloomLevel: '理解',
            description: '学生能借助拼音和插图，说出每句诗的意思',
            assessment: '课堂提问 + 释义闯关',
        },
        {
            category: 'ability',
            bloomLevel: '分析',
            description: '学生能找出诗中表示动作的词语（举、低），体会诗人的情感变化',
            assessment: '课堂讨论 + 角色扮演',
        },
        {
            category: 'emotion',
            bloomLevel: '评价',
            description: '学生能感受诗人思乡之情，体会月夜的静谧美',
            assessment: '课堂表达 + 配画创作',
        },
        {
            category: 'emotion',
            bloomLevel: '创造',
            description: '学生能结合生活经验，为古诗配画或改写成小故事',
            assessment: '创造工坊作品评价',
        },
    ],
    keyPoints: [
        '认读8个生字，会写4个生字"床、前、明、低"',
        '正确、流利、有感情地朗读背诵全诗',
        '理解"疑、举、低"等关键词的意思',
    ],
    difficultPoints: [
        '体会"疑是地上霜"中比喻的妙处',
        '感受诗人由"望月"到"思乡"的情感变化',
        '理解"举头"与"低头"两个动作背后的情感张力',
    ],
    preparations: [
        '多媒体课件（含月夜图景、生字动画、朗读音频）',
        '生字卡片8张（床、前、明、月、光、疑、举、低）',
        '田字格小黑板（演示"床、前、明、低"笔顺）',
        '学生准备：语文课本、田字格本、铅笔',
        '课前准备：教师组织学生完成《静夜思》诊断与识字练习，并导入汇总结果',
    ],
    teachingProcess: [
        {
            phase: 'introduction',
            title: '激趣导入：月夜图景（5分钟）',
            durationMin: 5,
            teacherActivity:
                '1. 播放月夜图景视频（30秒），引导学生观察：你看到了什么？想到了什么？\n2. 提问：你离开过家吗？想家的时候是什么感觉？\n3. 引出课题：1300多年前，有一位诗人李白，他在一个静静的夜晚，看到明亮的月光，想起了远方的家乡，写下了一首流传千古的诗——今天我们就来学习《静夜思》。\n4. 板书课题，齐读课题。',
            studentActivity:
                '1. 观察月夜视频，自由表达所见所想\n2. 联系生活经验，分享"想家"的感受\n3. 齐读课题"静夜思"\n4. 了解诗人李白（教师简要介绍）',
            designIntent:
                '通过视觉冲击激发兴趣，联系生活经验唤起情感共鸣，自然引出课题。对应教学目标5（情感·评价）。',
            bloomLevels: ['记忆', '评价'],
            goalIndices: [4],
            aiGenerated: true,
        },
        {
            phase: 'literacy',
            title: '识字正音：扫清障碍（10分钟）',
            durationMin: 10,
            teacherActivity:
                '1. 教师范读，学生指字跟读，注意"疑(yí)、霜(shuāng)"的读音\n2. 出示8个生字卡片，逐字教学：\n   - 床(chuáng)：井栏，此指坐榻\n   - 疑(yí)：怀疑、好像（重点正音，二声）\n   - 霜(shuāng)：白霜（sh-ua-ng，重点正音）\n   - 举(jǔ)：抬起（j-ǔ，注意不要读成qǔ）\n3. 演示"床、前、明、低"4个生字的笔顺（田字格示范）\n4. 组词游戏：床（木床、起床）、前（前面、前后）、明（明天、明亮）、低（低头、高低）',
            studentActivity:
                '1. 跟读诗文，重点听清"疑、霜、举"的读音\n2. 借助拼音自由认读8个生字\n3. 观察田字格中4个生字的笔顺，书空练习\n4. 参与组词游戏，每个字至少说2个词\n5. 在田字格本上各写2遍"床、前、明、低"',
            designIntent:
                '识字是一年级古诗教学的重点。通过范读、正音、笔顺演示、组词游戏，多通道巩固生字。对应教学目标1（知识·记忆）。',
            bloomLevels: ['记忆', '理解'],
            goalIndices: [0],
            aiGenerated: true,
        },
        {
            phase: 'interpretation',
            title: '逐句释义：理解内容（10分钟）',
            durationMin: 10,
            teacherActivity:
                '1. 逐句讲解（结合课件插图）：\n   - "床前明月光"：明亮的月光洒在床前的地上\n   - "疑是地上霜"：好像地上结了一层白霜（讲解"疑"字，演示"霜"的样子）\n   - "举头望明月"：抬起头望着天上的明月（演示"举头"动作）\n   - "低头思故乡"：低下头不禁思念起故乡（演示"低头"动作）\n2. 提问引导：为什么诗人觉得月光像霜？这说明了什么？（引导感受月光的皎洁和夜的清冷）\n3. 比较动作："举头"和"低头"形成了什么对比？诗人为什么先举头后低头？',
            studentActivity:
                '1. 借助插图和讲解，理解每句诗的意思\n2. 同桌互说诗意，互相补充\n3. 思考并回答教师提问\n4. 模仿"举头""低头"动作，体会诗人动作的变化\n5. 用自己的话说说全诗大意',
            designIntent:
                '逐句释义帮助学生理解字面意思，关键问题引导深度思考比喻和动作对比的妙处。对应教学目标3、4（能力·理解、能力·分析）。',
            bloomLevels: ['理解', '分析'],
            goalIndices: [2, 3],
            aiGenerated: true,
        },
        {
            phase: 'appreciation',
            title: '整体感悟：体会情感（8分钟）',
            durationMin: 8,
            teacherActivity:
                '1. 配乐范读（古琴曲《平沙落雁》），学生闭眼想象画面\n2. 引导想象：你仿佛看到了什么？听到了什么？感受到了什么？\n3. 讨论：诗人为什么看到月亮就会想到家乡？（补充：古人有"见月思乡"的文化传统）\n4. 拓展：你还知道哪些写月亮的诗句？（预设：小时不识月，呼作白玉盘；举杯邀明月，对影成三人）',
            studentActivity:
                '1. 闭眼倾听配乐朗诵，想象诗中画面\n2. 自由表达想象的画面和感受\n3. 参与讨论，理解"见月思乡"的文化内涵\n4. 背诵自己知道的写月亮的诗句',
            designIntent:
                '通过配乐和想象，让学生身临其境感受诗境，体会诗人情感。文化拓展增强文化自信。对应教学目标5（情感·评价）。',
            bloomLevels: ['评价', '创造'],
            goalIndices: [4],
            aiGenerated: true,
        },
        {
            phase: 'extension',
            title: '拓展延伸：文化浸润（4分钟）',
            durationMin: 4,
            teacherActivity:
                '1. 介绍李白：唐代伟大诗人，被称为"诗仙"，一生写了许多思乡和写月的诗\n2. 简介创作背景：李白25岁离开家乡四川，漫游天下，《静夜思》写于扬州旅舍\n3. 拓展阅读：李白《古朗月行》（节选）"小时不识月，呼作白玉盘"\n4. 情感升华：无论时代如何变迁，思乡之情是永恒的。今天我们学习这首诗，不仅是学一首诗，更是传承一份中国人的情感。',
            studentActivity:
                '1. 倾听李白简介，了解诗人生平\n2. 跟读拓展诗句\n3. 谈谈自己学完这首诗的感受',
            designIntent:
                '文化语境还原，让学生在文化背景中理解诗歌。立德树人：传承中华优秀传统文化。对应教学目标5（情感·评价）。',
            bloomLevels: ['评价'],
            goalIndices: [4],
            aiGenerated: true,
        },
        {
            phase: 'practice',
            title: '课堂练习：巩固检测（3分钟）',
            durationMin: 3,
            teacherActivity:
                '1. 齐背全诗（配乐）\n2. 快速检测：\n   - 填空：床前（  ）光，疑是地上（  ）\n   - 选择："举头"的意思是（A.抬头 B.举手 C.举起）\n   - 判断：诗人在屋里看到的月光（√）\n3. 布置作业（见作业部分）',
            studentActivity:
                '1. 配乐齐背全诗\n2. 完成快速检测题\n3. 记录作业要求',
            designIntent:
                '当堂检测学习效果，巩固生字和诗意理解。对应教学目标1、2（知识·记忆）。',
            bloomLevels: ['记忆', '理解'],
            goalIndices: [0, 1],
            aiGenerated: true,
        },
    ],
    boardDesign: {
        title: '静夜思 · 板书设计',
        content:
            '┌─────────────────────────────────┐\n│         静夜思  李白（唐）        │\n│                                  │\n│  床前明月光  →  疑是地上霜        │\n│     （所见）     （所思）          │\n│         ↑                         │\n│     举头  ↕  低头                 │\n│    （望月）  （思乡）              │\n│                                  │\n│  主题：望月思乡                    │\n│  情感：思乡之情                    │\n└─────────────────────────────────┘',
        intent:
            '板书以"望月-思乡"为轴线，左侧是所见（月光、霜），右侧是所思（思乡）。"举头"和"低头"两个动作形成视觉对比，凸显情感张力。底部点明主题和情感。',
    },
    homework: [
        {
            type: 'dictation',
            description: '在田字格本上默写《静夜思》全诗，重点写对"床、前、明、低"4个生字',
            estimatedMin: 10,
            bloomLevel: '记忆',
            optional: false,
        },
        {
            type: 'recitation',
            description: '有感情地背诵《静夜思》给爸爸妈妈听，请他们打分',
            estimatedMin: 5,
            bloomLevel: '记忆',
            optional: false,
        },
        {
            type: 'creation',
            description: '为《静夜思》配一幅插图，画出你想象中的月夜画面',
            estimatedMin: 15,
            bloomLevel: '创造',
            optional: false,
        },
        {
            type: 'reading',
            description: '（选做）背诵李白《古朗月行》前四句"小时不识月，呼作白玉盘。又疑瑶台镜，飞在青云端"',
            estimatedMin: 10,
            bloomLevel: '记忆',
            optional: true,
        },
    ],
    reflection: {
        classOverview:
            '本班35名学生的课前诊断 DEMO 汇总显示：记忆层掌握度78分，理解层65分，分析层52分。该数据只用于演示流程，正式使用必须替换为教师核验后的真实班级数据。',
        highlights: [
            '生字"床、前、明"3字全班正确率100%',
            '朗读背诵流畅度高，诗音阁平均得分82分',
            '配画作业展现出较强的想象力和情感理解',
        ],
        improvements: [
            '"疑"字仍有8名学生读错（读成yǐ），需强化正音',
            '"举头望明月，低头思故乡"的情感张力理解不足，部分学生仅停留在字面',
            '比喻"疑是地上霜"的妙处，多数学生能复述但未能深度感悟',
        ],
        adjustments: [
            '下节课复习时，用"霜"实物图片对比月光，帮助学生建立视觉联想',
            '增加角色扮演环节，让学生通过"举头-低头"的动作体会情感变化',
            '对8名"疑"字读错的学生，安排诗音阁专项跟读训练',
            '下次备课应增加更多文化背景内容，如"见月思乡"传统的其他诗句',
        ],
        commonMistakes: [
            '"疑"字读音错误（yí→yǐ），占比23%',
            '"举头"理解为"举手"，占比15%',
            '默写时"霜"字少一横，占比30%',
        ],
        aiGenerated: true,
        generatedAt: Date.now(),
    },
    status: 'draft',
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 3600000,
    aiGenerated: true,
}

/* ============================================================
 * 春晓 · 孟浩然 · 唐 · 一年级下册
 * 教学时长：1课时（40分钟）
 * 教学依据：人教版一下第1单元"课文"第1课
 * ============================================================ */

const CHUN_XIAO_LESSON_PLAN: LessonPlan = {
    id: 'demo-lp-chunxiao',
    poemId: 'chunxiao',
    poemTitle: '春晓',
    poet: '孟浩然',
    dynasty: '唐',
    gradeLevel: '1-2年级',
    classId: null,
    className: '一年级（1）班',
    teacherName: '王老师',
    title: '春晓 · 一年级下册 · 第1课时',
    lessonCount: 1,
    goals: [
        {
            category: 'knowledge',
            bloomLevel: '记忆',
            description: '学生能正确认读"眠、晓、啼、落"4个生字，会写"春、晓、眠、落"4个生字',
            assessment: '识字卡片抽读 + 田字格默写检测',
        },
        {
            category: 'knowledge',
            bloomLevel: '记忆',
            description: '学生能正确、流利、有感情地朗读并背诵全诗',
            assessment: '诗音阁朗读评分 + 课堂齐背',
        },
        {
            category: 'ability',
            bloomLevel: '理解',
            description: '学生能说出"春眠、啼鸟、风雨声、花落"等词语的意思',
            assessment: '课堂提问 + 释义闯关',
        },
        {
            category: 'ability',
            bloomLevel: '分析',
            description: '学生能体会诗中"喜"与"惜"的情感对比',
            assessment: '课堂讨论 + 情感标注',
        },
        {
            category: 'emotion',
            bloomLevel: '评价',
            description: '学生能感受春天的美好，体会诗人对自然的热爱',
            assessment: '课堂表达 + 配画创作',
        },
        {
            category: 'emotion',
            bloomLevel: '创造',
            description: '学生能仿写"春__不觉__"或为诗句配画',
            assessment: '创造工坊作品评价',
        },
    ],
    keyPoints: [
        '认读4个生字，会写4个生字"春、晓、眠、落"',
        '正确、流利、有感情地朗读背诵全诗',
        '理解"眠、晓、啼、落"等关键词的意思',
    ],
    difficultPoints: [
        '体会"处处闻啼鸟"的生机与"花落知多少"的惋惜之情',
        '理解"知多少"的反问语气',
        '感受诗中"喜"与"惜"交织的复杂情感',
    ],
    preparations: [
        '多媒体课件（含春晨图景、鸟鸣音频、风雨声音频）',
        '生字卡片4张（眠、晓、啼、落）',
        '田字格小黑板（演示"春、晓、眠、落"笔顺）',
        '学生准备：语文课本、田字格本、铅笔',
        '课前准备：教师组织学生完成《春晓》诊断与识字练习，并导入汇总结果',
    ],
    teachingProcess: [
        {
            phase: 'introduction',
            title: '激趣导入：春晨鸟鸣（5分钟）',
            durationMin: 5,
            teacherActivity:
                '1. 播放春晨鸟鸣音频（30秒），提问：你听到了什么？想到了什么季节？\n2. 出示春晨图景，引导观察：春天的早晨是什么样的？\n3. 引出课题：唐代诗人孟浩然在一个春天的早晨醒来，听到了鸟叫，想到了很多，写下了一首优美的诗——《春晓》。\n4. 板书课题，齐读课题。解题："晓"是什么意思？（天亮）"春晓"就是春天的早晨。',
            studentActivity:
                '1. 闭眼倾听鸟鸣音频，自由表达所感\n2. 观察春晨图景，描述看到的画面\n3. 齐读课题"春晓"\n4. 理解"晓"字意思，掌握课题含义',
            designIntent:
                '通过听觉刺激激发兴趣，自然导入春晨情境。解题帮助理解诗题。对应教学目标5（情感·评价）。',
            bloomLevels: ['记忆', '评价'],
            goalIndices: [4],
            aiGenerated: true,
        },
        {
            phase: 'literacy',
            title: '识字正音：扫清障碍（10分钟）',
            durationMin: 10,
            teacherActivity:
                '1. 教师范读，学生指字跟读，注意"眠(mián)、啼(tí)"的读音\n2. 出示4个生字卡片，逐字教学：\n   - 眠(mián)：睡眠（注意不要读成mǐn）\n   - 晓(xiǎo)：天亮、早晨（注意三声）\n   - 啼(tí)：鸣叫（注意不要读成dì）\n   - 落(luò)：掉下（多音字，还有là、lào）\n3. 演示"春、晓、眠、落"4个生字的笔顺（田字格示范）\n4. 组词游戏：眠（睡眠、失眠）、晓（拂晓、知晓）、啼（啼哭、啼叫）、落（落下、落叶）',
            studentActivity:
                '1. 跟读诗文，重点听清"眠、啼"的读音\n2. 借助拼音自由认读4个生字\n3. 观察田字格中4个生字的笔顺，书空练习\n4. 参与组词游戏，每个字至少说2个词\n5. 在田字格本上各写2遍"春、晓、眠、落"',
            designIntent:
                '识字是一年级古诗教学的重点。通过范读、正音、笔顺演示、组词游戏，多通道巩固生字。注意多音字"落"的教学。对应教学目标1（知识·记忆）。',
            bloomLevels: ['记忆', '理解'],
            goalIndices: [0],
            aiGenerated: true,
        },
        {
            phase: 'interpretation',
            title: '逐句释义：理解内容（10分钟）',
            durationMin: 10,
            teacherActivity:
                '1. 逐句讲解（结合课件插图）：\n   - "春眠不觉晓"：春天的睡眠格外香甜，不知不觉就到了天亮\n   - "处处闻啼鸟"：到处都能听到鸟儿清脆的鸣叫声\n   - "夜来风雨声"：回想夜里听到的阵阵风雨声\n   - "花落知多少"：不知院子里的花儿被风雨打落了多少\n2. 提问引导："不觉晓"说明了什么？（春眠的香甜）\n3. 比较："处处闻啼鸟"和"夜来风雨声"分别是什么时候听到的？（早晨/昨夜）\n4. 讲解"知多少"：这是反问语气，意为"不知有多少"，表达惋惜之情。',
            studentActivity:
                '1. 借助插图和讲解，理解每句诗的意思\n2. 同桌互说诗意，互相补充\n3. 思考并回答教师提问\n4. 区分"早晨听到的"和"夜里听到的"\n5. 用自己的话说说全诗大意',
            designIntent:
                '逐句释义帮助学生理解字面意思，关键问题引导深度思考时间和情感的转换。对应教学目标3、4（能力·理解、能力·分析）。',
            bloomLevels: ['理解', '分析'],
            goalIndices: [2, 3],
            aiGenerated: true,
        },
        {
            phase: 'appreciation',
            title: '整体感悟：体会情感（8分钟）',
            durationMin: 8,
            teacherActivity:
                '1. 配乐范读（古筝曲《渔舟唱晚》），学生闭眼想象画面\n2. 引导想象：诗人在这个春晨，心情是怎样的？\n3. 讨论：诗中既有"喜"又有"惜"，找找看哪里是"喜"，哪里是"惜"？（喜：处处闻啼鸟的生机；惜：花落知多少的惋惜）\n4. 拓展：古人写春的诗很多，你还知道哪些？（预设：春眠不觉晓、春色满园关不住）',
            studentActivity:
                '1. 闭眼倾听配乐朗诵，想象诗中画面\n2. 自由表达想象的画面和感受\n3. 参与讨论，找出诗中的"喜"与"惜"\n4. 背诵自己知道的写春天的诗句',
            designIntent:
                '通过配乐和想象，让学生身临其境感受诗境。情感对比分析培养学生的细腻感受力。对应教学目标5（情感·评价）。',
            bloomLevels: ['评价', '创造'],
            goalIndices: [4],
            aiGenerated: true,
        },
        {
            phase: 'extension',
            title: '拓展延伸：文化浸润（4分钟）',
            durationMin: 4,
            teacherActivity:
                '1. 介绍孟浩然：唐代山水田园诗人，与王维并称"王孟"，一生未做官，长期隐居\n2. 简介创作背景：孟浩然隐居鹿门山时，春晨醒来，听鸟鸣、忆风雨、惜落花，写下此诗\n3. 拓展阅读：孟浩然《过故人庄》"待到重阳日，还来就菊花"\n4. 情感升华：诗人既爱春天的生机，又惜落花的凋零，这种"喜惜交织"的情感，体现了中国人对自然的细腻感受。',
            studentActivity:
                '1. 倾听孟浩然简介，了解诗人生平\n2. 跟读拓展诗句\n3. 谈谈自己学完这首诗的感受',
            designIntent:
                '文化语境还原，让学生在文化背景中理解诗歌。立德树人：培养对自然的热爱和细腻感受。对应教学目标5（情感·评价）。',
            bloomLevels: ['评价'],
            goalIndices: [4],
            aiGenerated: true,
        },
        {
            phase: 'practice',
            title: '课堂练习：巩固检测（3分钟）',
            durationMin: 3,
            teacherActivity:
                '1. 齐背全诗（配乐）\n2. 快速检测：\n   - 填空：春眠不觉（  ），处处闻（  ）鸟\n   - 选择："啼"的意思是（A.哭 B.鸣叫 C.叫喊）\n   - 判断："花落知多少"表达的是喜悦之情（×）\n3. 布置作业（见作业部分）',
            studentActivity:
                '1. 配乐齐背全诗\n2. 完成快速检测题\n3. 记录作业要求',
            designIntent:
                '当堂检测学习效果，巩固生字和诗意理解。对应教学目标1、2（知识·记忆）。',
            bloomLevels: ['记忆', '理解'],
            goalIndices: [0, 1],
            aiGenerated: true,
        },
    ],
    boardDesign: {
        title: '春晓 · 板书设计',
        content:
            '┌─────────────────────────────────┐\n│         春晓  孟浩然（唐）        │\n│                                  │\n│  春眠不觉晓 → 处处闻啼鸟  （喜）   │\n│     （春晨）    （生机）           │\n│         ↑                         │\n│  夜来风雨声 → 花落知多少  （惜）   │\n│     （昨夜）    （惋惜）           │\n│                                  │\n│  主题：喜惜交织                    │\n│  情感：爱春惜春                    │\n└─────────────────────────────────┘',
        intent:
            '板书以"喜-惜"为情感轴线，上下对比"春晨所见"与"昨夜所忆"。"处处闻啼鸟"对应"喜"，"花落知多少"对应"惜"。底部点明主题和情感。',
    },
    homework: [
        {
            type: 'dictation',
            description: '在田字格本上默写《春晓》全诗，重点写对"春、晓、眠、落"4个生字',
            estimatedMin: 10,
            bloomLevel: '记忆',
            optional: false,
        },
        {
            type: 'recitation',
            description: '有感情地背诵《春晓》给爸爸妈妈听，注意读出"喜"和"惜"的不同语气',
            estimatedMin: 5,
            bloomLevel: '记忆',
            optional: false,
        },
        {
            type: 'creation',
            description: '为《春晓》配一幅插图，画出诗中的春晨画面（可以画鸟、花、风雨）',
            estimatedMin: 15,
            bloomLevel: '创造',
            optional: false,
        },
        {
            type: 'investigation',
            description: '（选做）观察春天的一个早晨，用一两句话写下你看到的春天',
            estimatedMin: 10,
            bloomLevel: '创造',
            optional: true,
        },
    ],
    reflection: {
        classOverview:
            '本班35名学生的课前诊断 DEMO 汇总显示：记忆层掌握度82分，理解层70分，分析层58分。该数据只用于演示流程，正式使用必须替换为教师核验后的真实班级数据。',
        highlights: [
            '生字"春、晓"2字全班正确率100%',
            '配画作业展现了丰富的想象力，30名学生画出春晨画面',
            '课堂讨论中，15名学生能准确找出"喜"与"惜"的对应诗句',
        ],
        improvements: [
            '"眠"字仍有6名学生读错（读成mǐn），需强化正音',
            '"知多少"的反问语气理解不足，部分学生认为是疑问句',
            '"喜惜交织"的复杂情感，多数学生只能单一理解，未能体会交织',
        ],
        adjustments: [
            '下节课复习时，用对比朗读法，前两句读出喜悦，后两句读出惋惜',
            '增加角色扮演环节，让学生分别扮演"晨起闻鸟"和"夜忆风雨"两个场景',
            '对6名"眠"字读错的学生，安排诗音阁专项跟读训练',
            '下次备课应准备更多反问句的例句，帮助学生理解反问语气',
        ],
        commonMistakes: [
            '"眠"字读音错误（mián→mǐn），占比17%',
            '"知多少"理解为疑问句而非反问句，占比40%',
            '默写时"落"字草字头写成竹字头，占比20%',
        ],
        aiGenerated: true,
        generatedAt: Date.now(),
    },
    status: 'draft',
    createdAt: Date.now() - 172800000,
    updatedAt: Date.now() - 7200000,
    aiGenerated: true,
}

/* ============================================================
 * DEMO 数据索引
 * ============================================================ */

const DEMO_LESSON_PLAN_MAP: Record<string, LessonPlan> = {
    jingyesi: JINGYE_SI_LESSON_PLAN,
    chunxiao: CHUN_XIAO_LESSON_PLAN,
    'jing-ye-si': JINGYE_SI_LESSON_PLAN,
    'chun-xiao': CHUN_XIAO_LESSON_PLAN,
}

const DEMO_LESSON_PLAN_LIST: LessonPlanListItem[] = [
    {
        id: JINGYE_SI_LESSON_PLAN.id,
        poemId: JINGYE_SI_LESSON_PLAN.poemId,
        poemTitle: JINGYE_SI_LESSON_PLAN.poemTitle,
        poet: JINGYE_SI_LESSON_PLAN.poet,
        dynasty: JINGYE_SI_LESSON_PLAN.dynasty,
        gradeLevel: JINGYE_SI_LESSON_PLAN.gradeLevel,
        title: JINGYE_SI_LESSON_PLAN.title,
        lessonCount: JINGYE_SI_LESSON_PLAN.lessonCount,
        status: JINGYE_SI_LESSON_PLAN.status,
        classId: JINGYE_SI_LESSON_PLAN.classId,
        className: JINGYE_SI_LESSON_PLAN.className,
        updatedAt: JINGYE_SI_LESSON_PLAN.updatedAt,
        aiGenerated: JINGYE_SI_LESSON_PLAN.aiGenerated,
    },
    {
        id: CHUN_XIAO_LESSON_PLAN.id,
        poemId: CHUN_XIAO_LESSON_PLAN.poemId,
        poemTitle: CHUN_XIAO_LESSON_PLAN.poemTitle,
        poet: CHUN_XIAO_LESSON_PLAN.poet,
        dynasty: CHUN_XIAO_LESSON_PLAN.dynasty,
        gradeLevel: CHUN_XIAO_LESSON_PLAN.gradeLevel,
        title: CHUN_XIAO_LESSON_PLAN.title,
        lessonCount: CHUN_XIAO_LESSON_PLAN.lessonCount,
        status: CHUN_XIAO_LESSON_PLAN.status,
        classId: CHUN_XIAO_LESSON_PLAN.classId,
        className: CHUN_XIAO_LESSON_PLAN.className,
        updatedAt: CHUN_XIAO_LESSON_PLAN.updatedAt,
        aiGenerated: CHUN_XIAO_LESSON_PLAN.aiGenerated,
    },
]

/**
 * 获取 DEMO 教案
 * 若指定 poemId 不在 DEMO 库中，回退到静夜思（保证评委始终能看到内容）
 */
export function getDemoLessonPlan(poemId: string): LessonPlan {
    return DEMO_LESSON_PLAN_MAP[poemId] ?? JINGYE_SI_LESSON_PLAN
}

/**
 * 获取 DEMO 教案列表
 */
export function getDemoLessonPlanList(): LessonPlanListResponse {
    return {
        lessonPlans: DEMO_LESSON_PLAN_LIST,
        total: DEMO_LESSON_PLAN_LIST.length,
    }
}

/**
 * 生成 DEMO 教案
 *
 * 实现"数据驱动备课"：
 * - 若请求中包含 classId，模拟基于班级诊断数据生成反思建议
 * - 若请求中包含 includeReflection=true，附加教学反思
 * - basis 字段返回生成依据（模拟班级共性薄弱点）
 */
export function generateDemoLessonPlan(req: LessonPlanGenerateRequest): LessonPlanGenerateResponse {
    const basePlan = getDemoLessonPlan(req.poemId)
    // 根据请求参数调整教案
    const adjustedPlan: LessonPlan = {
        ...basePlan,
        id: `demo-lp-${req.poemId}-${Date.now()}`,
        gradeLevel: req.gradeLevel,
        classId: req.classId ?? null,
        lessonCount: req.lessonCount ?? 1,
        title: `${basePlan.poemTitle} · ${req.gradeLevel} · 第1课时`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // 若不包含反思，则移除
        reflection: req.includeReflection ? basePlan.reflection : undefined,
    }

    // 模拟班级共性薄弱点（基于 Bloom 六阶）
    const weakBloomLevels: BloomLevel[] = ['分析', '评价', '创造']

    return {
        lessonPlan: adjustedPlan,
        basis: {
            weakBloomLevels,
            classAvgMastery: 68,
            studentCount: 35,
            dataSource:
                '基于已标注的课前诊断 DEMO 汇总（35名学生）+ 课堂批改数据 + 朗读评分数据综合分析；正式使用须替换为教师核验后的真实数据',
        },
        aiGenerated: true,
    }
}

/**
 * 保存 DEMO 教案
 */
export function saveDemoLessonPlan(plan: LessonPlan): LessonPlanSaveResponse {
    return {
        lessonPlan: {
            ...plan,
            updatedAt: Date.now(),
            status: 'published',
        },
        saved: true,
        aiGenerated: false,
    }
}

/* ============================================================
 * SubTask 25.5：教案模板 DEMO 数据
 *
 * 数据来源（多源交叉验证）：
 * 1. 《义务教育语文课程标准》第一/二/三学段古诗词教学要求
 * 2. 人教版小学语文教师教学用书（1-6 年级）
 * 3. 部编版教材配套教案集
 * 4. Bloom 认知六阶分类法
 *
 * 12 个标准模板覆盖：
 * - 学段 ×3：低年级（1-2）/中年级（3-4）/高年级（5-6）
 * - 课型 ×3：新授课/复习课/拓展课
 * - 难度 ×3：基础/进阶/挑战
 *
 * 缩略图采用项目已审计的无水印 WebP 诗境图
 * ============================================================ */

import type {
    LessonPlanTemplate,
    LessonPlanTemplateListResponse,
    LessonPlanTemplateFilter,
    LessonPlanTemplateSort,
    LessonPlanAIGenerateRequest,
    LessonPlanTemplateGrade,
    LessonPlanTemplateType,
    LessonPlanTemplateDifficulty,
} from './types'

const TEMPLATE_BASE_TIME = 1700000000000 // 2023-11-14T22:13:20Z

/** DEMO 教案模板列表 —— 12 个标准模板 */
export const DEMO_LESSON_PLAN_TEMPLATES: LessonPlanTemplate[] = [
    {
        id: 'tpl-low-new-basic-jingyesi',
        title: '低年级·静夜思·新授课（基础）',
        grade: 'low',
        type: 'new',
        difficulty: 'basic',
        duration: 40,
        description: '面向 1-2 年级学生，通过朗读感悟李白思乡之情。重点识字正音，借助插图理解诗意，配画创作延伸。',
        thumbnail: releasedStarmapImagePath('tongbian-003'),
        sections: [
            { title: '激趣导入', content: '出示月夜图景，提问"夜晚看到月亮会想到什么"，激发学生兴趣，引出诗题。' },
            { title: '识字正音', content: '认读"床、前、明、月、光、疑、举、低"8 个生字，重点关注"疑"的读音和"低"的笔顺。' },
            { title: '逐句释义', content: '借助插图和动作演示，逐句理解诗意，体会"疑是地上霜"的比喻妙处。' },
            { title: '整体感悟', content: '指导有感情朗读，体会诗人由"望月"到"思乡"的情感变化，尝试背诵。' },
            { title: '拓展延伸', content: '结合生活经验，为古诗配画，分享自己的思乡故事。' },
            { title: '作业布置', content: '基础：背诵全诗 + 默写生字；选做：配画创作。' },
        ],
        applicableKeywords: ['思乡', '月亮', '李白', '唐诗', '低年级'],
        createdAt: TEMPLATE_BASE_TIME,
        updatedAt: TEMPLATE_BASE_TIME,
    },
    {
        id: 'tpl-low-new-advanced-chunxiao',
        title: '低年级·春晓·新授课（进阶）',
        grade: 'low',
        type: 'new',
        difficulty: 'advanced',
        duration: 40,
        description: '面向 1-2 年级学生，深化"知诗人/解诗题/明诗意/悟诗情"四步教学法，融入角色扮演与情境体验。',
        thumbnail: releasedStarmapImagePath('tongbian-002'),
        sections: [
            { title: '情境导入', content: '播放春日鸟鸣音频，营造春晨氛围，引导学生想象"春眠不觉晓"的意境。' },
            { title: '识字正音', content: '认读"晓、眠、闻、啼、落、知"等生字，重点正音"眠(mián)"和"啼(tí)"。' },
            { title: '逐句感悟', content: '通过角色扮演（诗人/鸟儿/落花），体会诗歌的视听对比与惜春之情。' },
            { title: '想象拓展', content: '绘画"落花图"，描述自己想象中的春日早晨，培养想象力与表达能力。' },
            { title: '朗读背诵', content: '配乐朗读，尝试当堂背诵，鼓励个性化语调处理。' },
            { title: '作业布置', content: '基础：背诵 + 默写；拓展：续写"春晓之后"的小故事。' },
        ],
        applicableKeywords: ['春天', '孟浩然', '惜春', '唐诗', '低年级'],
        createdAt: TEMPLATE_BASE_TIME - 86400000,
        updatedAt: TEMPLATE_BASE_TIME - 86400000,
    },
    {
        id: 'tpl-middle-new-basic-denguanguilou',
        title: '中年级·登鹳雀楼·新授课（基础）',
        grade: 'middle',
        type: 'new',
        difficulty: 'basic',
        duration: 40,
        description: '面向 3-4 年级学生，理解"白日依山尽，黄河入海流"的壮阔意境，培养登高望远的胸怀。',
        thumbnail: releasedStarmapImagePath('tongbian-005'),
        sections: [
            { title: '解题导入', content: '介绍鹳雀楼地理位置与历史背景，提问"为什么古人喜欢登楼写诗"。' },
            { title: '初读感知', content: '自由朗读，认读生字"鹳、雀、依、尽、欲、穷、目"，整体把握诗意。' },
            { title: '逐句品析', content: '前两句写景（白日/黄河），后两句抒情（更上一层楼），体会景情交融的手法。' },
            { title: '哲理感悟', content: '讨论"欲穷千里目，更上一层楼"的哲理内涵，联系生活实际谈体会。' },
            { title: '拓展延伸', content: '比较阅读王之涣《凉州词》，感受边塞诗的不同风格。' },
            { title: '作业布置', content: '基础：背诵默写；拓展：写一段"登高望远"的感悟。' },
        ],
        applicableKeywords: ['登高', '哲理', '王之涣', '盛唐', '中年级'],
        createdAt: TEMPLATE_BASE_TIME - 2 * 86400000,
        updatedAt: TEMPLATE_BASE_TIME - 2 * 86400000,
    },
    {
        id: 'tpl-middle-review-advanced-wanglushan',
        title: '中年级·望庐山瀑布·复习课（进阶）',
        grade: 'middle',
        type: 'review',
        difficulty: 'advanced',
        duration: 35,
        description: '面向 3-4 年级学生，复习李白《望庐山瀑布》，深化夸张与比喻修辞手法的理解。',
        thumbnail: releasedStarmapImagePath('tongbian-003'),
        sections: [
            { title: '温故知新', content: '回顾李白生平与已学诗篇，引出《望庐山瀑布》，建立知识网络。' },
            { title: '修辞品析', content: '重点品析"飞流直下三千尺，疑是银河落九天"中的夸张与比喻，体会李白豪放风格。' },
            { title: '比较阅读', content: '比较《静夜思》与《望庐山瀑布》中"疑"字的不同用法与意境。' },
            { title: '归纳总结', content: '总结李白诗歌的浪漫主义特征：想象奇崛、夸张大胆、感情奔放。' },
            { title: '应用迁移', content: '仿写一句含有夸张修辞的诗句，描述自然景观。' },
            { title: '作业布置', content: '基础：默写全诗；拓展：搜集 2 首李白其他诗作并分析修辞。' },
        ],
        applicableKeywords: ['李白', '瀑布', '夸张', '比喻', '中年级'],
        createdAt: TEMPLATE_BASE_TIME - 3 * 86400000,
        updatedAt: TEMPLATE_BASE_TIME - 3 * 86400000,
    },
    {
        id: 'tpl-high-extension-challenge-shanshui',
        title: '高年级·山水诗·拓展课（挑战）',
        grade: 'high',
        type: 'extension',
        difficulty: 'challenge',
        duration: 45,
        description: '面向 5-6 年级学生，专题拓展山水田园诗，比较王维、孟浩然诗歌意境，培养文学鉴赏力。',
        thumbnail: releasedStarmapImagePath('tongbian-002'),
        sections: [
            { title: '专题导入', content: '出示王维《山居秋暝》与孟浩然《过故人庄》，引出"山水田园诗派"概念。' },
            { title: '群文阅读', content: '选读 4 首山水田园诗代表作，从意象、语言、情感三个维度进行比较分析。' },
            { title: '意境鉴赏', content: '深度品析"明月松间照，清泉石上流"的诗画一体境界，体会"诗中有画"的艺术。' },
            { title: '流派特征', content: '归纳山水田园诗的共同特征：寄情山水、淡泊名利、语言清新、意境悠远。' },
            { title: '创作实践', content: '模仿山水田园诗风格，写一首描写家乡自然风光的小诗。' },
            { title: '作业布置', content: '基础：背诵《山居秋暝》；挑战：写一篇 300 字的山水诗鉴赏短文。' },
        ],
        applicableKeywords: ['山水', '田园', '王维', '孟浩然', '高年级', '群文阅读'],
        createdAt: TEMPLATE_BASE_TIME - 4 * 86400000,
        updatedAt: TEMPLATE_BASE_TIME - 4 * 86400000,
    },
    {
        id: 'tpl-high-new-basic-wangwei',
        title: '高年级·山居秋暝·新授课（基础）',
        grade: 'high',
        type: 'new',
        difficulty: 'basic',
        duration: 40,
        description: '面向 5-6 年级学生，理解王维《山居秋暝》"诗中有画"的艺术特色，体会归隐情怀。',
        thumbnail: releasedStarmapImagePath('tongbian-003'),
        sections: [
            { title: '知人论世', content: '介绍王维生平与"诗佛"称号，理解其"晚年惟好静，万事不关心"的心境。' },
            { title: '初读感知', content: '朗读全诗，把握"首联-颔联-颈联-尾联"的律诗结构。' },
            { title: '诗画品析', content: '重点品析"明月松间照，清泉石上流"的动静结合与色彩对比。' },
            { title: '情感体悟', content: '理解尾联"随意春芳歇，王孙自可留"的归隐情怀与反用《楚辞》典故。' },
            { title: '背诵积累', content: '当堂背诵，鼓励个性化朗读节奏处理。' },
            { title: '作业布置', content: '基础：默写全诗；拓展：搜集王维其他山水诗一首。' },
        ],
        applicableKeywords: ['王维', '山水', '律诗', '隐逸', '高年级'],
        createdAt: TEMPLATE_BASE_TIME - 5 * 86400000,
        updatedAt: TEMPLATE_BASE_TIME - 5 * 86400000,
    },
    {
        id: 'tpl-low-review-basic-jingyesi',
        title: '低年级·静夜思·复习课（基础）',
        grade: 'low',
        type: 'review',
        difficulty: 'basic',
        duration: 30,
        description: '面向 1-2 年级学生，复习《静夜思》生字与朗读，通过游戏化检测学习效果。',
        thumbnail: releasedStarmapImagePath('tongbian-003'),
        sections: [
            { title: '生字复习', content: '通过"摘月亮"游戏复习 8 个生字，重点关注易错字"疑"和"低"。' },
            { title: '朗读巩固', content: '配乐朗读，分组比赛，评选"最佳朗读者"。' },
            { title: '诗意回顾', content: '看图说诗意，巩固对"疑/举/低"等关键词的理解。' },
            { title: '检测反馈', content: '随堂小测：默写生字 + 选择题检测诗意理解，即时反馈。' },
            { title: '查漏补缺', content: '针对错误较多的字词进行针对性强化训练。' },
            { title: '作业布置', content: '基础：改正错字 3 遍；拓展：与家人分享这首诗。' },
        ],
        applicableKeywords: ['静夜思', '复习', '游戏化', '低年级'],
        createdAt: TEMPLATE_BASE_TIME - 6 * 86400000,
        updatedAt: TEMPLATE_BASE_TIME - 6 * 86400000,
    },
    {
        id: 'tpl-middle-extension-advance-song',
        title: '中年级·宋词启蒙·拓展课（进阶）',
        grade: 'middle',
        type: 'extension',
        difficulty: 'advanced',
        duration: 45,
        description: '面向 3-4 年级学生，拓展接触宋词，比较唐诗与宋词的形式差异，启蒙词学兴趣。',
        thumbnail: releasedStarmapImagePath('tongbian-002'),
        sections: [
            { title: '形式比较', content: '比较《静夜思》（五言绝句）与《水调歌头》（词）的形式差异，引出"词"的概念。' },
            { title: '名篇欣赏', content: '欣赏苏轼《水调歌头·明月几时有》片段，感受词的婉转节奏。' },
            { title: '词牌认知', content: '认识常见词牌（水调歌头/如梦令/渔歌子），了解词牌与内容的关系。' },
            { title: '意境感悟', content: '通过吟唱方式体验词的韵律美，比较"诗吟"与"词唱"的不同。' },
            { title: '创意表达', content: '尝试用自己喜欢的曲调吟唱一首学过的古诗。' },
            { title: '作业布置', content: '基础：背诵《渔歌子》；拓展：搜集一首喜欢的宋词。' },
        ],
        applicableKeywords: ['宋词', '苏轼', '词牌', '中年级', '拓展'],
        createdAt: TEMPLATE_BASE_TIME - 7 * 86400000,
        updatedAt: TEMPLATE_BASE_TIME - 7 * 86400000,
    },
    {
        id: 'tpl-high-new-challenge-libai',
        title: '高年级·将进酒·新授课（挑战）',
        grade: 'high',
        type: 'new',
        difficulty: 'challenge',
        duration: 50,
        description: '面向 5-6 年级学有余力学生，挑战李白《将进酒》节选，深度理解浪漫主义诗歌巅峰之作。',
        thumbnail: releasedStarmapImagePath('tongbian-005'),
        sections: [
            { title: '背景导入', content: '介绍李白创作《将进酒》的历史背景与人生境遇，理解"天生我材必有用"的豪情。' },
            { title: '古体诗认知', content: '认知古体诗（乐府诗）与近体诗的差异，把握《将进酒》的句式自由特点。' },
            { title: '情感脉络', content: '梳理"悲-欢-愤-狂"的情感变化脉络，体会李白复杂的内心世界。' },
            { title: '名句品析', content: '深度品析"天生我材必有用，千金散尽还复来"的自信与"钟鼓馔玉不足贵"的愤激。' },
            { title: '比较阅读', content: '比较《将进酒》与《静夜思》中李白的两种截然不同的情感表达。' },
            { title: '作业布置', content: '基础：背诵节选；挑战：写一段 200 字的"我眼中的李白"。' },
        ],
        applicableKeywords: ['李白', '将进酒', '浪漫主义', '高年级', '挑战'],
        createdAt: TEMPLATE_BASE_TIME - 8 * 86400000,
        updatedAt: TEMPLATE_BASE_TIME - 8 * 86400000,
    },
    {
        id: 'tpl-low-extension-basic-minyue',
        title: '低年级·民谣童谣·拓展课（基础）',
        grade: 'low',
        type: 'extension',
        difficulty: 'basic',
        duration: 35,
        description: '面向 1-2 年级学生，拓展接触民谣童谣，培养语感与节奏感，激发诗歌学习兴趣。',
        thumbnail: releasedStarmapImagePath('tongbian-002'),
        sections: [
            { title: '童谣导入', content: '朗诵《摇啊摇，摇到外婆桥》等熟悉童谣，激发兴趣。' },
            { title: '形式认知', content: '比较童谣与古诗的不同（口语化/节奏感/押韵方式）。' },
            { title: '节奏体验', content: '通过拍手、踏脚等方式体验童谣的节奏感。' },
            { title: '创作尝试', content: '模仿童谣形式，创作一首关于"上学"的小童谣。' },
            { title: '分享展示', content: '小组展示创作成果，互相点评鼓励。' },
            { title: '作业布置', content: '基础：把创作的童谣读给家人听；拓展：搜集家乡方言童谣。' },
        ],
        applicableKeywords: ['童谣', '民谣', '节奏', '低年级', '创作'],
        createdAt: TEMPLATE_BASE_TIME - 9 * 86400000,
        updatedAt: TEMPLATE_BASE_TIME - 9 * 86400000,
    },
    {
        id: 'tpl-middle-new-challenge-dufu',
        title: '中年级·春望·新授课（挑战）',
        grade: 'middle',
        type: 'new',
        difficulty: 'challenge',
        duration: 45,
        description: '面向 3-4 年级学有余力学生，挑战杜甫《春望》，初步接触现实主义诗歌与家国情怀。',
        thumbnail: releasedStarmapImagePath('tongbian-003'),
        sections: [
            { title: '知人论世', content: '介绍杜甫"诗圣"称号与安史之乱背景，理解"国破山河在"的时代悲哀。' },
            { title: '初读感知', content: '朗读全诗，把握五言律诗的节奏与对仗。' },
            { title: '炼字品析', content: '重点品析"破/深/感/恨"等字的炼字之妙，体会杜甫沉郁顿挫的风格。' },
            { title: '情感体悟', content: '理解"烽火连三月，家书抵万金"中思家忧国的复杂情感。' },
            { title: '比较阅读', content: '比较杜甫《春望》与李白《静夜思》中"思"的不同内涵。' },
            { title: '作业布置', content: '基础：背诵全诗；挑战：用 200 字描述"国破山河在"的画面。' },
        ],
        applicableKeywords: ['杜甫', '春望', '现实主义', '家国', '中年级'],
        createdAt: TEMPLATE_BASE_TIME - 10 * 86400000,
        updatedAt: TEMPLATE_BASE_TIME - 10 * 86400000,
    },
    {
        id: 'tpl-high-review-challenge-qinghuai',
        title: '高年级·清怀古诗·复习课（挑战）',
        grade: 'high',
        type: 'review',
        difficulty: 'challenge',
        duration: 50,
        description: '面向 5-6 年级学生，专题复习怀古咏史诗，比较唐宋怀古诗的不同风格，深化文学史认知。',
        thumbnail: releasedStarmapImagePath('tongbian-005'),
        sections: [
            { title: '专题回顾', content: '回顾已学怀古诗：《登鹳雀楼》《乌衣巷》《赤壁》等，建立怀古诗知识图谱。' },
            { title: '特征归纳', content: '归纳怀古诗的四大特征：借古讽今/借古喻今/感慨兴衰/怀古伤己。' },
            { title: '群文比较', content: '比较刘禹锡《乌衣巷》与杜牧《赤壁》的怀古角度与表达技巧。' },
            { title: '艺术手法', content: '重点复习"用典/对比/借景抒情"三种怀古诗常用手法。' },
            { title: '综合应用', content: '完成怀古诗鉴赏题（诗歌 + 选择题 + 简答题），检测学习成果。' },
            { title: '作业布置', content: '基础：默写 3 首怀古诗；挑战：写一篇 400 字怀古诗鉴赏短文。' },
        ],
        applicableKeywords: ['怀古', '咏史', '刘禹锡', '杜牧', '高年级', '群文阅读'],
        createdAt: TEMPLATE_BASE_TIME - 11 * 86400000,
        updatedAt: TEMPLATE_BASE_TIME - 11 * 86400000,
    },
]

/**
 * 获取 DEMO 教案模板列表（支持筛选 + 排序）
 */
export function getDemoLessonPlanTemplates(
    filter?: LessonPlanTemplateFilter,
    sort: LessonPlanTemplateSort = 'newest',
): LessonPlanTemplateListResponse {
    let list = [...DEMO_LESSON_PLAN_TEMPLATES]

    // 筛选
    if (filter?.keyword) {
        const q = filter.keyword.trim().toLowerCase()
        if (q) {
            list = list.filter(
                (t) =>
                    t.title.toLowerCase().includes(q) ||
                    t.description.toLowerCase().includes(q) ||
                    (t.applicableKeywords ?? []).some((k) => k.toLowerCase().includes(q)),
            )
        }
    }
    if (filter?.grade) list = list.filter((t) => t.grade === filter.grade)
    if (filter?.type) list = list.filter((t) => t.type === filter.type)
    if (filter?.difficulty) list = list.filter((t) => t.difficulty === filter.difficulty)

    // 排序
    switch (sort) {
        case 'newest':
            list.sort((a, b) => b.createdAt - a.createdAt)
            break
        case 'popular':
            // DEMO：按 updatedAt 倒序模拟"热度"
            list.sort((a, b) => b.updatedAt - a.updatedAt)
            break
        case 'duration-asc':
            list.sort((a, b) => a.duration - b.duration)
            break
        case 'duration-desc':
            list.sort((a, b) => b.duration - a.duration)
            break
    }

    return { templates: list, total: list.length }
}

/**
 * 根据 ID 获取 DEMO 教案模板
 */
export function getDemoLessonPlanTemplate(id: string): LessonPlanTemplate | null {
    return DEMO_LESSON_PLAN_TEMPLATES.find((t) => t.id === id) ?? null
}

/**
 * 模拟 AI 流式生成教案（SubTask 25.6）
 *
 * 实现：
 * - 基于模板 + 请求参数生成 deepseek-v4-pro 风格的教案文本
 * - 流式 chunk 模拟逐字输出（每 30ms 一个 chunk）
 * - 完成后返回 LessonPlan 对象
 *
 * @param req AI 生成请求
 * @param callbacks 流式回调
 * @returns 流式控制器
 */
export function streamDemoAIGenerateLessonPlan(
    req: LessonPlanAIGenerateRequest,
    callbacks: {
        onChunk?: (chunk: { type: 'chunk'; content: string } | { type: 'reasoning'; content: string } | { type: 'done'; lessonPlan: LessonPlan } | { type: 'aborted' }) => void
        onError?: (err: Error) => void
    },
): { streaming: boolean; abort: () => void } {
    const controller = { streaming: true, abort: () => { aborted = true } }
    let aborted = false

    void (async () => {
        try {
            // 模拟思考过程
            const reasoningText = `正在基于 deepseek-v4-pro 思考模式生成教案：
- 学段：${req.grade}
- 课型：${req.type}
- 时长：${req.duration} 分钟
${req.poemId ? `- 诗篇：${req.poemId}` : req.topic ? `- 主题：${req.topic}` : ''}
${req.templateId ? `- 套用模板：${req.templateId}` : ''}
${req.keyPoints && req.keyPoints.length > 0 ? `- 重点知识点：${req.keyPoints.join('、')}` : ''}

分析教学要素，构建三维目标，编排教学过程...`

            // 逐字流式输出思考过程（每 25ms 一个字符）
            for (const ch of reasoningText) {
                if (aborted) {
                    callbacks.onChunk?.({ type: 'aborted' })
                    controller.streaming = false
                    return
                }
                callbacks.onChunk?.({ type: 'reasoning', content: ch })
                await new Promise((r) => setTimeout(r, 25))
            }

            // 构造完整教案（复用 DEMO 静夜思教案，并基于请求参数调整）
            const basePlan = getDemoLessonPlan(req.poemId ?? 'jingyesi')
            const gradeMap: Record<LessonPlanTemplateGrade, CreationGradeLevel> = {
                low: '1-2年级',
                middle: '3-4年级',
                high: '5-6年级',
            }
            const lessonPlan: LessonPlan = {
                ...basePlan,
                id: `demo-ai-${Date.now()}`,
                gradeLevel: gradeMap[req.grade],
                lessonCount: 1,
                title: `${basePlan.poemTitle} · ${gradeMap[req.grade]} · AI 生成`,
                aiGenerated: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }

            // 模拟逐字流式输出教案内容
            const contentText = `# ${lessonPlan.title}

## 教学目标
${lessonPlan.goals.map((g, i) => `${i + 1}. [${g.bloomLevel}] ${g.description}`).join('\n')}

## 教学重点
${lessonPlan.keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')}

## 教学过程
${lessonPlan.teachingProcess.map((p, i) => `### ${i + 1}. ${p.title}（${p.durationMin} 分钟）
教师活动：${p.teacherActivity}
学生活动：${p.studentActivity}
设计意图：${p.designIntent}`).join('\n\n')}

## 作业布置
${lessonPlan.homework.map((h, i) => `${i + 1}. ${h.description}`).join('\n')}
`

            for (const ch of contentText) {
                if (aborted) {
                    callbacks.onChunk?.({ type: 'aborted' })
                    controller.streaming = false
                    return
                }
                callbacks.onChunk?.({ type: 'chunk', content: ch })
                await new Promise((r) => setTimeout(r, 20))
            }

            // 完成
            callbacks.onChunk?.({ type: 'done', lessonPlan })
            controller.streaming = false
        } catch (err) {
            controller.streaming = false
            callbacks.onError?.(err as Error)
        }
    })()

    return controller
}

/** 类型守卫：避免 unused import 报错 */
export type {
    LessonPlanTemplateGrade,
    LessonPlanTemplateType,
    LessonPlanTemplateDifficulty,
}
