/**
 * 教学调整建议 DEMO 数据（Phase 4.2 —— 教师教学流程闭环）
 *
 * 设计目的：
 * - 后端未启动时提供完整可演示的教学建议数据
 * - 基于诊断数据（六阶分布 + 暗物质）+ 错题本数据生成针对性建议
 * - 回应"我是老师，这篇诗我应该如何教"的核心追问
 *
 * 数据来源模拟：
 * - 班级六阶分布：记忆 78 / 理解 72 / 应用 65 / 分析 48 / 评价 42 / 创造 38
 * - 薄弱点：分析层级"对比意象"薄弱、评价层级"情感态度"薄弱
 * - 错题本：今日 5 道待复习，分析层级错误最多
 *
 * 7 条建议覆盖 5 种类型 × 3 种优先级
 */

import type { TeachingSuggestion, TeachingSuggestionResponse } from './types'

/** DEMO 班级 ID */
const DEMO_CLASS_ID = 'class-001'

/** 7 条教学建议 DEMO 数据 */
const ALL_SUGGESTIONS: TeachingSuggestion[] = [
    {
        id: 'sug-001',
        type: 'weakness',
        title: '分析层级集体薄弱：意象对比能力不足',
        description: '班级在"分析"层级均分仅 48 分（达标线 60），《静夜思》与《春晓》的意象对比题错误率达 62%。学生能识别单个意象，但无法建立意象间的关联结构。',
        priority: 'high',
        bloomLevel: '分析',
        poemId: 'poem-jingyesi',
        poemTitle: '静夜思',
        affectedStudentCount: 18,
        evidence: '六阶分布分析=48 · 薄弱点"对比意象"出现 12 次 · 错题本分析层级 5 道',
        suggestedAction: '在下次课堂增加"月亮与霜"意象对比讲解环节，使用维恩图工具可视化意象关联，布置 2 道意象对比练习题',
        generatedAt: Date.now() - 1000 * 60 * 30,
        aiGenerated: true,
    },
    {
        id: 'sug-002',
        type: 'weakness',
        title: '评价层级情感体悟不足',
        description: '"评价"层级均分 42，学生在"诗人情感态度判断"类题目上错误率 55%。多将思乡之情误判为写景之情，缺乏情感词汇库。',
        priority: 'high',
        bloomLevel: '评价',
        poemId: 'poem-jingyesi',
        poemTitle: '静夜思',
        affectedStudentCount: 15,
        evidence: '六阶分布评价=42 · 薄弱点"情感态度"出现 9 次',
        suggestedAction: '引入"情感词汇卡"教具，让学生用"思乡、孤寂、思念"等词标注诗句；课后完成 1 篇 50 字情感批注',
        generatedAt: Date.now() - 1000 * 60 * 25,
        aiGenerated: true,
    },
    {
        id: 'sug-003',
        type: 'method',
        title: '记忆→理解跨度不足，建议增加复述环节',
        description: '记忆层级 78 分达标，但理解层级骤降至 72。学生在"用自己的话复述诗意"时存在困难，机械记忆未转化为语义理解。',
        priority: 'medium',
        bloomLevel: '理解',
        affectedStudentCount: 10,
        evidence: '记忆=78 → 理解=72，梯度差 6 分（健康梯度应≤3 分）',
        suggestedAction: '课堂增加"同桌互讲"环节：学生 A 用白话讲诗意，学生 B 补充，教师巡回点拨，每首诗 3 分钟',
        generatedAt: Date.now() - 1000 * 60 * 20,
        aiGenerated: true,
    },
    {
        id: 'sug-004',
        type: 'differentiate',
        title: '5 名学生创造层级突出，建议分层拓展',
        description: '学生 H03/H07/H11/H15/H18 在"创造"层级得分≥85，显著高于班级均值 38。可提供进阶创作任务避免学习饥饿。',
        priority: 'medium',
        bloomLevel: '创造',
        studentIds: ['stu-h03', 'stu-h07', 'stu-h11', 'stu-h15', 'stu-h18'],
        affectedStudentCount: 5,
        evidence: '创造层级 5 人≥85，班级均值 38，标准差 22（分化严重）',
        suggestedAction: '为这 5 名学生布置"改写《静夜思》为现代诗"的拓展任务，并提供《唐诗三百首》进阶阅读单',
        generatedAt: Date.now() - 1000 * 60 * 15,
        aiGenerated: true,
    },
    {
        id: 'sug-005',
        type: 'material',
        title: '补充"月"意象文化背景素材',
        description: '《静夜思》中"月"是核心意象，但学生对"月"在古诗中的文化内涵（思乡、团圆、高洁）了解不足，影响深层鉴赏。',
        priority: 'medium',
        poemId: 'poem-jingyesi',
        poemTitle: '静夜思',
        affectedStudentCount: 22,
        evidence: '错题本中 4/5 道静夜思错题与"月"意象理解相关',
        suggestedAction: '课前准备"古诗中的月"文化卡片（含 5 首含月名句对比），课堂用 5 分钟导入',
        generatedAt: Date.now() - 1000 * 60 * 10,
        aiGenerated: true,
    },
    {
        id: 'sug-006',
        type: 'progress',
        title: '今日 5 道错题待复习，建议课前 5 分钟复习',
        description: '错题本显示今日有 5 道错题到期需复习（静夜思 3 道 + 春晓 2 道），其中分析层级 3 道。复习后预计掌握度提升 8-12%。',
        priority: 'low',
        affectedStudentCount: 12,
        evidence: '错题本今日到期 5 道，分析层级占 60%，平均易度因子 2.3',
        suggestedAction: '明早课前用 5 分钟集体复习这 5 道错题，重点关注分析层级的 3 道',
        generatedAt: Date.now() - 1000 * 60 * 5,
        aiGenerated: true,
    },
    {
        id: 'sug-007',
        type: 'method',
        title: '应用层级稳定，可挑战创造层级',
        description: '应用层级均分 65 已达基础线，建议在下周课堂引入"仿写诗句"创造层级任务，逐步提升班级创造能力。',
        priority: 'low',
        bloomLevel: '创造',
        affectedStudentCount: 20,
        evidence: '应用=65（达标）· 创造=38（待提升），梯度差 27 分有提升空间',
        suggestedAction: '下周课堂最后 10 分钟开展"仿写一句思乡诗"小活动，不评分只展示，培养创作信心',
        generatedAt: Date.now() - 1000 * 60 * 2,
        aiGenerated: true,
    },
]

/**
 * 获取 DEMO 教学建议列表
 */
export function getDemoTeachingSuggestions(): TeachingSuggestionResponse {
    return {
        classId: DEMO_CLASS_ID,
        suggestions: ALL_SUGGESTIONS,
        generatedAt: Date.now(),
        dataSummary: {
            classMasteryAvg: 57,
            darkMatterCount: 21,
            weakestBloomLevel: '评价',
            dueTodayCount: 5,
        },
        aiGenerated: true,
    }
}
