/**
 * 进化之眼基因谱主页面（规范第 2、5、8、14 章 · SubTask 26.6）
 *
 * 职责：
 *  - 数据加载：并行调用 api.evolution.getGenealogy/getPatterns/getABTests
 *  - 状态托管：loading / loaded / error 三态
 *  - 布局（SubTask 26.6 重构）：
 *      顶层 view 切换：学生成长 / AI 进化
 *      AI 进化 view 内部：
 *        左侧 280px 侧边栏：4 个 Tab（族谱 / A-B测试 / 模式 / 预测）
 *        主区域：根据 Tab 显示 3D 谱系 / 图表 / 列表 / 预测器
 *        浮动 320px 毛玻璃详情面板：仅在族谱 Tab 选中节点时出现
 *  - 联动：选中节点时浮动详情面板展示节点信息
 *  - 降级：DEMO 模式或 API 不可达时显示空态文案，不阻塞页面
 *
 * 设计要点（规范第 2、5、8 章）：
 *  - 松紧得当：Hero 与 Body 之间使用松带（var(--space-xl)）断开
 *  - 流体尺寸：clamp() 控制最小/最大尺寸
 *  - 零硬编码色值：所有色值引用 tokens.css 变量
 *  - 无障碍：完整 ARIA 标签，键盘可达
 *  - 性能：3D 组件懒加载（React.lazy）
 *  - SubTask 26.6：解决"section aside 这么长一条"问题，改为侧边栏 Tab 切换
 */

import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
    GenealogyData,
    PatternItem,
    ABTestResultData,
    GenealogyNode,
    EvolutionPredictionDirection,
    HeatmapStudent,
    StudentProfile3D,
    BloomLevel,
} from '@/lib/types'
import { api } from '@/lib/api'
import { toast } from '@/stores/toast'
import { logError } from '@/lib/errors'
import { Icon } from '@/components/ui/Icon'
import '@/components/ui/icons-extended'
import { Button, Combobox, type ComboboxOption } from '@/components/ui'
import { useClasses } from '@/hooks/useClasses'
import { PatternPanel } from './PatternPanel'
import { ABTestChart } from './ABTestChart'
import { EvolutionPredictor } from './EvolutionPredictor'
import './EvolutionEyePage.css'

/* ============================================================
 * 3D 组件懒加载（Three.js ~600KB 仅按需加载）
 * ============================================================ */

const Genealogy3D = lazy(() =>
    import('./Genealogy3D').then((m) => ({ default: m.Genealogy3D })),
)
// 视角预设类型从 Genealogy3D 引入
type ViewPreset = 'front' | 'side' | 'top'

/* ============================================================
 * 加载状态机
 * ============================================================ */

type LoadStatus = 'loading' | 'loaded' | 'error'

/* ============================================================
 * AI 进化视图 Tab 类型
 * ============================================================ */

type AITabKey = 'genealogy' | 'ab-test' | 'patterns' | 'predict'

interface AITabDef {
    key: AITabKey
    label: string
    icon: string
    hint: string
}

const AI_TABS: AITabDef[] = [
    { key: 'genealogy', label: '族谱', icon: 'graph', hint: '3D 版本谱系' },
    { key: 'ab-test', label: 'A-B测试', icon: 'chart-bar', hint: '候选版本对比' },
    { key: 'patterns', label: '模式', icon: 'sparkle', hint: '进化模式列表' },
    { key: 'predict', label: '预测', icon: 'compass', hint: 'AI 进化预测' },
]

/* ============================================================
 * 接口 —— 页面数据聚合
 * ============================================================ */

interface EvolutionEyePageData {
    genealogy: GenealogyData
    patterns: PatternItem[]
    abTests: ABTestResultData
}

/* ============================================================
 * 骨架屏
 * ============================================================ */

function EvolutionEyeSkeleton() {
    return (
        <div className="evolution-eye-skeleton" aria-busy="true" aria-live="polite">
            <div className="evolution-eye-skeleton__bar" />
            <div className="evolution-eye-skeleton__bar" />
            <div className="evolution-eye-skeleton__bar" />
        </div>
    )
}

const BLOOM_SKILLS: Array<{ level: BloomLevel; x: number; y: number; hint: string }> = [
    { level: '记忆', x: 10, y: 72, hint: '准确识记' },
    { level: '理解', x: 26, y: 44, hint: '解释诗意' },
    { level: '应用', x: 43, y: 68, hint: '迁移运用' },
    { level: '分析', x: 59, y: 35, hint: '拆解关系' },
    { level: '评价', x: 76, y: 60, hint: '判断鉴赏' },
    { level: '创造', x: 91, y: 28, hint: '表达创作' },
]

function StudentEvolutionView() {
    const { classes } = useClasses()
    const [classId, setClassId] = useState('')
    const [students, setStudents] = useState<HeatmapStudent[]>([])
    const [studentId, setStudentId] = useState('')
    const [profile, setProfile] = useState<StudentProfile3D | null>(null)
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        const firstClass = classes[0]
        if (!classId && firstClass) setClassId(firstClass.id)
    }, [classId, classes])

    useEffect(() => {
        if (!classId) return
        let active = true
        setLoading(true)
        api.diagnosis.heatmap(classId)
            .then((result) => {
                if (!active) return
                setStudents(result.students)
                setStudentId((current) =>
                    result.students.some((item) => item.id === current)
                        ? current
                        : (result.students[0]?.id ?? ''),
                )
            })
            .catch((err) => {
                logError('EvolutionEyePage.studentList', err)
                if (active) {
                    setStudents([])
                    setStudentId('')
                }
            })
            .finally(() => {
                if (active) setLoading(false)
            })
        return () => { active = false }
    }, [classId])

    useEffect(() => {
        if (!studentId) {
            setProfile(null)
            return
        }
        let active = true
        setLoading(true)
        api.profile3d.get(studentId)
            .then((result) => {
                if (active) setProfile(result.profile ?? null)
            })
            .catch((err) => {
                logError('EvolutionEyePage.studentProfile', err)
                if (active) setProfile(null)
            })
            .finally(() => {
                if (active) setLoading(false)
            })
        return () => { active = false }
    }, [studentId])

    const evidenceCount = profile?.dimensions.behavior.totalAttempts ?? 0
    const trend = profile?.dimensions.growth.masteryTrend ?? []
    const radar = profile?.dimensions.ability.radar
    const skillPoints = useMemo(() => BLOOM_SKILLS.map((skill) => ({
        ...skill,
        score: radar?.[skill.level] ?? 0,
    })), [radar])
    const trendPoints = useMemo(() => {
        if (trend.length < 2) return ''
        const values = trend.map((item) => item.mastery)
        const min = Math.min(...values)
        const max = Math.max(...values)
        const span = Math.max(1, max - min)
        return trend.map((item, index) => {
            const x = 4 + (index / Math.max(1, trend.length - 1)) * 92
            const y = 88 - ((item.mastery - min) / span) * 72
            return `${x},${y}`
        }).join(' ')
    }, [trend])

    return (
        <section className="student-evolution" aria-label="学生能力进化">
            <header className="student-evolution__toolbar">
                <div>
                    <span className="student-evolution__kicker">真实学情驱动</span>
                    <h2>学生个性化进化树</h2>
                    <p>只使用课堂作答、批改与朗读记录；没有证据的能力不补数、不推测。</p>
                </div>
                <div className="student-evolution__selectors">
                    <label>
                        <span>班级</span>
                        <Combobox
                            value={classId}
                            onChange={(v) => setClassId(v as string)}
                            ariaLabel="班级"
                            placeholder="请选择班级"
                            options={classes.map<ComboboxOption>((item) => ({
                                value: item.id,
                                label: item.name,
                            }))}
                        />
                    </label>
                    <label>
                        <span>学生</span>
                        <Combobox
                            value={studentId}
                            onChange={(v) => setStudentId(v as string)}
                            ariaLabel="学生"
                            placeholder="请选择学生"
                            options={students.map<ComboboxOption>((item) => ({
                                value: item.id,
                                label: item.anonymousName,
                            }))}
                        />
                    </label>
                </div>
            </header>

            {loading && !profile ? <EvolutionEyeSkeleton /> : !studentId ? (
                <div className="student-evolution__empty">
                    <Icon name="student" size={32} />
                    <strong>当前班级还没有可分析的学生</strong>
                    <span>先导入名单，再通过课堂导播台或智能批改台采集学习证据。</span>
                </div>
            ) : evidenceCount === 0 ? (
                <div className="student-evolution__empty">
                    <Icon name="chart-bar" size={32} />
                    <strong>{profile?.anonymousName ?? '该学生'}尚无真实成长记录</strong>
                    <span>完成一次课堂作答或批改后，这里会生成六阶能力分支、成长曲线与下一步建议。</span>
                </div>
            ) : (
                <>
                    <div className="student-evolution__metrics">
                        <div><strong>{profile?.anonymousName}</strong><span>当前学生</span></div>
                        <div><strong>{evidenceCount}</strong><span>有效作答</span></div>
                        <div><strong>{profile?.dimensions.knowledge.learnedPoemCount ?? 0}</strong><span>覆盖诗篇</span></div>
                        <div><strong>{Math.round(profile?.dimensions.knowledge.avgMastery ?? 0)}%</strong><span>真实掌握均值</span></div>
                        <div><strong>{profile?.dimensions.growth.delta?.toFixed(1) ?? '0.0'}</strong><span>30 天变化</span></div>
                    </div>
                    <div className="student-evolution__stage">
                        <div className="student-evolution__skill-map">
                            <div className="student-evolution__section-head">
                                <div><span>能力分化</span><strong>六阶技能网</strong></div>
                                <em>{profile?.dimensions.ability.strongest}最强 · {profile?.dimensions.ability.weakest}待发展</em>
                            </div>
                            <svg viewBox="0 0 100 100" role="img" aria-label="学生六阶技能网络">
                                <defs>
                                    <linearGradient id="student-skill-line" x1="0" x2="1">
                                        <stop offset="0" stopColor="rgb(var(--c-accent-primary))" stopOpacity=".25" />
                                        <stop offset="1" stopColor="rgb(var(--c-accent-info))" stopOpacity=".75" />
                                    </linearGradient>
                                </defs>
                                {skillPoints.slice(0, -1).map((point, index) => {
                                    const next = skillPoints[index + 1]!
                                    return <line key={point.level} x1={point.x} y1={point.y} x2={next.x} y2={next.y} className="student-evolution__branch" />
                                })}
                                {skillPoints.map((point) => (
                                    <g key={point.level} className="student-evolution__node" transform={`translate(${point.x} ${point.y})`}>
                                        <circle r={5 + point.score / 18} style={{ opacity: 0.35 + point.score / 155 }} />
                                        <circle r="3.2" className="student-evolution__node-core" />
                                        <text y="-10" textAnchor="middle">{point.level}</text>
                                        <text y="11" textAnchor="middle" className="student-evolution__score">{Math.round(point.score)}%</text>
                                    </g>
                                ))}
                            </svg>
                        </div>
                        <div className="student-evolution__timeline">
                            <div className="student-evolution__section-head">
                                <div><span>时间证据</span><strong>掌握度成长轨迹</strong></div>
                                <em>{trend.length} 个有效时间点</em>
                            </div>
                            {trend.length < 2 ? (
                                <div className="student-evolution__timeline-empty">至少两次有效测量后显示变化趋势</div>
                            ) : (
                                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="掌握度成长曲线">
                                    <polyline points={trendPoints} />
                                    {trend.map((item, index) => {
                                        const values = trend.map((entry) => entry.mastery)
                                        const min = Math.min(...values)
                                        const max = Math.max(...values)
                                        const x = 4 + (index / Math.max(1, trend.length - 1)) * 92
                                        const y = 88 - ((item.mastery - min) / Math.max(1, max - min)) * 72
                                        return <circle key={`${item.date}-${index}`} cx={x} cy={y} r="1.7" />
                                    })}
                                </svg>
                            )}
                            <div className="student-evolution__direction">
                                <Icon name="compass" size={18} />
                                <div>
                                    <strong>下一条个性化分支</strong>
                                    <span>优先发展「{profile?.dimensions.ability.weakest}」能力，教师可在诊断中心查看证据与推荐学习路径。</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </section>
    )
}

/* ============================================================
 * 子组件 —— 浮动详情面板（族谱 Tab 选中节点时显示）
 * ============================================================ */

interface DetailPanelProps {
    node: GenealogyNode | null
    onClose: () => void
}

function NodeDetailPanel({ node, onClose }: DetailPanelProps) {
    if (!node) return null

    return (
        <aside className="evolution-detail-panel" aria-label="版本节点详情">
            <header className="evolution-detail-panel__header">
                <div className="evolution-detail-panel__title-row">
                    <Icon name="graph" size={14} />
                    <h3 className="evolution-detail-panel__title" title={node.version}>
                        {node.version}
                    </h3>
                </div>
                <button
                    type="button"
                    className="evolution-detail-panel__close"
                    onClick={onClose}
                    aria-label="关闭详情面板"
                >
                    <Icon name="x" size={14} />
                </button>
            </header>

            <div className="evolution-detail-panel__body">
                <div className="evolution-detail-panel__row">
                    <span className="evolution-detail-panel__label">Agent</span>
                    <span className="evolution-detail-panel__value" title={node.agentId}>
                        {node.agentId}
                    </span>
                </div>
                <div className="evolution-detail-panel__row">
                    <span className="evolution-detail-panel__label">状态</span>
                    <span className="evolution-detail-panel__value">
                        {node.isActive && <span className="evolution-detail-panel__tag evolution-detail-panel__tag--active">活跃</span>}
                        {node.isCandidate && <span className="evolution-detail-panel__tag evolution-detail-panel__tag--candidate">候选</span>}
                        {!node.isActive && !node.isCandidate && <span className="evolution-detail-panel__tag evolution-detail-panel__tag--history">历史</span>}
                    </span>
                </div>
                <div className="evolution-detail-panel__row">
                    <span className="evolution-detail-panel__label">质量分</span>
                    <strong className="evolution-detail-panel__value evolution-detail-panel__value--num">
                        {(node.quality * 100).toFixed(1)}%
                    </strong>
                </div>
                {node.improvementReward !== null && (
                    <div className="evolution-detail-panel__row">
                        <span className="evolution-detail-panel__label">提升奖励</span>
                        <strong
                            className="evolution-detail-panel__value evolution-detail-panel__value--num"
                            style={{
                                color: node.improvementReward > 0
                                    ? 'rgb(var(--c-accent-success))'
                                    : 'rgb(var(--c-text-tertiary))',
                            }}
                        >
                            {node.improvementReward >= 0 ? '+' : ''}{node.improvementReward.toFixed(3)}
                        </strong>
                    </div>
                )}
                {node.successCount !== null && (
                    <div className="evolution-detail-panel__row">
                        <span className="evolution-detail-panel__label">成功/失败</span>
                        <strong className="evolution-detail-panel__value evolution-detail-panel__value--num">
                            {node.successCount} / {node.failureCount ?? 0}
                        </strong>
                    </div>
                )}
                {node.triggerPattern && (
                    <div className="evolution-detail-panel__row evolution-detail-panel__row--col">
                        <span className="evolution-detail-panel__label">触发模式</span>
                        <span className="evolution-detail-panel__text">{node.triggerPattern}</span>
                    </div>
                )}
                <div className="evolution-detail-panel__row evolution-detail-panel__row--col">
                    <span className="evolution-detail-panel__label">变更日志</span>
                    <span className="evolution-detail-panel__text">{node.changelog}</span>
                </div>
                {node.appliedAt !== null && (
                    <div className="evolution-detail-panel__row">
                        <span className="evolution-detail-panel__label">应用时间</span>
                        <span className="evolution-detail-panel__value">
                            {new Date(node.appliedAt).toLocaleString('zh-CN')}
                        </span>
                    </div>
                )}
            </div>
        </aside>
    )
}

/* ============================================================
 * 子组件 —— AI 进化视图（侧边栏 Tab 切换 + 主区域 + 浮动详情）
 * ============================================================ */

interface AIEvolutionViewProps {
    data: EvolutionEyePageData
    loading: boolean
    onRefresh: () => void
}

interface GenealogyEvidenceEmptyStateProps {
    loading: boolean
    onRefresh: () => void
    onOpenPatterns: () => void
}

/**
 * 空谱系不是“什么都没有”：它准确表达当前没有可审计版本，并把教师带到
 * 真正的运行证据入口或现有模式采集说明。这里绝不为展示而伪造候选版本。
 */
function GenealogyEvidenceEmptyState({
    loading,
    onRefresh,
    onOpenPatterns,
}: GenealogyEvidenceEmptyStateProps) {
    const navigate = useNavigate()

    return (
        <section className="ai-evolution__empty-state" aria-labelledby="evolution-empty-title">
            <div className="ai-evolution__empty-main">
                <span className="ai-evolution__empty-icon" aria-hidden>
                    <Icon name="graph" size={30} />
                </span>
                <span className="ai-evolution__empty-eyebrow">当前可核验状态</span>
                <h2 id="evolution-empty-title">尚未形成可审计的 AI 版本谱系</h2>
                <p>
                    当前没有已保存的提示词版本。进化之眼不会因为访问页面、单次任务或演示模式而虚构候选、质量分或 A/B 结果。
                </p>
                <div className="ai-evolution__empty-actions">
                    <Button onClick={() => navigate('/ai-copilot')}>查看 AI 运行证据</Button>
                    <Button
                        variant="secondary"
                        onClick={onRefresh}
                        loading={loading}
                        loadingLabel="正在刷新证据"
                    >
                        刷新已保存证据
                    </Button>
                </div>
            </div>
            <ol className="ai-evolution__empty-steps" aria-label="形成谱系的真实条件">
                <li>
                    <span>1</span>
                    <div>
                        <strong>先积累真实运行信号</strong>
                        <p>在教师批准的任务中保留 Agent 调用、验证与失败关闭记录。</p>
                    </div>
                </li>
                <li>
                    <span>2</span>
                    <div>
                        <strong>达到触发条件才生成候选</strong>
                        <p>系统只从教师纠正、智能体错误或验证否决中记录模式；不是每次任务都会产生版本。</p>
                    </div>
                </li>
                <li>
                    <span>3</span>
                    <div>
                        <strong>回到此处复核版本与 A/B</strong>
                        <p>候选、活跃版本和测试记录会从本地持久化证据读取，不由页面临时补全。</p>
                    </div>
                </li>
            </ol>
            <Button className="ai-evolution__empty-pattern-link" variant="ghost" onClick={onOpenPatterns}>
                查看模式采集条件
            </Button>
        </section>
    )
}

function AIEvolutionView({ data, loading, onRefresh }: AIEvolutionViewProps) {
    const navigate = useNavigate()
    const aiTabsId = useId()

    /* ---------- Tab 状态 ---------- */
    const [activeTab, setActiveTab] = useState<AITabKey>('genealogy')

    /* ---------- 选中节点（联动 Genealogy3D + 浮动详情面板） ---------- */
    const [selectedNode, setSelectedNode] = useState<GenealogyNode | null>(null)

    /* ---------- 3D 视角（受控） ---------- */
    const [view, setView] = useState<ViewPreset>('front')

    /* ---------- 预测结果（联动 3D 预测路径） ---------- */
    const [predictions, setPredictions] = useState<EvolutionPredictionDirection[]>([])
    const evolutionPanelRef = useRef<HTMLElement>(null)

    const hasGenealogy = data.genealogy.nodes.length > 0

    // 有真实模式而尚无版本时，优先展示已有证据而不是一个空的 3D 容器。
    useEffect(() => {
        if (!hasGenealogy && data.patterns.length > 0 && activeTab === 'genealogy') {
            setActiveTab('patterns')
        }
    }, [activeTab, data.patterns.length, hasGenealogy])

    /* ---------- 回调 ---------- */
    const handleSelectNode = useCallback((node: GenealogyNode) => {
        setSelectedNode((prev) => (prev?.id === node.id ? null : node))
    }, [])

    const handleHoverNode = useCallback((_node: GenealogyNode | null) => {
        // hover 仅用于 3D 内部视觉反馈
    }, [])

    const handleViewSwitch = useCallback((next: ViewPreset) => {
        setView(next)
    }, [])

    const handlePredictions = useCallback((preds: EvolutionPredictionDirection[]) => {
        setPredictions(preds)
    }, [])

    const handleCloseDetail = useCallback(() => {
        setSelectedNode(null)
    }, [])

    /**
     * 只接受模式与 Agent 均精确匹配、且目标节点仍存在的谱系证据。多条证据时优先
     * 最新一条，避免同一模式聚合后跳到已被后续版本替代的旧节点。
     */
    const findPatternRelatedNode = useCallback((pattern: PatternItem): GenealogyNode | undefined => {
        const matchingEdges = data.genealogy.edges
            .filter((edge) => edge.pattern === pattern.pattern && edge.agentId === pattern.agentId)
            .sort((left, right) => right.createdAt - left.createdAt)
        return matchingEdges
            .map((edge) => data.genealogy.nodes.find((node) => node.id === edge.to))
            .find((node): node is GenealogyNode => Boolean(node))
    }, [data.genealogy.edges, data.genealogy.nodes])

    const hasPatternRelatedVersion = useCallback((pattern: PatternItem) => (
        Boolean(findPatternRelatedNode(pattern))
    ), [findPatternRelatedNode])

    /**
     * 模式卡不能只“跳到族谱”而不说明跳到了哪里。没有可定位节点的陈旧边会在展示层
     * 被失败关闭；若数据在一次交互期间变化，这里仍保留最后一道真实边界。
     */
    const handleOpenPatternRelatedVersion = useCallback((pattern: PatternItem) => {
        const targetNode = findPatternRelatedNode(pattern)

        if (!targetNode) {
            toast.info({
                title: '关联版本暂不可用',
                message: '该模式仍被保留，但当前谱系中没有可定位的关联版本。请刷新已保存证据后重试。',
            })
            return
        }

        setSelectedNode(targetNode)
        setActiveTab('genealogy')
        // 触发按钮会随“模式”面板卸载，必须把焦点交给新 tabpanel，避免落入 body。
        window.requestAnimationFrame(() => evolutionPanelRef.current?.focus({ preventScroll: true }))
    }, [findPatternRelatedNode])

    /**
     * 侧栏使用真正的 tablist 语义：方向键、Home、End 同时切换并移动焦点。
     * 这避免在键盘或读屏环境中只能“看到”四个标签、却无法按标准模型浏览。
     */
    const handleAITabKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
        const currentIndex = AI_TABS.findIndex((tab) => tab.key === activeTab)
        let nextIndex: number
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                nextIndex = (currentIndex + 1) % AI_TABS.length
                break
            case 'ArrowLeft':
            case 'ArrowUp':
                nextIndex = (currentIndex - 1 + AI_TABS.length) % AI_TABS.length
                break
            case 'Home':
                nextIndex = 0
                break
            case 'End':
                nextIndex = AI_TABS.length - 1
                break
            default:
                return
        }
        event.preventDefault()
        const nextTab = AI_TABS[nextIndex]
        if (!nextTab) return
        setActiveTab(nextTab.key)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-ai-evolution-tab="${nextTab.key}"]`)
            ?.focus()
    }, [activeTab])

    /* ---------- 派生：Hero 统计 ---------- */
    const stats = useMemo(() => {
        const nodes = data.genealogy.nodes
        return {
            total: nodes.length,
            active: nodes.filter((n) => n.isActive).length,
            candidate: nodes.filter((n) => n.isCandidate).length,
            patterns: data.patterns.length,
            abTests: data.abTests.active.length,
        }
    }, [data])

    /* ---------- 渲染 ---------- */
    return (
        <div
            className={`ai-evolution${hasGenealogy ? '' : ' ai-evolution--no-genealogy'}`}
            data-anchor
            data-anchor-label="AI 谱系"
        >
            {/* 左侧 280px 侧边栏：Tab 切换 + 全局统计 */}
            <aside className="ai-evolution__sidebar" aria-label="AI 进化视图导航">
                <nav
                    className="ai-evolution__tabs"
                    role="tablist"
                    aria-label="AI 进化视图 Tab"
                    onKeyDown={handleAITabKeyDown}
                >
                    {AI_TABS.map((tab) => (
                        <button
                            key={tab.key}
                            id={`${aiTabsId}-tab-${tab.key}`}
                            data-ai-evolution-tab={tab.key}
                            type="button"
                            role="tab"
                            aria-selected={activeTab === tab.key}
                            aria-controls={`${aiTabsId}-panel`}
                            tabIndex={activeTab === tab.key ? 0 : -1}
                            className={`ai-evolution__tab ${activeTab === tab.key ? 'is-active' : ''}`}
                            onClick={() => setActiveTab(tab.key)}
                        >
                            <Icon name={tab.icon as never} size={16} active={activeTab === tab.key} />
                            <span className="ai-evolution__tab-label">{tab.label}</span>
                            <span className="ai-evolution__tab-hint">{tab.hint}</span>
                        </button>
                    ))}
                </nav>

                {/* 全局统计 */}
                <div className="ai-evolution__stats" aria-label="全局统计">
                    <div className="ai-evolution__stat">
                        <strong>{stats.total}</strong>
                        <span>总版本</span>
                    </div>
                    <div className="ai-evolution__stat">
                        <strong>{stats.active}</strong>
                        <span>活跃</span>
                    </div>
                    <div className="ai-evolution__stat">
                        <strong>{stats.candidate}</strong>
                        <span>候选</span>
                    </div>
                    <div className="ai-evolution__stat">
                        <strong>{stats.patterns}</strong>
                        <span>模式</span>
                    </div>
                    <div className="ai-evolution__stat">
                        <strong>{stats.abTests}</strong>
                        <span>A/B 测试</span>
                    </div>
                </div>

                {/* 视角切换提示（仅族谱 Tab 显示） */}
                {activeTab === 'genealogy' && (
                    <div className="ai-evolution__view-hint" aria-label="3D 视角切换提示">
                        <Icon name="keyboard" size={14} />
                        <span>按 1/2/3 切换 正视/侧视/俯视</span>
                    </div>
                )}
            </aside>

            {/* 主区域：根据 Tab 显示对应内容 */}
            <main
                ref={evolutionPanelRef}
                id={`${aiTabsId}-panel`}
                className="ai-evolution__main"
                role="tabpanel"
                aria-labelledby={`${aiTabsId}-tab-${activeTab}`}
                tabIndex={-1}
            >
                {activeTab === 'genealogy' && (
                    <div className="ai-evolution__canvas-wrap">
                        {hasGenealogy ? (
                            <Suspense fallback={<EvolutionEyeSkeleton />}>
                                <Genealogy3D
                                    data={data.genealogy}
                                    selectedId={selectedNode?.id ?? null}
                                    onSelect={handleSelectNode}
                                    onHover={handleHoverNode}
                                    predictions={predictions}
                                    view={view}
                                    onViewSwitch={handleViewSwitch}
                                />
                            </Suspense>
                        ) : (
                            <GenealogyEvidenceEmptyState
                                loading={loading}
                                onRefresh={onRefresh}
                                onOpenPatterns={() => setActiveTab('patterns')}
                            />
                        )}

                        {/* 浮动 320px 毛玻璃详情面板：仅选中节点时显示 */}
                        {selectedNode && (
                            <NodeDetailPanel node={selectedNode} onClose={handleCloseDetail} />
                        )}
                    </div>
                )}

                {activeTab === 'ab-test' && (
                    <div className="ai-evolution__panel-content">
                        <ABTestChart data={data.abTests} loading={loading} />
                    </div>
                )}

                {activeTab === 'patterns' && (
                    <div className="ai-evolution__panel-content ai-evolution__panel-content--list">
                        <PatternPanel
                            patterns={data.patterns}
                            edges={data.genealogy.edges}
                            nodes={data.genealogy.nodes}
                            loading={loading}
                            onRefresh={onRefresh}
                            onOpenEvidence={() => navigate('/ai-copilot')}
                            onOpenRelatedVersion={handleOpenPatternRelatedVersion}
                            hasRelatedVersion={hasPatternRelatedVersion}
                        />
                    </div>
                )}

                {activeTab === 'predict' && (
                    <div className="ai-evolution__panel-content">
                        <EvolutionPredictor
                            currentVersions={data.genealogy.nodes}
                            historicalPatterns={data.patterns}
                            onPredictions={handlePredictions}
                        />
                    </div>
                )}
            </main>
        </div>
    )
}

/* ============================================================
 * 主页面组件
 * ============================================================ */

export default function EvolutionEyePage() {
    const [view, setView] = useState<'student' | 'ai'>('ai')  // SubTask 26.6：默认进入 AI 进化视图
    const viewTabsId = useId()
    /* ---------- 数据状态 ---------- */
    const [data, setData] = useState<EvolutionEyePageData | null>(null)
    const [status, setStatus] = useState<LoadStatus>('loading')
    const fetchIdRef = useRef(0)
    const hasNotifiedRef = useRef(false)

    /* ---------- 数据加载（三级降级） ---------- */
    const fetchData = useCallback(async () => {
        const id = ++fetchIdRef.current
        setStatus('loading')

        // 并行加载三个数据源，任一失败时整体降级
        try {
            const [genealogy, patterns, abTests] = await Promise.all([
                api.evolution.getGenealogy(),
                api.evolution.getPatterns(50),
                api.evolution.getABTests(),
            ])
            if (fetchIdRef.current !== id) return
            setData({ genealogy, patterns, abTests })
            setStatus('loaded')
        } catch (err) {
            if (fetchIdRef.current !== id) return
            logError('EvolutionEyePage.fetchData', err)
            setStatus('error')
            if (!hasNotifiedRef.current) {
                hasNotifiedRef.current = true
                toast.error({
                    title: '加载失败',
                    message: '进化之眼数据加载失败，请稍后重试',
                })
            }
        }
    }, [])

    // 初次挂载拉取
    useEffect(() => {
        void fetchData()
    }, [fetchData])

    /* ---------- 重试 ---------- */
    const handleRetry = useCallback(() => {
        hasNotifiedRef.current = false
        void fetchData()
    }, [fetchData])

    const handleViewTabKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        let nextView: 'student' | 'ai'
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
            case 'End':
                nextView = 'ai'
                break
            case 'ArrowLeft':
            case 'ArrowUp':
            case 'Home':
                nextView = 'student'
                break
            default:
                return
        }
        event.preventDefault()
        setView(nextView)
        event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-evolution-eye-view-tab="${nextView}"]`)
            ?.focus()
    }, [])

    return (
        <div className="evolution-eye-container" role="region" aria-label="进化之眼基因谱">
            {/* v5.0 Task 4：右侧悬浮锚点迷你地图
             * key={view} —— view 切换时强制重挂载，触发 IntersectionObserver 重扫描 */}
            {/* Hero 标题区 */}
            <header
                className="evolution-eye-hero"
                data-anchor
                data-anchor-label="进化之眼"
            >
                <div className="evolution-eye-hero__text">
                    <span className="evolution-eye-hero__eyebrow">
                        <Icon name="sparkle" size={12} weight="bold" />
                        <span style={{ marginLeft: 4 }}>人机共同进化</span>
                    </span>
                    <h1 className="evolution-eye-hero__title">进化之眼</h1>
                    <p className="evolution-eye-hero__subtitle">
                        以学生真实成长为核心，同时审计 AI 的版本迭代。每一条曲线、节点和分支都能回到学习或系统证据。
                    </p>
                </div>
                <div className="evolution-eye-view-switch" role="tablist" aria-label="进化对象" onKeyDown={handleViewTabKeyDown}>
                    <button
                        id={`${viewTabsId}-tab-student`}
                        data-evolution-eye-view-tab="student"
                        type="button"
                        className={view === 'student' ? 'is-active' : ''}
                        onClick={() => setView('student')}
                        role="tab"
                        aria-controls={`${viewTabsId}-panel`}
                        aria-selected={view === 'student'}
                        tabIndex={view === 'student' ? 0 : -1}
                    >
                        <Icon name="student" size={15} />学生成长
                    </button>
                    <button
                        id={`${viewTabsId}-tab-ai`}
                        data-evolution-eye-view-tab="ai"
                        type="button"
                        className={view === 'ai' ? 'is-active' : ''}
                        onClick={() => setView('ai')}
                        role="tab"
                        aria-controls={`${viewTabsId}-panel`}
                        aria-selected={view === 'ai'}
                        tabIndex={view === 'ai' ? 0 : -1}
                    >
                        <Icon name="robot" size={15} />AI 进化
                    </button>
                </div>
            </header>

            <div
                id={`${viewTabsId}-panel`}
                role="tabpanel"
                aria-labelledby={`${viewTabsId}-tab-${view}`}
            >
                {view === 'student' ? <StudentEvolutionView /> : status === 'loading' && !data ? (
                    <EvolutionEyeSkeleton />
                ) : status === 'error' && !data ? (
                    <div className="evolution-eye-canvas-error" style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 'var(--text-base)' }}>
                            数据加载失败
                        </div>
                        <div style={{ fontSize: 'var(--text-sm)', color: 'rgb(var(--c-text-tertiary))' }}>
                            进化之眼服务暂不可用
                        </div>
                        <button
                            type="button"
                            onClick={handleRetry}
                            style={{
                                marginTop: 'var(--space-md)',
                                padding: '8px 16px',
                                background: 'rgb(var(--c-accent-primary) / 0.12)',
                                color: 'rgb(var(--c-accent-primary))',
                                border: 'none',
                                borderRadius: '8px',
                                cursor: 'pointer',
                                fontSize: 'var(--text-sm)',
                                fontWeight: 500,
                            }}
                        >
                            重试
                        </button>
                    </div>
                ) : data ? (
                    <AIEvolutionView
                        data={data}
                        loading={status === 'loading'}
                        onRefresh={handleRetry}
                    />
                ) : null}
            </div>
        </div>
    )
}
