/**
 * 资源调度服务（智能备课 · 能力 5）
 *
 * 根据教案自动推荐相关资源，按相关度排序：
 * 1. 相关诗歌 —— 基于知识图谱关联（同主题/同意象/同作者/同体裁）
 * 2. 文化背景资料 —— 诗人背景、时代背景、文化常识
 * 3. 意象图谱 —— 核心意象的可视化解读
 * 4. 历史课堂录像引用 —— 相似教案的授课记录
 * 5. 学生预习材料 —— 课前自学清单
 *
 * 设计要点：
 * - 相关度评分 0-1，综合考虑主题/意象/体裁/作者多维度
 * - 资源类型分桶，每类推荐 3-5 条，避免单一类型过载
 * - 缓存推荐结果到 SQLite，避免重复计算
 */

import { db, repos } from '../../db/index.js'
import { SqliteMap } from '../../db/runtime-store.js'
import { computeGenre, computeSubject, searchPoems } from './poem-search.js'
import type { PoemEntity } from '../../db/types.js'
import type { BloomLevel } from '../../agents/base/types.js'

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** 资源类型 */
export type ResourceType =
    | 'related-poem'
    | 'cultural-background'
    | 'imagery-graph'
    | 'classroom-recording'
    | 'preview-material'

/** 资源项 */
export interface ResourceItem {
    /** 资源 ID */
    id: string
    /** 资源类型 */
    type: ResourceType
    /** 资源标题 */
    title: string
    /** 资源描述 */
    description: string
    /** 相关度评分 0-1 */
    relevanceScore: number
    /** 关联理由（为什么推荐此资源） */
    relevanceReason: string
    /** 资源元数据 */
    metadata: {
        /** 作者/来源 */
        source?: string
        /** 朝代 */
        dynasty?: string
        /** 资源 URL（若有） */
        url?: string
        /** 资源时长/字数等量纲 */
        duration?: string
        /** 适用 Bloom 层级 */
        bloomLevels?: BloomLevel[]
        /** 适用年级 */
        gradeLevel?: string
    }
}

/** 资源调度响应 */
export interface LessonResourcesResponse {
    /** 教案 ID */
    lessonId: string
    /** 诗歌 ID */
    poemId: string
    /** 推荐资源列表（按相关度降序） */
    resources: ResourceItem[]
    /** 各类资源统计 */
    stats: Record<ResourceType, number>
    /** 生成时间 */
    generatedAt: number
}

// ─────────────────────────────────────────────────────────────
// 资源缓存
// ─────────────────────────────────────────────────────────────

const resourceCache = new SqliteMap<string, LessonResourcesResponse>({
    table: 'lesson_resources_cache',
    indexes: [{ name: 'poem_id', extract: (v) => v.poemId }],
    maxSize: 500,
})

function ensureResourceCacheTable(): void {
    db.prepare(`
        CREATE TABLE IF NOT EXISTS lesson_resources_cache (
            key         TEXT PRIMARY KEY NOT NULL,
            value       TEXT NOT NULL,
            poem_id     TEXT,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        )
    `).run()
    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_lesson_resources_cache_poem_id ON lesson_resources_cache(poem_id)`,
    ).run()
}

ensureResourceCacheTable()

// ─────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────

/**
 * 获取教案推荐资源
 *
 * @param lessonId 教案 ID
 * @param poemId 诗歌 ID
 */
export async function getLessonResources(
    lessonId: string,
    poemId: string,
): Promise<LessonResourcesResponse> {
    // 检查缓存
    const cacheKey = `${lessonId}:${poemId}`
    const cached = resourceCache.get(cacheKey)
    if (cached) {
        return cached
    }

    const poem = repos.poems.findById(poemId)
    if (!poem) {
        throw new Error(`诗歌不存在: ${poemId}`)
    }

    const resources: ResourceItem[] = []

    // 1. 相关诗歌推荐
    const relatedPoems = await findRelatedPoems(poem)
    resources.push(...relatedPoems)

    // 2. 文化背景资料
    const culturalResources = findCulturalBackgroundResources(poem)
    resources.push(...culturalResources)

    // 3. 意象图谱
    const imageryResources = findImageryGraphResources(poem)
    resources.push(...imageryResources)

    // 4. 历史课堂录像引用
    const recordingResources = findClassroomRecordings(poem)
    resources.push(...recordingResources)

    // 5. 学生预习材料
    const previewResources = findPreviewMaterials(poem)
    resources.push(...previewResources)

    // 按相关度降序排序
    resources.sort((a, b) => b.relevanceScore - a.relevanceScore)

    // 统计
    const stats = computeStats(resources)

    const response: LessonResourcesResponse = {
        lessonId,
        poemId,
        resources,
        stats,
        generatedAt: Date.now(),
    }

    // 缓存
    resourceCache.set(cacheKey, response)

    return response
}

// ─────────────────────────────────────────────────────────────
// 内部函数：各类资源查找
// ─────────────────────────────────────────────────────────────

/**
 * 查找相关诗歌
 *
 * 维度：
 * - 同作者（relevanceScore +0.30）
 * - 同主题（relevanceScore +0.25）
 * - 同意象（relevanceScore +0.20）
 * - 同体裁（relevanceScore +0.15）
 * - 同朝代（relevanceScore +0.10）
 */
async function findRelatedPoems(target: PoemEntity): Promise<ResourceItem[]> {
    const results: ResourceItem[] = []
    const targetGenre = computeGenre(target.content)
    const targetSubjects = computeSubject(target.theme)

    // 同作者诗歌
    const samePoetPoems = repos.poems.findByPoet(target.poet)
    for (const poem of samePoetPoems) {
        if (poem.id === target.id) continue
        results.push({
            id: `related-poem:${poem.id}`,
            type: 'related-poem',
            title: `《${poem.title}》`,
            description: `${poem.poet}·${poem.dynasty}：${poem.content.slice(0, 50)}${poem.content.length > 50 ? '...' : ''}`,
            relevanceScore: 0.85,
            relevanceReason: `同为${poem.poet}作品，便于对比诗人的创作风格`,
            metadata: {
                source: poem.poet,
                dynasty: poem.dynasty,
                bloomLevels: ['理解', '分析', '评价'],
                gradeLevel: poem.gradeLevel ?? undefined,
            },
        })
    }

    // 同主题/同意象诗歌（使用 searchPoems 检索）
    for (const subject of targetSubjects.slice(0, 2)) {
        try {
            const searchResults = await searchPoems({
                subject,
                limit: 3,
            })
            for (const result of searchResults) {
                if (result.poem.id === target.id) continue
                // 避免重复
                if (results.some((r) => r.id === `related-poem:${result.poem.id}`)) continue

                const reasons: string[] = []
                let score = 0.4

                if (result.poem.theme.some((t) => target.theme.includes(t))) {
                    reasons.push('同主题')
                    score += 0.2
                }
                if (result.poem.images.some((i) => target.images.includes(i))) {
                    reasons.push('同意象')
                    score += 0.15
                }
                if (result.genre === targetGenre) {
                    reasons.push('同体裁')
                    score += 0.1
                }
                if (result.poem.dynasty === target.dynasty) {
                    reasons.push('同朝代')
                    score += 0.05
                }

                results.push({
                    id: `related-poem:${result.poem.id}`,
                    type: 'related-poem',
                    title: `《${result.poem.title}》`,
                    description: `${result.poem.poet}·${result.poem.dynasty}：${result.poem.content.slice(0, 50)}${result.poem.content.length > 50 ? '...' : ''}`,
                    relevanceScore: Math.min(score, 0.95),
                    relevanceReason: reasons.length > 0 ? `${reasons.join('、')}，可作为对比阅读材料` : '主题相关',
                    metadata: {
                        source: result.poem.poet,
                        dynasty: result.poem.dynasty,
                        bloomLevels: ['理解', '分析', '评价'],
                        gradeLevel: result.poem.gradeLevel ?? undefined,
                    },
                })
            }
        } catch {
            // 检索失败忽略
        }
    }

    return results.slice(0, 5)
}

/**
 * 查找文化背景资料
 */
function findCulturalBackgroundResources(poem: PoemEntity): ResourceItem[] {
    const resources: ResourceItem[] = []

    // 诗人背景
    resources.push({
        id: `cultural:poet:${poem.poet}`,
        type: 'cultural-background',
        title: `${poem.poet}生平与创作背景`,
        description: `${poem.dynasty}代诗人${poem.poet}的生平经历、创作风格与代表作品介绍`,
        relevanceScore: 0.90,
        relevanceReason: '了解作者生平有助于理解诗歌创作动机',
        metadata: {
            source: '系统文化资料库',
            dynasty: poem.dynasty,
            bloomLevels: ['理解', '分析'],
        },
    })

    // 时代背景
    resources.push({
        id: `cultural:era:${poem.dynasty}`,
        type: 'cultural-background',
        title: `${poem.dynasty}代社会文化背景`,
        description: `${poem.dynasty}代的政治、经济、文化特征，及对诗歌创作的影响`,
        relevanceScore: 0.75,
        relevanceReason: '时代背景是理解诗歌情感的重要维度',
        metadata: {
            source: '系统文化资料库',
            dynasty: poem.dynasty,
            bloomLevels: ['理解', '评价'],
        },
    })

    // 体裁知识
    const genre = computeGenre(poem.content)
    resources.push({
        id: `cultural:genre:${genre}`,
        type: 'cultural-background',
        title: `${genre}知识普及`,
        description: `${genre}的格律特点、发展演变与经典作品赏析`,
        relevanceScore: 0.70,
        relevanceReason: '掌握体裁特征有助于鉴赏诗歌的形式美',
        metadata: {
            source: '系统文化资料库',
            bloomLevels: ['理解', '分析'],
        },
    })

    // 题材知识
    const subjects = computeSubject(poem.theme)
    if (subjects.length > 0 && subjects[0] !== '其他') {
        resources.push({
            id: `cultural:subject:${subjects[0]}`,
            type: 'cultural-background',
            title: `${subjects[0]}诗专题`,
            description: `${subjects[0]}题材诗歌的发展脉络、代表作品与鉴赏要点`,
            relevanceScore: 0.65,
            relevanceReason: '题材知识帮助建立诗歌间的横向联系',
            metadata: {
                source: '系统文化资料库',
                bloomLevels: ['分析', '评价'],
            },
        })
    }

    return resources
}

/**
 * 查找意象图谱资源
 */
function findImageryGraphResources(poem: PoemEntity): ResourceItem[] {
    const resources: ResourceItem[] = []

    // 为每个核心意象生成图谱推荐
    const coreImages = poem.images.slice(0, 3)
    for (const image of coreImages) {
        resources.push({
            id: `imagery:${image}`,
            type: 'imagery-graph',
            title: `"${image}"意象图谱`,
            description: `"${image}"意象在古典诗词中的演变、文化内涵与相关诗作关联图`,
            relevanceScore: 0.80,
            relevanceReason: `"${image}"是本诗核心意象，图谱展示其文化内涵与跨诗关联`,
            metadata: {
                source: '系统意象图谱库',
                bloomLevels: ['分析', '评价', '创造'],
            },
        })
    }

    // 整体意象网络
    if (poem.images.length > 1) {
        resources.push({
            id: `imagery:network:${poem.id}`,
            type: 'imagery-graph',
            title: `《${poem.title}》意象网络图`,
            description: `本诗所有意象的关联网络，展示意象间的组合关系与情感指向`,
            relevanceScore: 0.85,
            relevanceReason: '意象网络图帮助理解诗歌的整体意境构建',
            metadata: {
                source: '系统意象图谱库',
                bloomLevels: ['分析', '评价'],
            },
        })
    }

    return resources
}

/**
 * 查找历史课堂录像引用
 */
function findClassroomRecordings(poem: PoemEntity): ResourceItem[] {
    const resources: ResourceItem[] = []

    // 查询历史授课记录（lessons 表中相同 poemId 的记录）
    try {
        const rows = db.prepare(`
            SELECT l.id, l.class_id, l.scheduled_at, l.status, c.name AS class_name
            FROM lessons l
            LEFT JOIN classes c ON l.class_id = c.id
            WHERE l.poem_id = ?
            ORDER BY l.scheduled_at DESC
            LIMIT 3
        `).all(poem.id) as Array<{
            id: string
            class_id: string | null
            scheduled_at: number | null
            status: string
            class_name: string | null
        }>

        for (const row of rows) {
            const date = row.scheduled_at
                ? new Date(row.scheduled_at).toLocaleDateString('zh-CN')
                : '未排课'
            resources.push({
                id: `recording:${row.id}`,
                type: 'classroom-recording',
                title: `《${poem.title}》授课记录 · ${row.class_name ?? '未命名班级'}`,
                description: `${date} 授课 · 状态：${row.status === 'completed' ? '已完成' : row.status === 'ongoing' ? '进行中' : '已计划'}`,
                relevanceScore: 0.70,
                relevanceReason: '历史授课记录可参考教学设计与课堂反馈',
                metadata: {
                    source: row.class_name ?? '系统',
                    duration: '40分钟',
                    bloomLevels: ['理解', '应用', '分析'],
                },
            })
        }
    } catch {
        // lessons 表可能不存在或无数据
    }

    // 若无历史记录，添加通用推荐
    if (resources.length === 0) {
        resources.push({
            id: 'recording:demo',
            type: 'classroom-recording',
            title: `《${poem.title}》优秀课例参考`,
            description: '同名诗歌的优秀课堂教学视频片段，含导入、讲解、互动环节',
            relevanceScore: 0.55,
            relevanceReason: '优秀课例可借鉴教学手法与活动设计',
            metadata: {
                source: '系统课例库',
                duration: '15-20分钟片段',
                bloomLevels: ['理解', '应用'],
            },
        })
    }

    return resources
}

/**
 * 查找学生预习材料
 */
function findPreviewMaterials(poem: PoemEntity): ResourceItem[] {
    const resources: ResourceItem[] = []

    // 生字词预习单
    resources.push({
        id: `preview:words:${poem.id}`,
        type: 'preview-material',
        title: `《${poem.title}》生字词预习单`,
        description: '诗中生字词的拼音、笔顺、组词，含听写练习',
        relevanceScore: 0.85,
        relevanceReason: '课前预习生字词，提升课堂识字环节效率',
        metadata: {
            source: '系统预习材料库',
            duration: '10分钟',
            bloomLevels: ['记忆'],
            gradeLevel: poem.gradeLevel ?? undefined,
        },
    })

    // 朗读音频
    resources.push({
        id: `preview:audio:${poem.id}`,
        type: 'preview-material',
        title: `《${poem.title}》范读音频`,
        description: '专业朗诵者的范读音频，含节奏标注与情感处理提示',
        relevanceScore: 0.80,
        relevanceReason: '课前听范读，建立对诗歌节奏与情感的初步感知',
        metadata: {
            source: '系统音频库',
            duration: '2-3分钟',
            bloomLevels: ['记忆', '理解'],
        },
    })

    // 作者简介
    resources.push({
        id: `preview:author:${poem.poet}`,
        type: 'preview-material',
        title: `${poem.poet}简介（学生版）`,
        description: `适合学生阅读的${poem.poet}生平简介，含趣事与代表作`,
        relevanceScore: 0.70,
        relevanceReason: '课前了解作者，拉近学生与诗歌的距离',
        metadata: {
            source: '系统预习材料库',
            duration: '5分钟阅读',
            bloomLevels: ['记忆', '理解'],
        },
    })

    // 译文参考
    if (poem.annotation) {
        resources.push({
            id: `preview:translation:${poem.id}`,
            type: 'preview-material',
            title: `《${poem.title}》白话译文`,
            description: '诗的白话翻译，含重点字词注释',
            relevanceScore: 0.75,
            relevanceReason: '课前预习译文，降低课堂理解难度',
            metadata: {
                source: '系统预习材料库',
                duration: '5分钟阅读',
                bloomLevels: ['理解'],
                gradeLevel: poem.gradeLevel ?? undefined,
            },
        })
    }

    // 思考题
    resources.push({
        id: `preview:thinking:${poem.id}`,
        type: 'preview-material',
        title: `《${poem.title}》课前思考题`,
        description: '3-5 个启发性问题，引导学生课前思考',
        relevanceScore: 0.65,
        relevanceReason: '前置思考题激活学生已有经验，为课堂讨论做准备',
        metadata: {
            source: '系统预习材料库',
            duration: '10分钟',
            bloomLevels: ['理解', '应用', '分析'],
        },
    })

    return resources
}

/**
 * 计算各类型资源统计
 */
function computeStats(resources: ResourceItem[]): Record<ResourceType, number> {
    const stats: Record<ResourceType, number> = {
        'related-poem': 0,
        'cultural-background': 0,
        'imagery-graph': 0,
        'classroom-recording': 0,
        'preview-material': 0,
    }
    for (const r of resources) {
        stats[r.type]++
    }
    return stats
}
