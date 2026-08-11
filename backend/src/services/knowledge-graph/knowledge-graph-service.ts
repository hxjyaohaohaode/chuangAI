/**
 * 知识图谱查询服务
 *
 * 职责：
 * 1. 管理 Neo4j Driver 生命周期（连接、初始化、关闭）
 * 2. 提供 8 个图谱查询方法（按诗/主题/意象/修辞/诗人检索 + 全图/子图/掌握度着色）
 * 3. 启动时幂等导入种子数据（Era/Poet/Poem/Image/Theme/Rhetoric + 10 种边）
 * 4. Neo4j 不可用时优雅降级 —— 所有查询返回空数组，不抛错
 *
 * 设计要点：
 * - 所有 Cypher 查询使用 $param 参数化，杜绝注入
 * - 写操作用 executeWrite，读操作用 executeRead（Neo4j 5 推荐范式）
 * - 全图谱查询覆盖完整小学语料；前端按视图采用 Canvas/分层渲染
 * - 掌握度着色通过 SQLite mastery 表联动（不破坏现有 db 模块）
 */

import neo4j, { type Driver, type Session } from 'neo4j-driver'
import { SCHEMA_CONSTRAINTS, type Confidence, defaultConfidenceFor } from './schema.js'
import {
    IMAGE_CULTURAL_MEANINGS,
    RHETORIC_DESCRIPTIONS,
    type SeedPoem,
} from './seed-data.js'
import {
    SEED_ERAS_FULL,
    SEED_POETS_FULL,
    SEED_POEMS_FULL,
    SEED_MENTORSHIPS_FULL,
} from './seed-poems-full.js'
import type { PoemNode, BloomMastery, BloomLevel } from '../../agents/base/types.js'
import { kgLogger } from '../../lib/logger/index.js'

/** 知识图谱 logger 单例 */
const log = kgLogger()

// ─────────────────────────────────────────────────────────────
// 图谱结果类型定义
// ─────────────────────────────────────────────────────────────

/** D3.js 力导向图节点格式 */
export interface GraphNode {
    id: string
    label: string
    type: 'Poet' | 'Poem' | 'Image' | 'Theme' | 'Era' | 'Rhetoric'
    properties?: Record<string, unknown>
}

/** D3.js 力导向图边格式 */
export interface GraphEdge {
    source: string
    target: string
    type: string
    weight?: number
    /**
     * 关系置信度。
     * 优先取 Neo4j 边属性 confidence；缺失时按 defaultConfidenceFor(type) 映射：
     *   EXTRACTED（提取类边）/ INFERRED（推断类边）/ AMBIGUOUS（MENTORS 师承）。
     */
    confidence?: Confidence
    /** 可读关系证据，如共享意象、主题或修辞 */
    evidence?: string[]
    /** 人工标注关系说明，如师承依据 */
    note?: string
}

/** 完整图谱 / 子图返回结构 */
export interface GraphData {
    nodes: GraphNode[]
    edges: GraphEdge[]
}

/** 关联诗返回结构 */
export interface RelatedPoem {
    poem: PoemNode
    relationType: 'SHARES_IMAGE' | 'SIMILAR_THEME' | 'BORROWS_RHETORIC'
    strength: number
    /**
     * 关系置信度。findRelatedPoems 仅返回推断类边（SHARES_IMAGE/SIMILAR_THEME/BORROWS_RHETORIC），
     * 故恒为 'INFERRED'；字段保留以便未来扩展与下游统一消费。
     */
    confidence?: Confidence
}

/** 带掌握度着色的图谱节点 */
export interface MasteryGraphNode extends GraphNode {
    mastery?: BloomMastery
    masteryLevel?: 'green' | 'yellow' | 'red'
}

export interface MasteryGraphData {
    nodes: MasteryGraphNode[]
    edges: GraphEdge[]
}

/** 诗人节点（用于师承链返回） */
export interface PoetNode {
    id: string
    name: string
    dynasty: string
    birthYear?: number
    deathYear?: number
    style?: string
    brief?: string
}

// ─────────────────────────────────────────────────────────────
// 新增查询返回类型（surprisingConnections / guidedTour）
// ─────────────────────────────────────────────────────────────

/** surprisingConnections 返回的"意想不到的关联"候选 */
export interface SurprisingConnection {
    /** 候选节点（D3 兼容格式） */
    node: GraphNode
    /** plain-English 解释为什么"意想不到" */
    reason: string
    /** 共同邻居的展示名列表 */
    commonNeighbors: string[]
    /** 共同邻居数量 */
    commonCount: number
    /** 启发式标签：跨类型关联 / 稀疏共同邻居 */
    heuristic: 'cross-type' | 'sparse-common'
    /** 种子节点的类型（labels[0]，如 'Poem'） */
    seedType: string
    /** 关系置信度（启发式推导，恒为 INFERRED） */
    confidence: Confidence
}

/** guidedTour 返回的导览步骤 */
export interface GuidedTourStep {
    /** 步骤序号，从 1 开始 */
    step: number
    /** 该步对应的诗节点 */
    poem: PoemNode
    /** plain-English 解释（依赖排序理由） */
    explanation: string
    /** 与上一步的关联说明（首步无） */
    linkToPrevious?: string
    /** 关系置信度（基于难度/共享意象的启发式排序，恒为 INFERRED） */
    confidence: Confidence
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/**
 * 完整小学语料当前约 928 节点。旧值 500 会因构建顺序将诗篇整体截掉，
 * 这里留出扩展余量，确保诗篇、诗人、意象、主题、修辞和朝代同时完整返回。
 */
const DEFAULT_GRAPH_LIMIT = 1200

/** 布鲁姆六阶（与 agents/base/types.ts 保持一致） */
const BLOOM_LEVELS: readonly BloomLevel[] = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const

/** 掌握度阈值 */
const MASTERY_GREEN_THRESHOLD = 80
const MASTERY_RED_THRESHOLD = 60

/**
 * 从 Neo4j 边属性解析 confidence。
 * 优先用边自身写入的 confidence；非法值或缺失时按边类型映射默认值。
 * 不强制写库迁移，符合 spec"若现有边无此属性，查询时默认 INFERRED"。
 */
function resolveConfidence(
    properties: Record<string, unknown>,
    relType: string,
): Confidence {
    const raw = properties['confidence']
    if (
        typeof raw === 'string' &&
        (raw === 'EXTRACTED' || raw === 'INFERRED' || raw === 'AMBIGUOUS')
    ) {
        return raw
    }
    return defaultConfidenceFor(relType)
}

// ─────────────────────────────────────────────────────────────
// KnowledgeGraphService 主类
// ─────────────────────────────────────────────────────────────

export class KnowledgeGraphService {
    private readonly driver: Driver
    /** 是否已成功连接 Neo4j（用于降级判断） */
    private connected = false
    /** 种子数据是否已导入（避免重复导入） */
    private seeded = false

    constructor(uri: string, user: string, password: string) {
        this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
            // 连接超时 5s，避免 Neo4j 未启动时长时间阻塞
            connectionTimeout: 5000,
            // 禁用 IPv6 探测，避免某些环境下的 DNS 解析问题
            disableLosslessIntegers: true,
        })
    }

    // ─────────────────────────────────────────────────────────
    // 生命周期管理
    // ─────────────────────────────────────────────────────────

    /**
     * 初始化知识图谱
     *
     * 流程：
     * 1. 验证 Neo4j 连通性（失败则降级，不抛错）
     * 2. 执行 Schema 约束与索引
     * 3. 若图谱为空，导入种子数据
     *
     * 幂等：可重复调用
     */
    async init(): Promise<void> {
        try {
            await this.driver.verifyConnectivity()
            this.connected = true
            log.info('Neo4j 连接成功')
        } catch (err) {
            this.connected = false
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'Neo4j 连接失败，知识图谱服务降级运行（查询将返回空结果）',
            )
            return
        }

        try {
            await this.applySchema()
            await this.seedIfEmpty()
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                '知识图谱初始化异常（降级运行）',
            )
            // 不重置 connected，因为连接本身是通的，只是 schema/seed 失败
        }
    }

    /**
     * 关闭 Neo4j 驱动
     */
    async close(): Promise<void> {
        if (this.connected) {
            try {
                await this.driver.close()
                log.info('Neo4j 驱动已关闭')
            } catch (err) {
                log.warn({ err }, '关闭 Neo4j 驱动异常')
            }
            this.connected = false
        } else {
            // 即使未连接成功也要关闭 driver 以释放资源
            try {
                await this.driver.close()
            } catch {
                // 忽略
            }
        }
    }

    /** 是否已连接 Neo4j（用于外部健康检查） */
    isConnected(): boolean {
        return this.connected
    }

    // ─────────────────────────────────────────────────────────
    // Schema 与种子数据
    // ─────────────────────────────────────────────────────────

    /**
     * 执行 Schema DDL（约束 + 索引）
     */
    private async applySchema(): Promise<void> {
        const session = this.driver.session()
        try {
            // Neo4j 不支持一次执行多条 DDL，需要按分号拆分
            const statements = SCHEMA_CONSTRAINTS
                .split(';')
                .map((s) => s.trim())
                .filter((s) => s.length > 0 && !s.startsWith('//'))

            for (const stmt of statements) {
                await session.run(stmt)
            }
            log.info({ statements: statements.length }, 'Schema 约束与索引已应用')
        } finally {
            await session.close()
        }
    }

    /**
     * 若图谱为空则导入种子数据
     */
    private async seedIfEmpty(): Promise<void> {
        if (this.seeded) return

        const session = this.driver.session()
        try {
            // 检查是否已有 Poem 节点
            const result = await session.run('MATCH (p:Poem) RETURN count(p) AS cnt')
            const count = result.records[0]?.get('cnt') ?? 0
            if (typeof count === 'number' && count > 0) {
                log.info({ poemCount: count }, '图谱已有 Poem 节点，跳过种子导入')
                this.seeded = true
                return
            }

            log.info('图谱为空，开始导入种子数据...')
            await this.seedEras(session)
            await this.seedPoets(session)
            await this.seedPoemsAndRelations(session)
            await this.seedMentorships(session)
            await this.seedContemporaries(session)
            await this.seedPoemPoemRelations(session)
            log.info(
                {
                    poems: SEED_POEMS_FULL.length,
                    poets: SEED_POETS_FULL.length,
                    eras: SEED_ERAS_FULL.length,
                },
                '种子数据导入完成（古诗 + 诗人 + 朝代 + 师承/同时代/共享关系）',
            )
            this.seeded = true
        } finally {
            await session.close()
        }
    }

    /** 导入朝代节点 */
    private async seedEras(session: Session): Promise<void> {
        for (const era of SEED_ERAS_FULL) {
            await session.run(
                `MERGE (e:Era {name: $name})
                 SET e.startYear = $startYear, e.endYear = $endYear`,
                {
                    name: era.name,
                    startYear: era.startYear ?? null,
                    endYear: era.endYear ?? null,
                },
            )
        }
    }

    /** 导入诗人节点 */
    private async seedPoets(session: Session): Promise<void> {
        for (const poet of SEED_POETS_FULL) {
            await session.run(
                `MERGE (p:Poet {id: $id})
                 SET p.name = $name,
                     p.dynasty = $dynasty,
                     p.birthYear = $birthYear,
                     p.deathYear = $deathYear,
                     p.style = $style,
                     p.brief = $brief`,
                {
                    id: poet.id,
                    name: poet.name,
                    dynasty: poet.dynasty,
                    birthYear: poet.birthYear ?? null,
                    deathYear: poet.deathYear ?? null,
                    style: poet.style ?? null,
                    brief: poet.brief ?? null,
                },
            )
        }
    }

    /** 导入古诗节点 + 6 种直接关系（WROTE / OF_ERA / USES_IMAGE / EXPRESSES_THEME / USES_RHETORIC） */
    private async seedPoemsAndRelations(session: Session): Promise<void> {
        for (const poem of SEED_POEMS_FULL) {
            // 1. Poem 节点
            await session.run(
                `MERGE (p:Poem {id: $id})
                 SET p.title = $title,
                     p.content = $content,
                     p.difficulty = $difficulty,
                     p.gradeLevel = $gradeLevel,
                     p.textbookEdition = $textbookEdition,
                     p.poet = $poet,
                     p.dynasty = $dynasty`,
                {
                    id: poem.id,
                    title: poem.title,
                    content: poem.content,
                    difficulty: poem.difficulty,
                    gradeLevel: poem.gradeLevel,
                    textbookEdition: '统编版',
                    poet: poem.poet,
                    dynasty: poem.dynasty,
                },
            )

            // 2. WROTE 边：(:Poet)-[:WROTE]->(:Poem)
            await session.run(
                `MATCH (poet:Poet {name: $poetName}), (poem:Poem {id: $poemId})
                 MERGE (poet)-[:WROTE]->(poem)`,
                { poetName: poem.poet, poemId: poem.id },
            )

            // 3. OF_ERA 边：(:Poem)-[:OF_ERA]->(:Era)
            await session.run(
                `MATCH (poem:Poem {id: $poemId}), (era:Era {name: $eraName})
                 MERGE (poem)-[:OF_ERA]->(era)`,
                { poemId: poem.id, eraName: poem.dynasty },
            )

            // 4. USES_IMAGE 边 + Image 节点
            for (const img of poem.images) {
                const culturalMeaning = IMAGE_CULTURAL_MEANINGS[img] ?? null
                await session.run(
                    `MERGE (i:Image {name: $name})
                     SET i.culturalMeaning = $culturalMeaning
                     WITH i
                     MATCH (poem:Poem {id: $poemId})
                     MERGE (poem)-[:USES_IMAGE]->(i)`,
                    { name: img, culturalMeaning, poemId: poem.id },
                )
            }

            // 5. EXPRESSES_THEME 边 + Theme 节点
            for (const theme of poem.themes) {
                await session.run(
                    `MERGE (t:Theme {name: $name})
                     WITH t
                     MATCH (poem:Poem {id: $poemId})
                     MERGE (poem)-[:EXPRESSES_THEME]->(t)`,
                    { name: theme, poemId: poem.id },
                )
            }

            // 6. USES_RHETORIC 边 + Rhetoric 节点
            for (const rhetoric of poem.rhetoric) {
                const description = RHETORIC_DESCRIPTIONS[rhetoric] ?? null
                await session.run(
                    `MERGE (r:Rhetoric {name: $name})
                     SET r.description = $description
                     WITH r
                     MATCH (poem:Poem {id: $poemId})
                     MERGE (poem)-[:USES_RHETORIC]->(r)`,
                    { name: rhetoric, description, poemId: poem.id },
                )
            }
        }
    }

    /** 导入师承关系：(:Poet)-[:MENTORS {note}]->(:Poet) */
    private async seedMentorships(session: Session): Promise<void> {
        for (const m of SEED_MENTORSHIPS_FULL) {
            await session.run(
                `MATCH (mentor:Poet {name: $mentorName}),
                        (mentee:Poet {name: $menteeName})
                 MERGE (mentor)-[r:MENTORS]->(mentee)
                 SET r.note = $note`,
                { mentorName: m.mentor, menteeName: m.mentee, note: m.note },
            )
        }
    }

    /** 自动推导同时代诗人：(:Poet)-[:CONTEMPORARY]->(:Poet) */
    private async seedContemporaries(session: Session): Promise<void> {
        await session.run(
            `MATCH (p1:Poet), (p2:Poet)
             WHERE p1.id < p2.id
               AND p1.birthYear IS NOT NULL AND p2.birthYear IS NOT NULL
               AND p1.deathYear IS NOT NULL AND p2.deathYear IS NOT NULL
               AND p1.birthYear <= p2.deathYear
               AND p2.birthYear <= p1.deathYear
             MERGE (p1)-[:CONTEMPORARY]->(p2)`,
        )
    }

    /** 导入诗与诗的三种关联：SHARES_IMAGE / SIMILAR_THEME / BORROWS_RHETORIC */
    private async seedPoemPoemRelations(session: Session): Promise<void> {
        // SHARES_IMAGE：共享至少 1 个意象
        await session.run(
            `MATCH (p1:Poem)-[:USES_IMAGE]->(i:Image)<-[:USES_IMAGE]-(p2:Poem)
             WHERE p1.id < p2.id
             WITH p1, p2, collect(i.name) AS sharedImages, count(i) AS cnt
             MERGE (p1)-[r:SHARES_IMAGE]->(p2)
             SET r.count = cnt, r.images = sharedImages`,
        )

        // SIMILAR_THEME：Jaccard 相似度 > 0
        await session.run(
            `MATCH (p1:Poem)-[:EXPRESSES_THEME]->(t:Theme)<-[:EXPRESSES_THEME]-(p2:Poem)
             WHERE p1.id < p2.id
             WITH p1, p2, collect(t.name) AS sharedThemes, count(t) AS sharedCount
             MATCH (p1)-[:EXPRESSES_THEME]->(allT1:Theme)
             WITH p1, p2, sharedThemes, sharedCount, count(allT1) AS t1Count
             MATCH (p2)-[:EXPRESSES_THEME]->(allT2:Theme)
             WITH p1, p2, sharedThemes, sharedCount, t1Count, count(allT2) AS t2Count
             WITH p1, p2, sharedThemes, sharedCount, t1Count, t2Count,
                  toFloat(sharedCount) / (t1Count + t2Count - sharedCount) AS jaccard
             WHERE jaccard > 0
             MERGE (p1)-[r:SIMILAR_THEME]->(p2)
             SET r.score = jaccard, r.themes = sharedThemes`,
        )

        // BORROWS_RHETORIC：共享至少 1 个修辞
        await session.run(
            `MATCH (p1:Poem)-[:USES_RHETORIC]->(rh:Rhetoric)<-[:USES_RHETORIC]-(p2:Poem)
             WHERE p1.id < p2.id
             WITH p1, p2, collect(rh.name) AS sharedRhetoric, count(rh) AS cnt
             MERGE (p1)-[r:BORROWS_RHETORIC]->(p2)
             SET r.count = cnt, r.rhetoric = sharedRhetoric`,
        )
    }

    // ─────────────────────────────────────────────────────────
    // 内部工具方法
    // ─────────────────────────────────────────────────────────

    /**
     * 容错执行读事务。Neo4j 不可用时返回 fallback。
     */
    private async safeRead<T>(
        fallback: T,
        work: (session: Session) => Promise<T>,
    ): Promise<T> {
        if (!this.connected) {
            return fallback
        }
        const session = this.driver.session()
        try {
            return await work(session)
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                '查询失败，降级返回空结果',
            )
            // 连接可能已失效，标记降级
            if (this.isConnectionError(err)) {
                this.connected = false
            }
            return fallback
        } finally {
            await session.close()
        }
    }

    /** 判断是否为连接类错误（用于自动降级） */
    private isConnectionError(err: unknown): boolean {
        if (!(err instanceof Error)) return false
        const msg = err.message.toLowerCase()
        return (
            msg.includes('connection') ||
            msg.includes('econnrefused') ||
            msg.includes('econnreset') ||
            msg.includes('timeout') ||
            msg.includes('broken pipe') ||
            msg.includes('session expired')
        )
    }

    /** 将 Neo4j 节点属性转换为 PoemNode */
    private toPoemNode(properties: Record<string, unknown>, seedPoem?: SeedPoem): PoemNode {
        // 优先从种子数据补全 themes/images 字段（图谱节点不存储数组属性）
        if (seedPoem) {
            return {
                id: seedPoem.id,
                title: seedPoem.title,
                poet: seedPoem.poet,
                dynasty: seedPoem.dynasty,
                theme: seedPoem.themes,
                images: seedPoem.images,
                content: seedPoem.content,
                gradeLevel: seedPoem.gradeLevel,
                difficulty: seedPoem.difficulty,
            }
        }
        return {
            id: String(properties['id'] ?? ''),
            title: String(properties['title'] ?? ''),
            poet: String(properties['poet'] ?? ''),
            dynasty: String(properties['dynasty'] ?? ''),
            theme: [],
            images: [],
            content: String(properties['content'] ?? ''),
            gradeLevel: properties['gradeLevel'] ? String(properties['gradeLevel']) : undefined,
            difficulty: properties['difficulty'] ? Number(properties['difficulty']) : undefined,
        }
    }

    /** 根据 poemId 查找种子诗（用于补全 theme/images 字段） */
    private findSeedPoem(poemId: string): SeedPoem | undefined {
        return SEED_POEMS_FULL.find((p) => p.id === poemId)
    }

    // ─────────────────────────────────────────────────────────
    // 内存降级实现（Neo4j 不可用时使用）
    // ─────────────────────────────────────────────────────────

    /**
     * Neo4j 不可用时，从内存种子数据构建完整图谱。
     *
     * 用于 DEMO_MODE 下前端 /starmap 页面也能展示完整知识图谱。
     * 构建逻辑与 seedPoemsAndRelations / seedMentorships / seedPoemPoemRelations
     * 在 Neo4j 中的写入一一对应，但完全在内存中执行，不依赖数据库连接。
     *
     * 节点构建顺序：Era → Poet → Image → Theme → Rhetoric → Poem
     * 截断策略：仅在总数 > limit 时按上述顺序保留前 limit 个节点，
     *          Poem 数量最多且排在最后，截断时优先丢失。
     * 边过滤：仅返回两端节点均在截断后节点集合中的边。
     *
     * @param limit 节点数上限，默认 500
     */
    private buildInMemoryGraph(limit: number = DEFAULT_GRAPH_LIMIT): GraphData {
        const nodes: GraphNode[] = []
        const seenIds = new Set<string>()
        const addNode = (node: GraphNode): void => {
            if (!node.id || seenIds.has(node.id)) return
            seenIds.add(node.id)
            nodes.push(node)
        }

        // 1. Era 节点（id/name 均用朝代名）
        for (const era of SEED_ERAS_FULL) {
            addNode({
                id: era.name,
                label: era.name,
                type: 'Era',
                properties: {
                    name: era.name,
                    startYear: era.startYear ?? null,
                    endYear: era.endYear ?? null,
                },
            })
        }

        // 2. Poet 节点
        for (const poet of SEED_POETS_FULL) {
            addNode({
                id: poet.id,
                label: poet.name,
                type: 'Poet',
                properties: {
                    id: poet.id,
                    name: poet.name,
                    dynasty: poet.dynasty,
                    birthYear: poet.birthYear ?? null,
                    deathYear: poet.deathYear ?? null,
                    style: poet.style ?? null,
                    brief: poet.brief ?? null,
                },
            })
        }

        // 3. 收集所有 Image/Theme/Rhetoric 去重（用于构建对应节点）
        const imageSet = new Set<string>()
        const themeSet = new Set<string>()
        const rhetoricSet = new Set<string>()
        for (const poem of SEED_POEMS_FULL) {
            for (const img of poem.images) imageSet.add(img)
            for (const theme of poem.themes) themeSet.add(theme)
            for (const r of poem.rhetoric) rhetoricSet.add(r)
        }

        // 4. Image 节点
        for (const img of imageSet) {
            addNode({
                id: img,
                label: img,
                type: 'Image',
                properties: {
                    name: img,
                    culturalMeaning: IMAGE_CULTURAL_MEANINGS[img] ?? null,
                },
            })
        }

        // 5. Theme 节点
        for (const theme of themeSet) {
            addNode({
                id: theme,
                label: theme,
                type: 'Theme',
                properties: { name: theme },
            })
        }

        // 6. Rhetoric 节点
        for (const r of rhetoricSet) {
            addNode({
                id: r,
                label: r,
                type: 'Rhetoric',
                properties: {
                    name: r,
                    description: RHETORIC_DESCRIPTIONS[r] ?? null,
                },
            })
        }

        // 7. Poem 节点（最后构建，截断时优先丢失）
        for (const poem of SEED_POEMS_FULL) {
            addNode({
                id: poem.id,
                label: poem.title,
                type: 'Poem',
                properties: {
                    id: poem.id,
                    title: poem.title,
                    poet: poem.poet,
                    dynasty: poem.dynasty,
                    content: poem.content,
                    difficulty: poem.difficulty,
                    gradeLevel: poem.gradeLevel,
                },
            })
        }

        // 8. 截断：仅在总数超过 limit 时保留前 limit 个节点
        //    节点构建顺序已按"Era → Poet → Image → Theme → Rhetoric → Poem"排列，
        //    Poem 排在最后，截断时优先丢失。
        if (nodes.length > limit) {
            const truncated = nodes.slice(0, limit)
            nodes.length = 0
            nodes.push(...truncated)
            // 重建 seenIds 以保证边过滤一致性
            seenIds.clear()
            for (const n of nodes) seenIds.add(n.id)
        }

        // 9. 构建边
        const edges: GraphEdge[] = []
        const edgeSeen = new Set<string>()
        const addEdge = (
            source: string,
            target: string,
            type: string,
            weight: number = 1,
            evidence?: string[],
            note?: string,
        ): void => {
            if (!source || !target) return
            // 仅返回两端节点均在截断后节点集合中的边
            if (!seenIds.has(source) || !seenIds.has(target)) return
            const key = `${source}|${target}|${type}`
            if (edgeSeen.has(key)) return
            edgeSeen.add(key)
            edges.push({
                source,
                target,
                type,
                weight,
                confidence: defaultConfidenceFor(type),
                evidence,
                note,
            })
        }

        // 9.1 构建 poet 名 → poet id 索引（MENTORS 与 WROTE 边按名匹配）
        const poetNameToId = new Map<string, string>()
        for (const poet of SEED_POETS_FULL) {
            poetNameToId.set(poet.name, poet.id)
        }

        // 9.2 WROTE: Poet → Poem
        for (const poem of SEED_POEMS_FULL) {
            const poetId = poetNameToId.get(poem.poet)
            if (poetId) {
                addEdge(poetId, poem.id, 'WROTE')
            }
        }

        // 9.3 OF_ERA: Poem → Era（按 dynasty 名匹配）
        for (const poem of SEED_POEMS_FULL) {
            addEdge(poem.id, poem.dynasty, 'OF_ERA')
        }

        // 9.4 USES_IMAGE: Poem → Image
        for (const poem of SEED_POEMS_FULL) {
            for (const img of poem.images) {
                addEdge(poem.id, img, 'USES_IMAGE')
            }
        }

        // 9.5 EXPRESSES_THEME: Poem → Theme
        for (const poem of SEED_POEMS_FULL) {
            for (const theme of poem.themes) {
                addEdge(poem.id, theme, 'EXPRESSES_THEME')
            }
        }

        // 9.6 USES_RHETORIC: Poem → Rhetoric
        for (const poem of SEED_POEMS_FULL) {
            for (const r of poem.rhetoric) {
                addEdge(poem.id, r, 'USES_RHETORIC')
            }
        }

        // 9.7 MENTORS: Poet → Poet（从 SEED_MENTORSHIPS_FULL 按 mentor/mentee 名匹配）
        for (const m of SEED_MENTORSHIPS_FULL) {
            const mentorId = poetNameToId.get(m.mentor)
            const menteeId = poetNameToId.get(m.mentee)
            if (mentorId && menteeId) {
                addEdge(mentorId, menteeId, 'MENTORS', 1, undefined, m.note)
            }
        }

        // 9.8 Poem-Poem 三种关联（SHARES_IMAGE / SIMILAR_THEME / BORROWS_RHETORIC）
        //     约定 p1.id < p2.id（与 Neo4j 写入逻辑一致，避免双向边）
        const poemsList = SEED_POEMS_FULL
        for (let i = 0; i < poemsList.length; i++) {
            const p1 = poemsList[i]
            if (!p1) continue
            for (let j = i + 1; j < poemsList.length; j++) {
                const p2 = poemsList[j]
                if (!p2) continue
                // 确保 p1.id < p2.id（字符串字典序）
                if (p1.id >= p2.id) continue

                // SHARES_IMAGE：共享至少 1 个意象，weight = 共享数量
                const sharedImages = p1.images.filter((img) => p2.images.includes(img))
                if (sharedImages.length > 0) {
                    addEdge(p1.id, p2.id, 'SHARES_IMAGE', sharedImages.length, sharedImages)
                }

                // SIMILAR_THEME：Jaccard 相似度 > 0，weight = jaccard 分数
                const sharedThemes = p1.themes.filter((t) => p2.themes.includes(t))
                if (sharedThemes.length > 0) {
                    const unionSize = new Set([...p1.themes, ...p2.themes]).size
                    const jaccard = unionSize > 0 ? sharedThemes.length / unionSize : 0
                    addEdge(p1.id, p2.id, 'SIMILAR_THEME', jaccard, sharedThemes)
                }

                // BORROWS_RHETORIC：共享至少 1 个修辞，weight = 共享数量
                const sharedRhetoric = p1.rhetoric.filter((r) => p2.rhetoric.includes(r))
                if (sharedRhetoric.length > 0) {
                    addEdge(p1.id, p2.id, 'BORROWS_RHETORIC', sharedRhetoric.length, sharedRhetoric)
                }
            }
        }

        return { nodes, edges }
    }

    /**
     * Neo4j 不可用时，从内存种子数据计算指定诗的关联诗。
     *
     * 复用 buildInMemoryGraph 中的边推导逻辑，但仅返回与指定 poemId 相邻的
     * SHARES_IMAGE / SIMILAR_THEME / BORROWS_RHETORIC 三种推断类边。
     *
     * @param poemId 中心诗 ID
     * @param limit 返回数量上限
     */
    private findRelatedPoemsInMemory(poemId: string, limit: number): RelatedPoem[] {
        const seedPoem = this.findSeedPoem(poemId)
        if (!seedPoem) return []

        const related: RelatedPoem[] = []
        for (const other of SEED_POEMS_FULL) {
            if (other.id === poemId) continue

            // SHARES_IMAGE
            const sharedImages = seedPoem.images.filter((img) => other.images.includes(img))
            if (sharedImages.length > 0) {
                related.push({
                    poem: this.toPoemNode({}, other),
                    relationType: 'SHARES_IMAGE',
                    strength: sharedImages.length,
                    confidence: defaultConfidenceFor('SHARES_IMAGE'),
                })
            }

            // SIMILAR_THEME (Jaccard > 0)
            const sharedThemes = seedPoem.themes.filter((t) => other.themes.includes(t))
            if (sharedThemes.length > 0) {
                const unionSize = new Set([...seedPoem.themes, ...other.themes]).size
                const jaccard = unionSize > 0 ? sharedThemes.length / unionSize : 0
                related.push({
                    poem: this.toPoemNode({}, other),
                    relationType: 'SIMILAR_THEME',
                    strength: jaccard,
                    confidence: defaultConfidenceFor('SIMILAR_THEME'),
                })
            }

            // BORROWS_RHETORIC
            const sharedRhetoric = seedPoem.rhetoric.filter((r) => other.rhetoric.includes(r))
            if (sharedRhetoric.length > 0) {
                related.push({
                    poem: this.toPoemNode({}, other),
                    relationType: 'BORROWS_RHETORIC',
                    strength: sharedRhetoric.length,
                    confidence: defaultConfidenceFor('BORROWS_RHETORIC'),
                })
            }
        }

        // 按 strength 降序排序，取前 limit 个（与 Cypher ORDER BY strength DESC LIMIT 一致）
        related.sort((a, b) => b.strength - a.strength)
        return related.slice(0, limit)
    }

    // ─────────────────────────────────────────────────────────
    // 8 个公开查询方法
    // ─────────────────────────────────────────────────────────

    /**
     * 1. 按诗找关联（同意象/同主题/同修辞的诗）
     *
     * Cypher:
     *   MATCH (p:Poem {id: $id})-[r:SHARES_IMAGE|SIMILAR_THEME|BORROWS_RHETORIC]-(related:Poem)
     *   RETURN related, type(r) AS relType,
     *          CASE type(r)
     *            WHEN 'SHARES_IMAGE' THEN r.count
     *            WHEN 'SIMILAR_THEME' THEN r.score
     *            WHEN 'BORROWS_RHETORIC' THEN r.count
     *          END AS strength
     *   ORDER BY strength DESC LIMIT $limit
     */
    async findRelatedPoems(poemId: string, limit = 10): Promise<RelatedPoem[]> {
        // Neo4j 不可用时降级到内存计算（不调用 safeRead 以避免返回空数组）
        if (!this.connected) {
            return this.findRelatedPoemsInMemory(poemId, limit)
        }
        return this.safeRead<RelatedPoem[]>([], async (session) => {
            const result = await session.run(
                `MATCH (p:Poem {id: $poemId})-[r:SHARES_IMAGE|SIMILAR_THEME|BORROWS_RHETORIC]-(related:Poem)
                 WHERE related.id <> $poemId
                 RETURN related.id AS poemId,
                        type(r) AS relType,
                        CASE type(r)
                          WHEN 'SHARES_IMAGE' THEN toFloat(r.count)
                          WHEN 'SIMILAR_THEME' THEN toFloat(r.score)
                          WHEN 'BORROWS_RHETORIC' THEN toFloat(r.count)
                        END AS strength
                 ORDER BY strength DESC
                 LIMIT $limit`,
                { poemId, limit: neo4j.int(limit) },
            )

            const related: RelatedPoem[] = []
            for (const record of result.records) {
                const id = record.get('poemId') as string
                const relType = record.get('relType') as
                    | 'SHARES_IMAGE'
                    | 'SIMILAR_THEME'
                    | 'BORROWS_RHETORIC'
                const strength = record.get('strength') as number
                const seedPoem = this.findSeedPoem(id)
                if (!seedPoem) continue
                related.push({
                    poem: this.toPoemNode({}, seedPoem),
                    relationType: relType,
                    strength,
                    // 这三种关系均为算法推导，confidence 恒为 INFERRED
                    confidence: defaultConfidenceFor(relType),
                })
            }
            return related
        })
    }

    /**
     * 2. 按主题找诗
     */
    async findPoemsByTheme(theme: string): Promise<PoemNode[]> {
        return this.safeRead<PoemNode[]>([], async (session) => {
            const result = await session.run(
                `MATCH (poem:Poem)-[:EXPRESSES_THEME]->(t:Theme {name: $theme})
                 RETURN poem.id AS poemId
                 ORDER BY poem.difficulty ASC`,
                { theme },
            )
            return result.records
                .map((r) => r.get('poemId') as string)
                .map((id) => this.findSeedPoem(id))
                .filter((p): p is SeedPoem => p !== undefined)
                .map((p) => this.toPoemNode({}, p))
        })
    }

    /**
     * 3. 按意象找诗
     */
    async findPoemsByImage(image: string): Promise<PoemNode[]> {
        return this.safeRead<PoemNode[]>([], async (session) => {
            const result = await session.run(
                `MATCH (poem:Poem)-[:USES_IMAGE]->(i:Image {name: $image})
                 RETURN poem.id AS poemId
                 ORDER BY poem.difficulty ASC`,
                { image },
            )
            return result.records
                .map((r) => r.get('poemId') as string)
                .map((id) => this.findSeedPoem(id))
                .filter((p): p is SeedPoem => p !== undefined)
                .map((p) => this.toPoemNode({}, p))
        })
    }

    /**
     * 4. 按修辞找诗
     */
    async findPoemsByRhetoric(rhetoric: string): Promise<PoemNode[]> {
        return this.safeRead<PoemNode[]>([], async (session) => {
            const result = await session.run(
                `MATCH (poem:Poem)-[:USES_RHETORIC]->(r:Rhetoric {name: $rhetoric})
                 RETURN poem.id AS poemId
                 ORDER BY poem.difficulty ASC`,
                { rhetoric },
            )
            return result.records
                .map((r) => r.get('poemId') as string)
                .map((id) => this.findSeedPoem(id))
                .filter((p): p is SeedPoem => p !== undefined)
                .map((p) => this.toPoemNode({}, p))
        })
    }

    /**
     * 5. 按诗人找诗
     */
    async findPoemsByPoet(poetName: string): Promise<PoemNode[]> {
        return this.safeRead<PoemNode[]>([], async (session) => {
            const result = await session.run(
                `MATCH (:Poet {name: $poetName})-[:WROTE]->(poem:Poem)
                 RETURN poem.id AS poemId
                 ORDER BY poem.difficulty ASC`,
                { poetName },
            )
            return result.records
                .map((r) => r.get('poemId') as string)
                .map((id) => this.findSeedPoem(id))
                .filter((p): p is SeedPoem => p !== undefined)
                .map((p) => this.toPoemNode({}, p))
        })
    }

    /**
     * 6. 获取诗人师承链
     *
     * 沿 MENTORS 边递归遍历，返回从该诗人向上追溯的所有师法对象。
     */
    async getPoetMentorChain(poetName: string): Promise<PoetNode[]> {
        return this.safeRead<PoetNode[]>([], async (session) => {
            const result = await session.run(
                `MATCH (mentee:Poet {name: $poetName})-[:MENTORS*1..5]->(mentor:Poet)
                 RETURN DISTINCT mentor.id AS id, mentor.name AS name,
                        mentor.dynasty AS dynasty, mentor.birthYear AS birthYear,
                        mentor.deathYear AS deathYear, mentor.style AS style,
                        mentor.brief AS brief`,
                { poetName },
            )
            return result.records.map((r) => ({
                id: String(r.get('id') ?? ''),
                name: String(r.get('name') ?? ''),
                dynasty: String(r.get('dynasty') ?? ''),
                birthYear: r.get('birthYear') ? Number(r.get('birthYear')) : undefined,
                deathYear: r.get('deathYear') ? Number(r.get('deathYear')) : undefined,
                style: r.get('style') ? String(r.get('style')) : undefined,
                brief: r.get('brief') ? String(r.get('brief')) : undefined,
            }))
        })
    }

    /**
     * 7. 获取全图谱（用于前端 D3.js 力导向图渲染）
     *
     * 返回 6 种节点 + 10 种边，默认限制 500 节点。
     *
     * 降级策略：Neo4j 不可用时（!this.connected），从内存种子数据构建完整图谱返回，
     *          保证 DEMO_MODE 下前端 /starmap 页面也能展示 148 首诗 + 63 位诗人 +
     *          朝代 + 意象 + 主题 + 修辞节点及其关系边。
     */
    async getFullGraph(limit = DEFAULT_GRAPH_LIMIT): Promise<GraphData> {
        // Neo4j 不可用时降级到内存图谱（不调用 safeRead 以避免返回空数据）
        if (!this.connected) {
            return this.buildInMemoryGraph(limit)
        }
        return this.safeRead<GraphData>({ nodes: [], edges: [] }, async (session) => {
            // 节点查询：6 种 Label，按 limit 截断
            const nodeResult = await session.run(
                `MATCH (n)
                 WHERE n:Poet OR n:Poem OR n:Image OR n:Theme OR n:Era OR n:Rhetoric
                 RETURN n, labels(n) AS labels
                 LIMIT $limit`,
                { limit: neo4j.int(limit) },
            )

            const nodes: GraphNode[] = []
            const seenIds = new Set<string>()
            for (const record of nodeResult.records) {
                const node = record.get('n') as {
                    properties: Record<string, unknown>
                    labels: string[]
                }
                const labels = record.get('labels') as string[]
                const label = labels[0] ?? 'Poem'
                const props = node.properties
                // 节点业务 ID：Poet/Poem 用 id 字段，Image/Theme/Era/Rhetoric 用 name 字段
                const nodeId =
                    label === 'Poet' || label === 'Poem'
                        ? String(props['id'] ?? '')
                        : String(props['name'] ?? '')

                if (!nodeId || seenIds.has(nodeId)) continue
                seenIds.add(nodeId)

                // 显示标签：Poem 用 title，Poet 用 name，其余用 name
                const displayLabel =
                    label === 'Poem' ? String(props['title'] ?? '') : String(props['name'] ?? '')

                nodes.push({
                    id: nodeId,
                    label: displayLabel,
                    type: label as GraphNode['type'],
                    properties: props as Record<string, unknown>,
                })
            }

            // 边查询：10 种边类型
            const edgeResult = await session.run(
                `MATCH (a)-[r]->(b)
                 WHERE (a:Poet OR a:Poem OR a:Image OR a:Theme OR a:Era OR a:Rhetoric)
                   AND (b:Poet OR b:Poem OR b:Image OR b:Theme OR b:Era OR b:Rhetoric)
                   AND NOT a = b
                 RETURN a, b, type(r) AS relType, r AS rel
             LIMIT $edgeLimit`,
                { edgeLimit: neo4j.int(limit * 12) },
            )

            const edges: GraphEdge[] = []
            const edgeSeen = new Set<string>()
            for (const record of edgeResult.records) {
                const aNode = record.get('a') as { properties: Record<string, unknown>; labels: string[] }
                const bNode = record.get('b') as { properties: Record<string, unknown>; labels: string[] }
                const relType = record.get('relType') as string

                const aLabel = aNode.labels[0] ?? ''
                const bLabel = bNode.labels[0] ?? ''
                const sourceId =
                    aLabel === 'Poet' || aLabel === 'Poem'
                        ? String(aNode.properties['id'] ?? '')
                        : String(aNode.properties['name'] ?? '')
                const targetId =
                    bLabel === 'Poet' || bLabel === 'Poem'
                        ? String(bNode.properties['id'] ?? '')
                        : String(bNode.properties['name'] ?? '')

                if (!sourceId || !targetId) continue
                if (!seenIds.has(sourceId) || !seenIds.has(targetId)) continue

                const edgeKey = `${sourceId}|${targetId}|${relType}`
                if (edgeSeen.has(edgeKey)) continue
                edgeSeen.add(edgeKey)

                // 权重：SHARES_IMAGE 用 count，SIMILAR_THEME 用 score，BORROWS_RHETORIC 用 count，其余 1
                const rel = record.get('rel') as { properties: Record<string, unknown> }
                let weight = 1
                if (relType === 'SHARES_IMAGE' || relType === 'BORROWS_RHETORIC') {
                    weight = Number(rel.properties['count'] ?? 1)
                } else if (relType === 'SIMILAR_THEME') {
                    weight = Number(rel.properties['score'] ?? 1)
                }

                // confidence：优先用边自身写入值，缺失时按边类型映射（EXTRACTED/INFERRED/AMBIGUOUS）
                const confidence = resolveConfidence(rel.properties, relType)
                const evidenceRaw =
                    relType === 'SHARES_IMAGE'
                        ? rel.properties['images']
                        : relType === 'SIMILAR_THEME'
                            ? rel.properties['themes']
                            : relType === 'BORROWS_RHETORIC'
                                ? rel.properties['rhetoric']
                                : undefined
                const evidence = Array.isArray(evidenceRaw)
                    ? evidenceRaw.map(String)
                    : undefined
                const note = typeof rel.properties['note'] === 'string'
                    ? rel.properties['note']
                    : undefined
                edges.push({
                    source: sourceId,
                    target: targetId,
                    type: relType,
                    weight,
                    confidence,
                    evidence,
                    note,
                })
            }

            return { nodes, edges }
        })
    }

    /**
     * 8. 获取诗的邻居子图（用于详情面板）
     *
     * @param depth 跳数，默认 1（直接邻居），最大 3（避免全图扩散）
     */
    async getPoemSubgraph(poemId: string, depth = 1): Promise<GraphData> {
        const safeDepth = Math.max(1, Math.min(3, depth))
        return this.safeRead<GraphData>({ nodes: [], edges: [] }, async (session) => {
            const nodeResult = await session.run(
                `MATCH (center:Poem {id: $poemId})
                 MATCH path = (center)-[*1..${safeDepth}]-(neighbor)
                 UNWIND nodes(path) AS n
                 WITH DISTINCT n
                 WHERE n:Poet OR n:Poem OR n:Image OR n:Theme OR n:Era OR n:Rhetoric
                 RETURN n, labels(n) AS labels
                 LIMIT $limit`,
                { poemId, limit: neo4j.int(DEFAULT_GRAPH_LIMIT) },
            )

            const nodes: GraphNode[] = []
            const seenIds = new Set<string>()
            for (const record of nodeResult.records) {
                const node = record.get('n') as { properties: Record<string, unknown> }
                const labels = record.get('labels') as string[]
                const label = labels[0] ?? 'Poem'
                const props = node.properties
                const nodeId =
                    label === 'Poet' || label === 'Poem'
                        ? String(props['id'] ?? '')
                        : String(props['name'] ?? '')

                if (!nodeId || seenIds.has(nodeId)) continue
                seenIds.add(nodeId)

                const displayLabel =
                    label === 'Poem' ? String(props['title'] ?? '') : String(props['name'] ?? '')

                nodes.push({
                    id: nodeId,
                    label: displayLabel,
                    type: label as GraphNode['type'],
                    properties: props as Record<string, unknown>,
                })
            }

            // 边：仅返回 seenIds 中节点之间的边
            const edgeResult = await session.run(
                `MATCH (center:Poem {id: $poemId})
                 MATCH path = (center)-[*1..${safeDepth}]-(neighbor)
                 UNWIND relationships(path) AS r
                 WITH DISTINCT r
                 MATCH (a)-[r]->(b)
                 RETURN a, b, type(r) AS relType, r AS rel`,
                { poemId },
            )

            const edges: GraphEdge[] = []
            const edgeSeen = new Set<string>()
            for (const record of edgeResult.records) {
                const aNode = record.get('a') as { properties: Record<string, unknown>; labels: string[] }
                const bNode = record.get('b') as { properties: Record<string, unknown>; labels: string[] }
                const relType = record.get('relType') as string

                const aLabel = aNode.labels[0] ?? ''
                const bLabel = bNode.labels[0] ?? ''
                const sourceId =
                    aLabel === 'Poet' || aLabel === 'Poem'
                        ? String(aNode.properties['id'] ?? '')
                        : String(aNode.properties['name'] ?? '')
                const targetId =
                    bLabel === 'Poet' || bLabel === 'Poem'
                        ? String(bNode.properties['id'] ?? '')
                        : String(bNode.properties['name'] ?? '')

                if (!sourceId || !targetId) continue
                if (!seenIds.has(sourceId) || !seenIds.has(targetId)) continue

                const edgeKey = `${sourceId}|${targetId}|${relType}`
                if (edgeSeen.has(edgeKey)) continue
                edgeSeen.add(edgeKey)

                const rel = record.get('rel') as { properties: Record<string, unknown> }
                let weight = 1
                if (relType === 'SHARES_IMAGE' || relType === 'BORROWS_RHETORIC') {
                    weight = Number(rel.properties['count'] ?? 1)
                } else if (relType === 'SIMILAR_THEME') {
                    weight = Number(rel.properties['score'] ?? 1)
                }

                // confidence：优先用边自身写入值，缺失时按边类型映射（EXTRACTED/INFERRED/AMBIGUOUS）
                const confidence = resolveConfidence(rel.properties, relType)
                edges.push({ source: sourceId, target: targetId, type: relType, weight, confidence })
            }

            return { nodes, edges }
        })
    }

    /**
     * 9. 按学生掌握度着色（与 SQLite mastery 表联动）
     *
     * - green：六阶皆通（每阶均 >= 80）
     * - yellow：高阶薄弱（任一高阶层 < 80，但记忆层 >= 60）
     * - red：记忆层卡顿（记忆层 < 60）
     *
     * 仅 Poem 节点会被着色，其余节点无 masteryLevel 字段。
     */
    async getGraphWithMastery(studentId: string): Promise<MasteryGraphData> {
        // 先取全图，再从 SQLite 补 mastery
        const graph = await this.getFullGraph()
        if (graph.nodes.length === 0) {
            return { nodes: [], edges: graph.edges }
        }

        // 动态导入 db（避免循环依赖与启动顺序问题）
        const { db } = await import('../../db/index.js')

        const poemNodes = graph.nodes.filter((n) => n.type === 'Poem')
        const poemIds = poemNodes.map((n) => n.id)

        if (poemIds.length === 0) {
            return { nodes: graph.nodes, edges: graph.edges }
        }

        // 一次性查询该学生在所有相关诗上的六阶掌握度
        const placeholders = poemIds.map(() => '?').join(',')
        const stmt = db.prepare(
            `SELECT poem_id, bloom_level, score
             FROM mastery
             WHERE student_id = ? AND poem_id IN (${placeholders})`,
        )
        const rows = stmt.all(studentId, ...poemIds) as Array<{
            poem_id: string
            bloom_level: string
            score: number
        }>

        // 按 poem_id 聚合六阶
        const masteryMap = new Map<string, BloomMastery>()
        for (const row of rows) {
            const m = masteryMap.get(row.poem_id) ?? {
                记忆: 0,
                理解: 0,
                应用: 0,
                分析: 0,
                评价: 0,
                创造: 0,
            }
            const level = row.bloom_level as BloomLevel
            if (BLOOM_LEVELS.includes(level)) {
                m[level] = row.score
            }
            masteryMap.set(row.poem_id, m)
        }

        // 着色
        const nodesWithMastery: MasteryGraphNode[] = graph.nodes.map((n) => {
            if (n.type !== 'Poem') return n
            const mastery = masteryMap.get(n.id)
            if (!mastery) {
                // 无记录视为未学习，不着色
                return { ...n }
            }
            const masteryLevel = this.classifyMastery(mastery)
            return { ...n, mastery, masteryLevel }
        })

        return { nodes: nodesWithMastery, edges: graph.edges }
    }

    /** 根据六阶掌握度判定颜色等级 */
    private classifyMastery(mastery: BloomMastery): 'green' | 'yellow' | 'red' {
        // red: 记忆层 < 60
        if (mastery['记忆'] < MASTERY_RED_THRESHOLD) {
            return 'red'
        }
        // green: 六阶皆 >= 80
        const allGreen = BLOOM_LEVELS.every((level) => mastery[level] >= MASTERY_GREEN_THRESHOLD)
        if (allGreen) {
            return 'green'
        }
        // yellow: 介于二者之间（高阶薄弱）
        return 'yellow'
    }

    // ─────────────────────────────────────────────────────────
    // 新增查询（spec A2：surprisingConnections / guidedTour）
    // ─────────────────────────────────────────────────────────

    /**
     * 10. surprisingConnections —— 寻找与种子节点"意想不到"的关联候选
     *
     * 启发式（Graphify 范式移植）：
     * - 共同邻居稀少：候选与种子有共同邻居，但共同邻居数 ≤ 2（远房关联）
     * - 跨类型连接：种子与候选属于不同 Label（如 Poem ↔ Poet/Theme/Era）
     * - 排除直接邻居（已有显式边的不再算"意想不到"）
     *
     * @param seed 节点 ID（Poet/Poem 的 id）或名称（Image/Theme/Era/Rhetoric 的 name）
     * @param limit 返回候选数上限，默认 10
     * @returns 候选节点 + plain-English 理由 + confidence（恒 INFERRED，启发式推导）
     */
    async surprisingConnections(seed: string, limit = 10): Promise<SurprisingConnection[]> {
        // 空 seed 直接降级返回空（避免 Cypher 全表扫描）
        if (!seed || seed.trim().length === 0) {
            return []
        }
        return this.safeRead<SurprisingConnection[]>([], async (session) => {
            // 匹配 seed 节点（兼容 id 与 name 两种主键）
            // 候选需满足：与 seed 有共同邻居、且无直接边、共同邻居数 ≤ 2
            const result = await session.run(
                `MATCH (seed)
                 WHERE seed.id = $seed OR seed.name = $seed
                 WITH seed, labels(seed)[0] AS seedType
                 LIMIT 1
                 MATCH (seed)--(common)--(candidate)
                 WHERE candidate <> seed
                   AND NOT (seed)--(candidate)
                 WITH seed, seedType, candidate,
                      count(DISTINCT common) AS commonCount,
                      collect(DISTINCT coalesce(common.title, common.name, common.id)) AS commonNames,
                      labels(candidate)[0] AS candType
                 WHERE commonCount <= 2
                 RETURN coalesce(candidate.id, candidate.name) AS candId,
                        coalesce(candidate.title, candidate.name) AS candLabel,
                        candType,
                        commonCount,
                        commonNames,
                        seedType
                 ORDER BY commonCount ASC
                 LIMIT $limit`,
                { seed, limit: neo4j.int(limit) },
            )

            const connections: SurprisingConnection[] = []
            for (const record of result.records) {
                const candId = record.get('candId')
                const candLabel = record.get('candLabel')
                const candType = record.get('candType') as string | null
                const commonCount = Number(record.get('commonCount') ?? 0)
                const commonNames = (record.get('commonNames') ?? []) as string[]
                const seedType = record.get('seedType') as string | null

                // 跳过缺失主键的候选
                if (candId === null || candId === undefined) continue
                if (candLabel === null || candLabel === undefined) continue
                if (!candType || !seedType) continue

                const heuristic: SurprisingConnection['heuristic'] =
                    candType !== seedType ? 'cross-type' : 'sparse-common'

                // plain-English 理由
                const commonText =
                    commonNames.length > 0 ? commonNames.join('、') : '无显式记录'
                const reason =
                    heuristic === 'cross-type'
                        ? `${seedType} 与 ${candType} 跨类型关联：仅通过 ${commonCount} 个共同邻居（${commonText}）连接，是意想不到的远房关联`
                        : `${candType}「${candLabel}」与种子仅有 ${commonCount} 个共同邻居（${commonText}），属稀疏关联，值得探索`

                connections.push({
                    node: {
                        id: String(candId),
                        label: String(candLabel),
                        type: candType as GraphNode['type'],
                    },
                    reason,
                    commonNeighbors: commonNames,
                    commonCount,
                    heuristic,
                    seedType,
                    // 启发式推导，恒为 INFERRED
                    confidence: 'INFERRED',
                })
            }
            return connections
        })
    }

    /**
     * 11. guidedTour —— 按主题生成依赖排序的导览序列
     *
     * 算法：
     * 1. 复用 findPoemsByTheme 拿到该主题下所有诗（天然继承降级）
     * 2. 按难度升序排序（同难度按 gradeLevel 稳定排序）
     * 3. 对每步生成 plain-English 解释：
     *    - 首步：标注入门价值
     *    - 中间：标注与上一步的共享意象/修辞，作为认知脚手架
     *    - 末步：标注挑战价值
     *
     * @param topic 主题名（如"思乡"）
     * @returns 按依赖排序的诗节点序列 + 每步解释 + confidence（恒 INFERRED）
     */
    async guidedTour(topic: string): Promise<GuidedTourStep[]> {
        // 复用现有查询，天然降级（Neo4j 不可用时 findPoemsByTheme 返回 []）
        const poems = await this.findPoemsByTheme(topic)
        if (poems.length === 0) {
            return []
        }

        // 按 difficulty 升序；同难度保持稳定排序（JS sort 稳定，ES2019+）
        const sorted = [...poems].sort(
            (a, b) => (a.difficulty ?? 3) - (b.difficulty ?? 3),
        )

        const steps: GuidedTourStep[] = []
        for (let i = 0; i < sorted.length; i++) {
            const poem = sorted[i]
            if (!poem) continue
            const stepNo = i + 1
            const isLast = i === sorted.length - 1
            const isFirst = i === 0
            const prev = i > 0 ? sorted[i - 1] : undefined

            const seedPoem = this.findSeedPoem(poem.id)
            const prevSeed = prev ? this.findSeedPoem(prev.id) : undefined

            const explanation = this.buildTourExplanation(
                topic,
                poem.title,
                poem.difficulty,
                stepNo,
                sorted.length,
                isFirst,
                isLast,
            )
            const linkToPrevious = prev
                ? this.buildTourLink(prev, seedPoem, prevSeed)
                : undefined

            steps.push({
                step: stepNo,
                poem,
                explanation,
                linkToPrevious,
                // 依赖排序是启发式推导，恒为 INFERRED
                confidence: 'INFERRED',
            })
        }
        return steps
    }

    /** 生成单步导览解释 */
    private buildTourExplanation(
        topic: string,
        title: string,
        difficulty: number | undefined,
        stepNo: number,
        total: number,
        isFirst: boolean,
        isLast: boolean,
    ): string {
        const d = difficulty ?? 3
        if (isFirst) {
            return `从《${title}》开始（第 ${stepNo}/${total} 步，难度 ${d}）：这是「${topic}」主题下难度最低的入门诗，建议先建立基础意象认知。`
        }
        if (isLast) {
            return `最后是《${title}》（第 ${stepNo}/${total} 步，难度 ${d}）：这是该主题最具挑战的诗，建议在巩固前序后研读以深化理解。`
        }
        return `继续《${title}》（第 ${stepNo}/${total} 步，难度 ${d}）：作为进阶，承接前一步的认知脚手架逐步加深。`
    }

    /** 生成与上一步的关联说明（共享意象 / 共享修辞 / 同主题） */
    private buildTourLink(
        prev: PoemNode,
        currSeed?: SeedPoem,
        prevSeed?: SeedPoem,
    ): string {
        const sharedImages =
            currSeed && prevSeed
                ? currSeed.images.filter((img) => prevSeed.images.includes(img))
                : []
        const sharedRhetoric =
            currSeed && prevSeed
                ? currSeed.rhetoric.filter((r) => prevSeed.rhetoric.includes(r))
                : []

        if (sharedImages.length > 0) {
            return `与上一步《${prev.title}》共享意象：${sharedImages.join('、')}`
        }
        if (sharedRhetoric.length > 0) {
            return `与上一步《${prev.title}》共享修辞：${sharedRhetoric.join('、')}`
        }
        return `与上一步《${prev.title}》同主题承接，无直接意象/修辞重叠，可对比体察表达差异`
    }
}
