/**
 * 认知暗物质检测器
 *
 * "认知暗物质"是本系统的核心教学诊断概念：指班级或学生在知识图谱上
 * 表现出的、跨诗共性且难以从单诗成绩察觉的隐性薄弱模式。
 *
 * 算法三层：
 * 1. detectClassDarkMatter —— 班级共性薄弱点检测（跨诗聚类）
 * 2. detectStudentGaps —— 学生个体知识漏洞定位（关联弱点链）
 * 3. generateDarkMatterReport —— 输出可解释诊断报告（含处方）
 *
 * 可解释性保证：每个暗物质必须给出 rootCause（根因）与 prescription（靶向处方），
 * 供诗心 Agent 认知诊断子代理调用。
 *
 * 数据来源：
 * - SQLite mastery 表（掌握度原始数据）
 * - KnowledgeGraphService（诗与诗的关联关系，含 confidence 标注）
 * - seed-data.ts（古诗元信息，用于跨诗标签聚合）
 *
 * confidence 兼容策略（spec A2）：
 * - KnowledgeGraphService.findRelatedPoems 返回的 RelatedPoem 自 v3.x 起携带
 *   confidence 字段（移植自 Graphify 的 EXTRACTED|INFERRED|AMBIGUOUS）。
 * - 本检测器容忍该字段缺失：缺失时按 'INFERRED' 处理，与 KG 服务默认一致。
 * - 仅当 confidence === 'AMBIGUOUS'（模糊存疑）时，在 relatedWeaknesses 字符串
 *   追加 [存疑] 标记；EXTRACTED/INFERRED 不改变输出格式，保证行为零回归。
 * - 当前 findRelatedPoems 仅返回 SHARES_IMAGE/SIMILAR_THEME/BORROWS_RHETORIC
 *   三种 INFERRED 类边，故实际不会触发 [存疑] 标记，留作未来扩展。
 */

import type { KnowledgeGraphService } from './knowledge-graph-service.js'
import { SEED_POEMS, type SeedPoem } from './seed-data.js'
import { db } from '../../db/index.js'
import { kgLogger } from '../../lib/logger/index.js'

const log = kgLogger()

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 暗物质条目（单条诊断结果） */
export interface DarkMatter {
    id: string
    classId: string
    /** 模式描述，如"含'月'意象的诗在'分析'层卡顿" */
    pattern: string
    bloomLevel: string
    affectedPoems: Array<{ poemId: string; title: string }>
    affectedStudents: string[]
    /** 0-1，受影响学生占全班比例 */
    affectedRatio: number
    /** 推测的根因（用于教师理解与 Agent 引用） */
    rootCause: string
    /** 靶向处方（具体可执行的教学干预建议） */
    prescription: string
    detectedAt: number
}

/** 班级暗物质检测选项 */
export interface DetectOptions {
    /** 最小受影响比例，默认 0.4（至少 40% 学生卡顿才算共性） */
    minAffectedRatio?: number
    /** 限定检测的布鲁姆阶层，默认全部六阶 */
    bloomLevels?: string[]
}

/** 学生个体知识漏洞 */
export interface StudentGap {
    poemId: string
    bloomLevel: string
    /** 相关的其他诗/意象/主题（用于说明漏洞的"辐射范围"） */
    relatedWeaknesses: string[]
    /** 建议学习路径（图谱节点 ID 序列，从易到难） */
    suggestedPath: string[]
}

/** 暗物质报告 */
export interface DarkMatterReport {
    classId: string
    totalDarkMatter: number
    byBloomLevel: Record<string, number>
    byTheme: Record<string, number>
    byImage: Record<string, number>
    topPatterns: Array<{
        pattern: string
        affectedStudents: number
        affectedPoems: string[]
        prescription: string
    }>
}

// ─────────────────────────────────────────────────────────────
// 常量与处方模板
// ─────────────────────────────────────────────────────────────

/** 布鲁姆六阶 */
const BLOOM_LEVELS: readonly string[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 卡顿阈值（班级均值低于此值视为薄弱） */
const WEAK_THRESHOLD = 60

/** 单模式至少影响几首诗才算"跨诗共性" */
const MIN_AFFECTED_POEMS = 2

/**
 * 处方模板库（按模式维度分类）
 * 每个模板接收具体参数，生成 rootCause 与 prescription
 */
const PRESCRIPTION_TEMPLATES = {
    image: {
        rootCause: (image: string, bloom: string) =>
            `学生对"${image}"意象的文化内涵理解停留在表层，难以在"${bloom}"层进行多角度分析。` +
            `常见表现为：能识别意象但无法关联其多重文化含义（如"月"既指思乡又指团圆），` +
            `导致"${bloom}"层提问时仅能复述字面义。`,
        prescription: (image: string, poems: string[]) =>
            `建议开展"${image}意象群文阅读"专题，对比《${poems.join('》《')}》中` +
            `"${image}"的不同情感寄托，引导学生绘制"意象—情感"映射图，` +
            `并完成"${image}"意象的迁移写作任务。`,
    },
    theme: {
        rootCause: (theme: string, bloom: string) =>
            `学生对"${theme}"主题的情感把握不够深入，在"${bloom}"层缺乏深度共鸣与批判性思考。` +
            `常见表现为：能复述诗意但无法联系自身或社会现实，"${bloom}"层作答空洞。`,
        prescription: (theme: string, poems: string[]) =>
            `建议设置"${theme}主题情境体验"活动，联系学生生活实际深化理解，` +
            `并以《${poems.join('》《')}》为载体开展群文比较阅读，` +
            `提炼"${theme}"主题在不同时代、不同诗人笔下的情感层次。`,
    },
    rhetoric: {
        rootCause: (rhetoric: string, bloom: string) =>
            `学生能识别"${rhetoric}"修辞但无法在"${bloom}"层灵活运用或赏析其表达效果。` +
            `常见表现为：判断题正确率高但创作题/赏析题得分低，` +
            `对"${rhetoric}"的"为何用"与"如何用"缺乏迁移能力。`,
        prescription: (rhetoric: string, poems: string[]) =>
            `建议开展"${rhetoric}修辞仿写"专项训练，` +
            `从《${poems.join('》《')}》中抽取"${rhetoric}"典型句进行拆解与重组，` +
            `并设置从"识别→赏析→仿写→创造"的阶梯练习。`,
    },
} as const

// ─────────────────────────────────────────────────────────────
// DarkMatterDetector 主类
// ─────────────────────────────────────────────────────────────

export class DarkMatterDetector {
    /** 种子诗索引，避免反复遍历 */
    private readonly poemIndex: Map<string, SeedPoem>

    constructor(private readonly kgService: KnowledgeGraphService) {
        this.poemIndex = new Map(SEED_POEMS.map((p) => [p.id, p]))
    }

    /**
     * 1. 检测班级共性薄弱点（认知暗物质）
     *
     * 算法：
     * 1) 查询 mastery 表，找出班级所有学生在每首诗每阶的均值
     * 2) 筛选均值 < 60 的 (poemId, bloomLevel) 组合
     * 3) 对每个薄弱点，查询知识图谱邻居（同意象/同主题/同修辞的诗）
     * 4) 检查邻居诗是否也有相同 bloomLevel 的薄弱
     * 5) 如果有，识别为"暗物质模式"（如"所有含'拟人'的诗都在分析层卡顿"）
     * 6) 返回暗物质列表
     *
     * @param classId 班级 ID
     * @param options 检测选项（最小受影响比例、限定阶层）
     */
    async detectClassDarkMatter(
        classId: string,
        options?: DetectOptions,
    ): Promise<DarkMatter[]> {
        const minAffectedRatio = options?.minAffectedRatio ?? 0.4
        const targetLevels = options?.bloomLevels ?? Array.from(BLOOM_LEVELS)

        // 1. 查询班级掌握度聚合
        const classData = this.queryClassMastery(classId)
        if (classData.students.size === 0) {
            return []
        }
        const totalStudents = classData.students.size

        // 2. 筛选薄弱 (poemId, bloomLevel)
        const weakPairs: Array<{ poemId: string; bloomLevel: string; avg: number }> = []
        for (const [key, avg] of classData.averages.entries()) {
            const sepIdx = key.indexOf('||')
            if (sepIdx < 0) continue
            const poemId = key.slice(0, sepIdx)
            const bloomLevel = key.slice(sepIdx + 2)
            if (!targetLevels.includes(bloomLevel)) continue
            if (avg < WEAK_THRESHOLD) {
                weakPairs.push({ poemId, bloomLevel, avg })
            }
        }

        if (weakPairs.length === 0) {
            return []
        }

        // 3. 按 bloomLevel 分组，找出共性的意象/主题/修辞
        const darkMatter: DarkMatter[] = []
        const levelsWeakPoems = new Map<string, string[]>()

        for (const level of targetLevels) {
            const weakPoemIds = weakPairs
                .filter((p) => p.bloomLevel === level)
                .map((p) => p.poemId)
            if (weakPoemIds.length === 0) continue
            levelsWeakPoems.set(level, weakPoemIds)
        }

        // 4. 对每个 bloomLevel，提取共性的意象/主题/修辞
        for (const [level, weakPoemIds] of levelsWeakPoems.entries()) {
            if (weakPoemIds.length < MIN_AFFECTED_POEMS) continue

            // 收集这些薄弱诗的标签（意象/主题/修辞）
            const imageCount = new Map<string, string[]>() // image -> poemIds
            const themeCount = new Map<string, string[]>()
            const rhetoricCount = new Map<string, string[]>()

            for (const poemId of weakPoemIds) {
                const seedPoem = this.poemIndex.get(poemId)
                if (!seedPoem) continue
                for (const img of seedPoem.images) {
                    const arr = imageCount.get(img) ?? []
                    arr.push(poemId)
                    imageCount.set(img, arr)
                }
                for (const theme of seedPoem.themes) {
                    const arr = themeCount.get(theme) ?? []
                    arr.push(poemId)
                    themeCount.set(theme, arr)
                }
                for (const rhetoric of seedPoem.rhetoric) {
                    const arr = rhetoricCount.get(rhetoric) ?? []
                    arr.push(poemId)
                    rhetoricCount.set(rhetoric, arr)
                }
            }

            // 5. 检测三种维度的暗物质
            this.collectDarkMatterPatterns(
                darkMatter,
                classId,
                level,
                'image',
                imageCount,
                classData,
                totalStudents,
                minAffectedRatio,
            )
            this.collectDarkMatterPatterns(
                darkMatter,
                classId,
                level,
                'theme',
                themeCount,
                classData,
                totalStudents,
                minAffectedRatio,
            )
            this.collectDarkMatterPatterns(
                darkMatter,
                classId,
                level,
                'rhetoric',
                rhetoricCount,
                classData,
                totalStudents,
                minAffectedRatio,
            )
        }

        // 6. 按受影响学生数降序排序
        darkMatter.sort((a, b) => b.affectedStudents.length - a.affectedStudents.length)

        return darkMatter
    }

    /**
     * 2. 检测学生个体知识漏洞
     *
     * 对学生每个薄弱点，沿图谱查找关联诗是否也薄弱，
     * 形成"漏洞辐射网络"，并给出从易到难的学习路径。
     */
    async detectStudentGaps(studentId: string): Promise<StudentGap[]> {
        // 1. 查询学生薄弱点
        const weakRecords = this.queryStudentWeaknesses(studentId)
        if (weakRecords.length === 0) {
            return []
        }

        // 2. 按诗分组
        const weakByPoem = new Map<string, string[]>() // poemId -> bloomLevels
        for (const r of weakRecords) {
            const arr = weakByPoem.get(r.poemId) ?? []
            arr.push(r.bloomLevel)
            weakByPoem.set(r.poemId, arr)
        }

        const gaps: StudentGap[] = []

        // 3. 对每个薄弱诗，查找图谱关联诗
        for (const [poemId, bloomLevels] of weakByPoem.entries()) {
            const relatedPoems = await this.kgService.findRelatedPoems(poemId, 5)

            // 检查关联诗是否也是该学生的弱点
            const relatedWeaknesses: string[] = []

            for (const related of relatedPoems) {
                const relatedId = related.poem.id
                if (weakByPoem.has(relatedId)) {
                    // 兼容 confidence 字段（移植自 Graphify 的 EXTRACTED|INFERRED|AMBIGUOUS）：
                    // 容忍缺失，缺失时按 INFERRED 处理（与 KnowledgeGraphService 默认一致）。
                    // 仅 AMBIGUOUS（模糊存疑，如师承）时追加 [存疑] 标记；
                    // EXTRACTED/INFERRED 不显示后缀，保持既有输出格式（零回归）。
                    // 注意：findRelatedPoems 当前仅返回 INFERRED 类边，故 suffix 恒为空。
                    const confidence = related.confidence ?? 'INFERRED'
                    const suffix = confidence === 'AMBIGUOUS' ? ' [存疑]' : ''
                    relatedWeaknesses.push(
                        `${related.poem.title}（${related.relationType}，强度 ${related.strength.toFixed(2)}）${suffix}`,
                    )
                }
            }

            // 4. 构建建议学习路径：从易到难的相关诗
            const seedPoem = this.poemIndex.get(poemId)
            const currentDifficulty = seedPoem?.difficulty ?? 3
            const easierRelated = relatedPoems
                .filter((r) => (r.poem.difficulty ?? 3) <= currentDifficulty)
                .sort((a, b) => (a.poem.difficulty ?? 3) - (b.poem.difficulty ?? 3))
                .slice(0, 3)
                .map((r) => r.poem.id)

            const suggestedPath = [poemId, ...easierRelated.filter((id) => id !== poemId)]

            for (const bloomLevel of bloomLevels) {
                gaps.push({
                    poemId,
                    bloomLevel,
                    relatedWeaknesses,
                    suggestedPath,
                })
            }
        }

        return gaps
    }

    /**
     * 3. 输出暗物质报告（供诗心 Agent 认知诊断使用）
     *
     * 聚合班级暗物质数据，按布鲁姆阶层、主题、意象维度统计，
     * 并输出 top N 模式及其处方。
     */
    async generateDarkMatterReport(classId: string): Promise<DarkMatterReport> {
        const darkMatter = await this.detectClassDarkMatter(classId)

        const byBloomLevel: Record<string, number> = {}
        const byTheme: Record<string, number> = {}
        const byImage: Record<string, number> = {}

        for (const dm of darkMatter) {
            byBloomLevel[dm.bloomLevel] = (byBloomLevel[dm.bloomLevel] ?? 0) + 1
            // 从 pattern 提取维度信息
            const imageMatch = dm.pattern.match(/含'([^']+)'意象的诗在'([^']+)'层卡顿/)
            const themeMatch = dm.pattern.match(/表达'([^']+)'主题的诗在'([^']+)'层卡顿/)
            const rhetoricMatch = dm.pattern.match(/使用'([^']+)'修辞的诗在'([^']+)'层卡顿/)

            if (imageMatch) {
                byImage[imageMatch[1] as string] = (byImage[imageMatch[1] as string] ?? 0) + 1
            } else if (themeMatch) {
                byTheme[themeMatch[1] as string] = (byTheme[themeMatch[1] as string] ?? 0) + 1
            } else if (rhetoricMatch) {
                byTheme[rhetoricMatch[1] as string] = (byTheme[rhetoricMatch[1] as string] ?? 0) + 1
            }
        }

        const topPatterns = darkMatter.slice(0, 5).map((dm) => ({
            pattern: dm.pattern,
            affectedStudents: dm.affectedStudents.length,
            affectedPoems: dm.affectedPoems.map((p) => p.title),
            prescription: dm.prescription,
        }))

        return {
            classId,
            totalDarkMatter: darkMatter.length,
            byBloomLevel,
            byTheme,
            byImage,
            topPatterns,
        }
    }

    // ─────────────────────────────────────────────────────────
    // 内部辅助方法
    // ─────────────────────────────────────────────────────────

    /**
     * 查询班级所有学生的掌握度聚合
     * 返回：
     * - students: Set<studentId>
     * - averages: Map<"poemId||bloomLevel", avgScore>
     * - studentScores: Map<"studentId||poemId||bloomLevel", score>
     */
    private queryClassMastery(classId: string): {
        students: Set<string>
        averages: Map<string, number>
        studentScores: Map<string, number>
    } {
        const result = {
            students: new Set<string>(),
            averages: new Map<string, number>(),
            studentScores: new Map<string, number>(),
        }

        try {
            // 1. 查询班级所有学生
            const students = db
                .prepare('SELECT id FROM students WHERE class_id = ?')
                .all(classId) as Array<{ id: string }>
            for (const s of students) {
                result.students.add(s.id)
            }

            if (students.length === 0) return result

            // 2. 查询班级所有学生的 mastery 记录
            const studentIds = students.map((s) => s.id)
            const placeholders = studentIds.map(() => '?').join(',')
            const rows = db
                .prepare(
                    `SELECT student_id, poem_id, bloom_level, score
                     FROM mastery
                     WHERE student_id IN (${placeholders})`,
                )
                .all(...studentIds) as Array<{
                    student_id: string
                    poem_id: string
                    bloom_level: string
                    score: number
                }>

            // 3. 聚合
            const sumByPair = new Map<string, number>()
            const countByPair = new Map<string, number>()

            for (const row of rows) {
                const key = `${row.poem_id}||${row.bloom_level}`
                result.studentScores.set(
                    `${row.student_id}||${row.poem_id}||${row.bloom_level}`,
                    row.score,
                )
                sumByPair.set(key, (sumByPair.get(key) ?? 0) + row.score)
                countByPair.set(key, (countByPair.get(key) ?? 0) + 1)
            }

            for (const [key, sum] of sumByPair.entries()) {
                const count = countByPair.get(key) ?? 1
                result.averages.set(key, sum / count)
            }
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                '查询班级掌握度失败（降级返回空）',
            )
        }

        return result
    }

    /** 查询学生薄弱点（score < 60 的记录） */
    private queryStudentWeaknesses(
        studentId: string,
    ): Array<{ poemId: string; bloomLevel: string; score: number }> {
        try {
            const rows = db
                .prepare(
                    `SELECT poem_id, bloom_level, score
                     FROM mastery
                     WHERE student_id = ? AND score < ?`,
                )
                .all(studentId, WEAK_THRESHOLD) as Array<{
                    poem_id: string
                    bloom_level: string
                    score: number
                }>
            return rows.map((r) => ({
                poemId: r.poem_id,
                bloomLevel: r.bloom_level,
                score: r.score,
            }))
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                '查询学生薄弱点失败',
            )
            return []
        }
    }

    /**
     * 收集暗物质模式（通用，适用于 image/theme/rhetoric 三维度）
     */
    private collectDarkMatterPatterns(
        darkMatter: DarkMatter[],
        classId: string,
        bloomLevel: string,
        dimension: 'image' | 'theme' | 'rhetoric',
        labelToPoems: Map<string, string[]>,
        classData: { students: Set<string>; studentScores: Map<string, number> },
        totalStudents: number,
        minAffectedRatio: number,
    ): void {
        for (const [label, poemIds] of labelToPoems.entries()) {
            // 至少 MIN_AFFECTED_POEMS 首诗共享此标签才算共性
            if (poemIds.length < MIN_AFFECTED_POEMS) continue

            // 找出在这批诗的 bloomLevel 上卡顿的学生
            const affectedStudents = new Set<string>()
            for (const studentId of classData.students) {
                let weakInAny = false
                for (const poemId of poemIds) {
                    const score = classData.studentScores.get(
                        `${studentId}||${poemId}||${bloomLevel}`,
                    )
                    if (score !== undefined && score < WEAK_THRESHOLD) {
                        weakInAny = true
                        break
                    }
                }
                if (weakInAny) {
                    affectedStudents.add(studentId)
                }
            }

            const ratio = affectedStudents.size / Math.max(1, totalStudents)
            if (ratio < minAffectedRatio) continue

            // 生成 pattern 文本
            const dimensionText =
                dimension === 'image'
                    ? `含'${label}'意象的诗`
                    : dimension === 'theme'
                        ? `表达'${label}'主题的诗`
                        : `使用'${label}'修辞的诗`
            const pattern = `${dimensionText}在'${bloomLevel}'层卡顿`

            // 查找种子诗标题
            const affectedPoemTitles = poemIds.map((id) => {
                const seed = this.poemIndex.get(id)
                return { poemId: id, title: seed?.title ?? id }
            })

            // 生成 rootCause 与 prescription
            const template = PRESCRIPTION_TEMPLATES[dimension]
            const rootCause = template.rootCause(label, bloomLevel)
            const prescription = template.prescription(
                label,
                affectedPoemTitles.map((p) => p.title),
            )

            darkMatter.push({
                id: `dm-${classId}-${dimension}-${label}-${bloomLevel}`.replace(/\s/g, '_'),
                classId,
                pattern,
                bloomLevel,
                affectedPoems: affectedPoemTitles,
                affectedStudents: Array.from(affectedStudents),
                affectedRatio: Math.round(ratio * 100) / 100,
                rootCause,
                prescription,
                detectedAt: Date.now(),
            })
        }
    }
}
