/**
 * 创新点信息卡（v5.0 Dashboard 数据真实化）
 *
 * 对接 GET /api/dashboard/innovation，TanStack Query 直接消费：
 * - staleTime: 30s
 * - retry: 1
 * - 数据联动：classId 变化触发 refetch
 *
 * 内容结构：
 * 1. 顶部 Header —— eyebrow + 标题 + 副标题 + AIBadge + 刷新按钮
 * 2. 创新指标条 —— 4 个真实指标（AI 调用 / 教案生成 / 智能批改 / 进化之眼）
 * 3. 两大创新点 —— 异构多智能体协作 + 六阶认知模型（静态业务说明）
 *
 * 装饰：
 * - MagicRings 边框流转光韵（speed=4, color=accent-primary）
 * - SVG path + stroke-dashoffset 动画，GPU 友好
 *
 * 设计要点（规范第 2、5、14 章）：
 * - 浅色暖调基底 + 透明度分层，无硬边框
 * - 两栏 grid 桌面 / 单列移动，container queries 自感知
 * - 完整三态：hover 微升 + 阴影扩散
 * - 零 emoji：所有图标由 Phosphor Icon 承载
 * - Tabular Numbers：指标数值等宽对齐
 * - 数据即设计：每个创新点附"技术指标"作为内容承载
 *
 * 加载态：骨架屏
 * 错误态：友好提示 + 重试按钮
 * 空数据态：保留静态创新点描述，仅指标条显示"等待数据"
 */

import { memo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, Icon, AIBadge, Button } from '@/components/ui'
import { Counter } from '@/components/ui/Counter'
import { MagicRings } from '@/components/ui/MagicRings'
import { api } from '@/lib/api'
import type { InnovationData } from '@/lib/types'

interface InnovationCardProps {
    /** 班级 ID（可选，用于数据联动） */
    classId?: string
}

/** 查询 staleTime：30 秒 */
const INNOVATION_STALE_TIME = 30_000

/**
 * accent-primary 设计 token 的 SVG 等价色
 *
 * MagicRings 为 SVG 渲染组件，stroke 属性不解析 CSS 变量字符串，
 * 必须使用 hex 色值。此常量与 --c-accent-primary (#C5853B) 保持同步，
 * 当设计 token 更新时需同步修改此处。
 */
const ACCENT_PRIMARY_HEX = '#C5853B'

/** 两大创新点配置 —— 顺序即展示顺序 */
const INNOVATIONS: ReadonlyArray<{
    id: string
    icon: 'graph' | 'brain'
    title: string
    subtitle: string
    description: string
    metrics: ReadonlyArray<{ label: string; value: string }>
}> = [
    {
        id: 'multi-agent',
        icon: 'graph',
        title: '异构多智能体协作',
        subtitle: 'Heterogeneous Multi-Agent',
        description:
            '编排官 + 诗心 / 诗眼 / 诗笔三大类共 11 个 Agent，按 DAG 拓扑调度，分工覆盖画像、诊断、推荐、验收、视觉标注、语音识别合成、命题、批改、报告、创意全教学链路。',
        metrics: [
            { label: 'Agent 数', value: '11' },
            { label: '协作模式', value: 'DAG 编排' },
            { label: '通信协议', value: 'WS + SSE' },
        ],
    },
    {
        id: 'six-tier',
        icon: 'brain',
        title: '六阶认知模型',
        subtitle: 'Six-Tier Cognitive Model',
        description:
            '基于 Bloom 教育目标分类法修正，对应小学 1-6 年级认知发展规律。每首诗按记忆 / 理解 / 应用 / 分析 / 评价 / 创造六阶命题，实现"一诗六阶、因材施教"的差异化教学。',
        metrics: [
            { label: '认知层级', value: '6 阶' },
            { label: '课标对齐', value: '1-6 年级' },
            { label: '命题覆盖', value: '全诗库' },
        ],
    },
]

/**
 * 创新指标条配置（v5.0 修复字段映射）
 *
 * 后端 /api/dashboard/innovation 返回的 InnovationResponse 结构为：
 * - aiGeneratedContent: { questions, hints, discussions, comments, total }
 * - creationStats: { tasks, works, studentParticipants }
 *
 * 前端通过 getValue 函数从后端实际嵌套字段中提取指标值，
 * 避免字段名不匹配导致 Counter 接收 undefined 崩溃。
 */
interface MetricConfig {
    label: string
    icon: 'sparkle' | 'doc' | 'pen-nib' | 'eye'
    unit?: string
    variant: 'primary' | 'success' | 'warning' | 'info'
    /** 从 InnovationData 提取指标数值（兼容后端嵌套字段结构） */
    getValue: (data: InnovationData) => number
}

const METRICS_CONFIG: MetricConfig[] = [
    {
        label: 'AI 调用',
        icon: 'sparkle',
        unit: '次',
        variant: 'primary',
        getValue: (d) => (d as unknown as { aiGeneratedContent?: { total?: number } })?.aiGeneratedContent?.total ?? 0,
    },
    {
        label: '教案生成',
        icon: 'doc',
        unit: '份',
        variant: 'info',
        getValue: (d) => (d as unknown as { creationStats?: { tasks?: number } })?.creationStats?.tasks ?? 0,
    },
    {
        label: '智能批改',
        icon: 'pen-nib',
        unit: '次',
        variant: 'success',
        getValue: (d) => (d as unknown as { aiGeneratedContent?: { comments?: number } })?.aiGeneratedContent?.comments ?? 0,
    },
    {
        label: '进化之眼',
        icon: 'eye',
        unit: '次',
        variant: 'warning',
        getValue: (d) => (d as unknown as { creationStats?: { works?: number } })?.creationStats?.works ?? 0,
    },
]

export const InnovationCard = memo(function InnovationCard({
    classId,
}: InnovationCardProps) {
    const query = useQuery<InnovationData>({
        queryKey: ['dashboard-v2', 'innovation', classId ?? 'global'],
        queryFn: () => api.dashboardV2.innovation(classId),
        staleTime: INNOVATION_STALE_TIME,
        retry: 1,
        // classId 就绪前不发请求：
        // bloom-radar / alerts / weekly-progress 三个端点强制要求 classId，
        // 未就绪就发会先收 3 个 400，随后再用真实 classId 重发一轮，
        // 既产生无效错误噪音，也让面板内容闪烁一次。
        enabled: Boolean(classId),
    })

    /** 强制刷新 */
    const handleRefresh = useCallback(() => {
        void query.refetch()
    }, [query])

    const data = query.data ?? null

    return (
        <Card className="pr-innovation-card" padding="lg">
            {/* MagicRings 装饰：speed=4, color=accent-primary token 等价色（规范第 6.3 章） */}
            <MagicRings
                speed={4}
                color={ACCENT_PRIMARY_HEX}
                layers={2}
                borderRadius={16}
                className="pr-innovation-rings"
                aria-hidden="true"
            />

            <header className="pr-innovation-header">
                <div className="pr-innovation-header-text">
                    <span className="pr-innovation-eyebrow">
                        <Icon name="sparkle" size={12} />
                        <span>系统创新</span>
                    </span>
                    <h2 className="pr-innovation-title">两大核心创新</h2>
                    <p className="pr-innovation-subtitle">
                        PoeticRealm AI v5.0 在多智能体协作与教育测评两方向深度探索，形成差异化技术壁垒。
                    </p>
                </div>
                <div className="pr-innovation-header-actions">
                    <AIBadge size="sm" />
                    <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Icon name="arrows-clockwise" size={12} />}
                        loading={query.isFetching && !query.isLoading}
                        onClick={handleRefresh}
                        aria-label="刷新创新指标"
                    >
                        刷新
                    </Button>
                </div>
            </header>

            {/* 创新指标条 —— 4 个真实指标 */}
            <InnovationMetrics query={query} data={data} />

            {/* 两大创新点描述 —— 静态业务说明 */}
            <div className="pr-innovation-grid">
                {INNOVATIONS.map((item) => (
                    <article key={item.id} className="pr-innovation-item">
                        <div className="pr-innovation-item-header">
                            <span className="pr-innovation-item-icon">
                                <Icon name={item.icon} size={20} />
                            </span>
                            <div className="pr-innovation-item-title-group">
                                <h3 className="pr-innovation-item-title">{item.title}</h3>
                                <span className="pr-innovation-item-subtitle">{item.subtitle}</span>
                            </div>
                        </div>
                        <p className="pr-innovation-item-desc">{item.description}</p>
                        <dl className="pr-innovation-item-metrics">
                            {item.metrics.map((m) => (
                                <div key={m.label} className="pr-innovation-metric">
                                    <dt className="pr-innovation-metric-label">{m.label}</dt>
                                    <dd className="pr-innovation-metric-value">{m.value}</dd>
                                </div>
                            ))}
                        </dl>
                    </article>
                ))}
            </div>
        </Card>
    )
})

/* ============================================================
 * 创新指标条 —— 4 个真实指标
 * ============================================================ */

interface InnovationMetricsProps {
    query: ReturnType<typeof useQuery<InnovationData>>
    data: InnovationData | null
}

function InnovationMetrics({ query, data }: InnovationMetricsProps) {
    // classId 未就绪时 useQuery 处于 disabled 状态（isLoading 为 false），
    // 用 isPending 统一覆盖「等待班级选定」与「正在请求」两种情况，
    // 使面板在这两种状态下都显示骨架屏，而不是错误地落到空状态分支。
    if (query.isPending) {
        return (
            <div className="pr-innovation-metrics-bar">
                {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="pr-innovation-metric-card pr-innovation-metric-card--skeleton">
                        <div
                            className="pr-skeleton"
                            style={{ height: 12, width: 16, borderRadius: 'var(--radius-xs)' }}
                        />
                        <div
                            className="pr-skeleton"
                            style={{ height: 24, width: '60%', borderRadius: 'var(--radius-sm)' }}
                        />
                        <div
                            className="pr-skeleton"
                            style={{ height: 10, width: 50, borderRadius: 'var(--radius-xs)' }}
                        />
                    </div>
                ))}
            </div>
        )
    }

    if (query.isError) {
        return (
            <div className="pr-innovation-metrics-bar pr-innovation-metrics-bar--error">
                <span className="pr-innovation-metrics-error-icon">
                    <Icon name="warning-circle" size={16} />
                </span>
                <span className="pr-innovation-metrics-error-text">
                    创新指标加载失败
                </span>
                <button
                    type="button"
                    className="pr-innovation-metrics-error-retry"
                    onClick={() => void query.refetch()}
                >
                    重试
                </button>
            </div>
        )
    }

    return (
        <div className="pr-innovation-metrics-bar">
            {METRICS_CONFIG.map((cfg) => {
                const value = data ? cfg.getValue(data) : null
                return (
                    <div
                        key={cfg.label}
                        className={`pr-innovation-metric-card pr-innovation-metric-card--${cfg.variant}`}
                    >
                        <span className="pr-innovation-metric-card-icon">
                            <Icon name={cfg.icon} size={14} />
                        </span>
                        <div className="pr-innovation-metric-card-value-row">
                            {typeof value === 'number' ? (
                                <>
                                    <Counter value={value} />
                                    {cfg.unit && (
                                        <span className="pr-innovation-metric-card-unit">{cfg.unit}</span>
                                    )}
                                </>
                            ) : (
                                <span className="pr-innovation-metric-card-placeholder">—</span>
                            )}
                        </div>
                        <span className="pr-innovation-metric-card-label">{cfg.label}</span>
                    </div>
                )
            })}
        </div>
    )
}
