/**
 * 知识图谱 REST API 路由
 *
 * 5 个端点（前端 StarMap 页面调用）：
 * - GET /full                          获取完整图谱（不带掌握度）
 * - GET /mastery-colored?classId=xxx   获取带班级掌握度着色的图谱
 * - GET /dark-matter/:classId          获取班级认知暗物质聚焦子图
 * - GET /student/:studentId/gaps       获取学生知识漏洞聚焦子图
 * - GET /poem/:poemId/related          获取诗的关联诗节点列表
 *
 * 设计要点：
 * - Neo4j 不可用时优雅降级返回空数据（不抛 500）
 * - 掌握度着色按班级聚合（AVG score），非学生个体
 * - 暗物质/漏洞端点返回聚焦子图（目标诗 + 1 跳邻居 + 边）
 * - 模块级单例避免重复创建 Neo4j driver
 * - 暗物质检测带超时降级，避免阻塞响应
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import {
    KnowledgeGraphService,
    type GraphNode,
    type GraphEdge,
    type GraphData,
} from '../services/knowledge-graph/knowledge-graph-service.js'
import { DarkMatterDetector } from '../services/knowledge-graph/dark-matter-detector.js'
import { config } from '../config.js'
import type { BloomLevel, BloomMastery } from '../agents/base/types.js'
import { z } from 'zod'
import { validateParams, validateQuery, schemas } from '../lib/validation.js'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 掌握度阈值（与 KnowledgeGraphService.classifyMastery 保持一致） */
const MASTERY_GREEN_THRESHOLD = 80
const MASTERY_RED_THRESHOLD = 60

/** 暗物质检测超时（ms）—— 避免长时间阻塞响应 */
const DARK_MATTER_TIMEOUT_MS = 3000

// ─────────────────────────────────────────────────────────────
// 模块级单例（避免每次请求重复创建 Neo4j driver）
// ─────────────────────────────────────────────────────────────

let kgServiceInstance: KnowledgeGraphService | null = null
let detectorInstance: DarkMatterDetector | null = null

async function closeKnowledgeGraphService(): Promise<void> {
    const service = kgServiceInstance
    kgServiceInstance = null
    detectorInstance = null
    if (service) await service.close()
}

/**
 * 获取 KnowledgeGraphService 单例
 *
 * 构造函数仅创建 driver 对象，不立即连接。
 * init() 在路由插件注册时后台调用，Neo4j 不可用时降级返回空结果。
 */
function getKgService(): KnowledgeGraphService {
    if (!kgServiceInstance) {
        kgServiceInstance = new KnowledgeGraphService(
            config.neo4j.uri,
            config.neo4j.user,
            config.neo4j.password,
        )
        detectorInstance = new DarkMatterDetector(kgServiceInstance)
    }
    return kgServiceInstance
}

/** 获取 DarkMatterDetector 单例（依赖 KnowledgeGraphService） */
function getDetector(): DarkMatterDetector {
    if (!detectorInstance) {
        kgServiceInstance = new KnowledgeGraphService(
            config.neo4j.uri,
            config.neo4j.user,
            config.neo4j.password,
        )
        detectorInstance = new DarkMatterDetector(kgServiceInstance)
    }
    return detectorInstance
}

// ─────────────────────────────────────────────────────────────
// Zod schemas（B6.3 输入校验）
// ─────────────────────────────────────────────────────────────

/** GET /mastery-colored 查询参数 */
const classIdQuerySchema = z.object({ classId: schemas.classId })

/** GET /dark-matter/:classId 路径参数 */
const classIdParamsSchema = z.object({ classId: schemas.classId })

/** GET /student/:studentId/gaps 路径参数 */
const studentIdParamsSchema = z.object({ studentId: schemas.studentId })

/** GET /poem/:poemId/related 路径参数 */
const poemIdParamsSchema = z.object({ poemId: schemas.poemId })

// ─────────────────────────────────────────────────────────────
// 路由插件
// ─────────────────────────────────────────────────────────────

export const knowledgeGraphRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
    app.addHook('onClose', async () => {
        await closeKnowledgeGraphService()
    })
    // 后台初始化 Neo4j 连接（不阻塞路由注册；失败则降级返回空数据）
    // init() 内部已处理连接失败（5s 超时 + 警告日志 + connected=false）
    getKgService()
        .init()
        .catch(() => {
            // init() 内部已记录警告，此处静默
        })

    // ── 1. GET /full — 完整图谱（不带掌握度） ──
    app.get('/full', async (req, reply) => {
        try {
            const graph = await getAvailableGraph()
            return reply.send(graph)
        } catch (err) {
            req.log.error({ err }, 'knowledge-graph/full 查询失败')
            return reply.send({ nodes: [], edges: [] })
        }
    })

    // ── 2. GET /mastery-colored — 班级掌握度着色图谱 ──
    app.get(
        '/mastery-colored',
        async (req: FastifyRequest, reply) => {
            const query = validateQuery(classIdQuerySchema, req, reply)
            if (!query) return
            const { classId } = query

            try {
                const graph = await getAvailableGraph()
                if (graph.nodes.length === 0) {
                    return reply.send({ nodes: [], edges: [] })
                }

                // 查询班级在所有 Poem 节点上的六阶掌握度均值
                const poemIds = graph.nodes
                    .filter((n) => n.type === 'Poem')
                    .map((n) => n.id)
                const masteryMap = queryClassMasteryForPoems(classId, poemIds)

                // 为 Poem 节点着色（green/yellow/red）
                const nodes: GraphNode[] = graph.nodes.map((n) => {
                    if (n.type !== 'Poem') return n
                    const mastery = masteryMap.get(n.id)
                    if (!mastery) return { ...n }
                    const masteryLevel = classifyMastery(mastery)
                    return {
                        ...n,
                        properties: { ...n.properties, mastery, masteryLevel },
                    }
                })

                return reply.send({ nodes, edges: graph.edges })
            } catch (err) {
                req.log.error({ err }, 'knowledge-graph/mastery-colored 查询失败')
                return reply.send({ nodes: [], edges: [] })
            }
        },
    )

    // ── 3. GET /dark-matter/:classId — 班级认知暗物质聚焦子图 ──
    app.get(
        '/dark-matter/:classId',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(classIdParamsSchema, req, reply)
            if (!params) return
            const { classId } = params

            try {
                const detector = getDetector()
                const darkMatterList = await withTimeout(
                    detector.detectClassDarkMatter(classId),
                    DARK_MATTER_TIMEOUT_MS,
                    [],
                )

                // 收集所有受暗物质影响的诗 ID
                const targetPoemIds = new Set<string>()
                for (const dm of darkMatterList) {
                    for (const p of dm.affectedPoems) {
                        targetPoemIds.add(p.poemId)
                    }
                }

                // 从完整图谱中提取聚焦子图（目标诗 + 1 跳邻居）
                const graph = await getAvailableGraph()
                const subgraph = buildFocusedSubgraph(graph, targetPoemIds, 'isDarkMatter', true)
                return reply.send(subgraph)
            } catch (err) {
                req.log.error({ err }, 'knowledge-graph/dark-matter 查询失败')
                return reply.send({ nodes: [], edges: [] })
            }
        },
    )

    // ── 4. GET /student/:studentId/gaps — 学生知识漏洞聚焦子图 ──
    app.get(
        '/student/:studentId/gaps',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(studentIdParamsSchema, req, reply)
            if (!params) return
            const { studentId } = params

            try {
                const detector = getDetector()
                const gaps = await withTimeout(
                    detector.detectStudentGaps(studentId),
                    DARK_MATTER_TIMEOUT_MS,
                    [],
                )

                // 收集漏洞诗 + 建议学习路径上的诗 ID
                const targetPoemIds = new Set<string>()
                for (const g of gaps) {
                    targetPoemIds.add(g.poemId)
                    for (const id of g.suggestedPath) {
                        targetPoemIds.add(id)
                    }
                }

                const graph = await getAvailableGraph()
                const subgraph = buildFocusedSubgraph(graph, targetPoemIds, 'isGap', true)
                return reply.send(subgraph)
            } catch (err) {
                req.log.error({ err }, 'knowledge-graph/student/gaps 查询失败')
                return reply.send({ nodes: [], edges: [] })
            }
        },
    )

    // ── 5. GET /poem/:poemId/related — 诗的关联诗节点列表 ──
    app.get(
        '/poem/:poemId/related',
        async (req: FastifyRequest, reply) => {
            const params = validateParams(poemIdParamsSchema, req, reply)
            if (!params) return
            const { poemId } = params

            try {
                const related = await getKgService().findRelatedPoems(poemId, 10)
                if (related.length === 0) {
                    return reply.send(findRelatedPoemsInSqlite(poemId, 10))
                }
                const nodes: GraphNode[] = related.map((r) => ({
                    id: r.poem.id,
                    label: r.poem.title,
                    type: 'Poem' as const,
                    properties: {
                        poet: r.poem.poet,
                        dynasty: r.poem.dynasty,
                        relationType: r.relationType,
                        strength: r.strength,
                        difficulty: r.poem.difficulty,
                    },
                }))
                return reply.send(nodes)
            } catch (err) {
                req.log.error({ err }, 'knowledge-graph/poem/related 查询失败')
                return reply.send([])
            }
        },
    )
}

// ─────────────────────────────────────────────────────────────
// 业务辅助函数
// ─────────────────────────────────────────────────────────────

interface SqlitePoemGraphRow {
    id: string
    title: string
    poet: string
    dynasty: string
    content: string
    theme: string
    images: string
    rhetoric: string
    grade_level: string | null
    difficulty: number
}

function parseStringArray(raw: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw)
        return Array.isArray(parsed)
            ? [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
            : []
    } catch {
        return []
    }
}

function graphEntityId(type: 'poet' | 'era' | 'theme' | 'image' | 'rhetoric', value: string): string {
    return `${type}:${encodeURIComponent(value)}`
}

/**
 * Neo4j 是增强型图计算后端，不应成为基本阅读体验的单点故障。
 * 连接不可用时，从同一持久化 SQLite 诗库构建确定性图谱；这里不制造样例数据。
 */
function buildSqliteGraph(): GraphData {
    const poems = db.prepare(`
        SELECT id, title, poet, dynasty, content, theme, images, rhetoric, grade_level, difficulty
        FROM poems
        ORDER BY id ASC
    `).all() as SqlitePoemGraphRow[]

    const nodes = new Map<string, GraphNode>()
    const edges: GraphEdge[] = []
    const addEntity = (
        id: string,
        label: string,
        type: GraphNode['type'],
        properties?: Record<string, unknown>,
    ) => {
        if (!nodes.has(id)) nodes.set(id, { id, label, type, properties })
    }
    const addEdge = (source: string, target: string, type: string, evidence: string[]) => {
        edges.push({ source, target, type, weight: 1, confidence: 'EXTRACTED', evidence })
    }

    for (const poem of poems) {
        addEntity(poem.id, poem.title, 'Poem', {
            poet: poem.poet,
            dynasty: poem.dynasty,
            content: poem.content,
            gradeLevel: poem.grade_level,
            difficulty: poem.difficulty,
            source: 'sqlite',
        })

        const poetId = graphEntityId('poet', poem.poet)
        const eraId = graphEntityId('era', poem.dynasty)
        addEntity(poetId, poem.poet, 'Poet', { dynasty: poem.dynasty, source: 'sqlite' })
        addEntity(eraId, poem.dynasty, 'Era', { source: 'sqlite' })
        addEdge(poem.id, poetId, 'WROTE', [`作者：${poem.poet}`])
        addEdge(poem.id, eraId, 'OF_ERA', [`朝代：${poem.dynasty}`])

        for (const theme of parseStringArray(poem.theme)) {
            const id = graphEntityId('theme', theme)
            addEntity(id, theme, 'Theme', { source: 'sqlite' })
            addEdge(poem.id, id, 'EXPRESSES_THEME', [`主题：${theme}`])
        }
        for (const image of parseStringArray(poem.images)) {
            const id = graphEntityId('image', image)
            addEntity(id, image, 'Image', { source: 'sqlite' })
            addEdge(poem.id, id, 'USES_IMAGE', [`意象：${image}`])
        }
        for (const rhetoric of parseStringArray(poem.rhetoric)) {
            const id = graphEntityId('rhetoric', rhetoric)
            addEntity(id, rhetoric, 'Rhetoric', { source: 'sqlite' })
            addEdge(poem.id, id, 'USES_RHETORIC', [`修辞：${rhetoric}`])
        }
    }

    return { nodes: [...nodes.values()], edges }
}

async function getAvailableGraph(): Promise<GraphData> {
    const graph = await getKgService().getFullGraph()
    return graph.nodes.length > 0 ? graph : buildSqliteGraph()
}

function findRelatedPoemsInSqlite(poemId: string, limit: number): GraphNode[] {
    const poems = db.prepare(`
        SELECT id, title, poet, dynasty, content, theme, images, rhetoric, grade_level, difficulty
        FROM poems
        ORDER BY id ASC
    `).all() as SqlitePoemGraphRow[]
    const source = poems.find((poem) => poem.id === poemId)
    if (!source) return []

    const sourceThemes = new Set(parseStringArray(source.theme))
    const sourceImages = new Set(parseStringArray(source.images))
    const sourceRhetoric = new Set(parseStringArray(source.rhetoric))
    const overlap = (left: Set<string>, right: string[]) => right.filter((item) => left.has(item))

    return poems
        .filter((poem) => poem.id !== poemId)
        .map((poem) => {
            const sharedThemes = overlap(sourceThemes, parseStringArray(poem.theme))
            const sharedImages = overlap(sourceImages, parseStringArray(poem.images))
            const sharedRhetoric = overlap(sourceRhetoric, parseStringArray(poem.rhetoric))
            const authorBoost = poem.poet === source.poet ? 2 : 0
            const eraBoost = poem.dynasty === source.dynasty ? 0.5 : 0
            const strength = sharedThemes.length * 3 + sharedImages.length * 2 + sharedRhetoric.length + authorBoost + eraBoost
            return { poem, sharedThemes, sharedImages, sharedRhetoric, strength }
        })
        .filter((item) => item.strength > 0)
        .sort((a, b) => b.strength - a.strength || a.poem.id.localeCompare(b.poem.id))
        .slice(0, limit)
        .map(({ poem, sharedThemes, sharedImages, sharedRhetoric, strength }) => ({
            id: poem.id,
            label: poem.title,
            type: 'Poem',
            properties: {
                poet: poem.poet,
                dynasty: poem.dynasty,
                difficulty: poem.difficulty,
                relationType: sharedThemes.length > 0
                    ? 'SIMILAR_THEME'
                    : sharedImages.length > 0
                        ? 'SHARES_IMAGE'
                        : 'BORROWS_RHETORIC',
                strength,
                evidence: [
                    ...sharedThemes.map((value) => `共同主题：${value}`),
                    ...sharedImages.map((value) => `共同意象：${value}`),
                    ...sharedRhetoric.map((value) => `共同修辞：${value}`),
                ],
                source: 'sqlite',
            },
        }))
}

/**
 * 查询班级在指定诗上的六阶掌握度均值
 *
 * 通过 JOIN students + mastery 聚合，按 poem_id + bloom_level 分组取 AVG(score)。
 * 返回 Map<poemId, BloomMastery>，未查询到的诗不在 Map 中（视为未学习）。
 */
function queryClassMasteryForPoems(
    classId: string,
    poemIds: string[],
): Map<string, BloomMastery> {
    const result = new Map<string, BloomMastery>()
    if (poemIds.length === 0) return result

    try {
        const placeholders = poemIds.map(() => '?').join(',')
        const rows = db
            .prepare(
                `SELECT m.poem_id AS poem_id,
                        m.bloom_level AS bloom_level,
                        AVG(m.score) AS avg_score
                 FROM mastery m
                 JOIN students s ON m.student_id = s.id
                 WHERE s.class_id = ? AND m.poem_id IN (${placeholders})
                 GROUP BY m.poem_id, m.bloom_level`,
            )
            .all(classId, ...poemIds) as Array<{
                poem_id: string
                bloom_level: string
                avg_score: number
            }>

        for (const row of rows) {
            const mastery = result.get(row.poem_id) ?? {
                记忆: 0,
                理解: 0,
                应用: 0,
                分析: 0,
                评价: 0,
                创造: 0,
            }
            const level = row.bloom_level as BloomLevel
            if (level in mastery) {
                mastery[level] = Math.round(row.avg_score * 10) / 10
            }
            result.set(row.poem_id, mastery)
        }
    } catch (err) {
        // 静默降级（不打印 err.message 到 stdout）
    }

    return result
}

/**
 * 根据六阶掌握度判定颜色等级
 *
 * 与 KnowledgeGraphService.classifyMastery 保持一致：
 * - red：记忆层 < 60
 * - green：六阶皆 >= 80
 * - yellow：介于二者之间（高阶薄弱）
 */
function classifyMastery(mastery: BloomMastery): 'green' | 'yellow' | 'red' {
    if (mastery['记忆'] < MASTERY_RED_THRESHOLD) {
        return 'red'
    }
    const allGreen = BLOOM_LEVELS.every((level) => mastery[level] >= MASTERY_GREEN_THRESHOLD)
    if (allGreen) {
        return 'green'
    }
    return 'yellow'
}

/**
 * 从完整图谱中提取目标诗的聚焦子图
 *
 * 保留节点：目标诗 + 直接邻居（1 跳）
 * 保留边：两端节点均在保留集合中的边
 * 目标诗节点在 properties 中打上标记（isDarkMatter / isGap）
 *
 * @param graph 完整图谱
 * @param targetPoemIds 目标诗 ID 集合
 * @param markKey 在目标诗节点 properties 中打上的标记键
 * @param markValue 标记值
 */
function buildFocusedSubgraph(
    graph: GraphData,
    targetPoemIds: Set<string>,
    markKey: string,
    markValue: unknown,
): GraphData {
    if (targetPoemIds.size === 0 || graph.nodes.length === 0) {
        return { nodes: [], edges: [] }
    }

    // 收集需要保留的节点：目标诗 + 直接邻居
    const keepNodeIds = new Set<string>(targetPoemIds)
    for (const edge of graph.edges) {
        if (targetPoemIds.has(edge.source)) {
            keepNodeIds.add(edge.target)
        }
        if (targetPoemIds.has(edge.target)) {
            keepNodeIds.add(edge.source)
        }
    }

    const nodes: GraphNode[] = graph.nodes
        .filter((n) => keepNodeIds.has(n.id))
        .map((n) =>
            targetPoemIds.has(n.id)
                ? { ...n, properties: { ...n.properties, [markKey]: markValue } }
                : n,
        )

    const edges = graph.edges.filter(
        (e) => keepNodeIds.has(e.source) && keepNodeIds.has(e.target),
    )

    return { nodes, edges }
}

/**
 * Promise 超时降级包装
 * @param p 目标 Promise
 * @param ms 超时毫秒
 * @param fallback 超时返回值
 */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            p,
            new Promise<T>((resolve) => {
                timer = setTimeout(() => resolve(fallback), ms)
            }),
        ])
    } catch {
        return fallback
    } finally {
        if (timer) clearTimeout(timer)
    }
}
