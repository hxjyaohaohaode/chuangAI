/**
 * 多智能体协作进度面板
 *
 * 对接 POST /api/agents/orchestrate 的 SSE 流，展示 4 个 Agent 的实时运行态：
 *   出题（brush.question · max）→ 验证（mind.verify · high）
 *   → 精修（验收未通过时才执行）→ 验收（落库，不调模型）
 *
 * 本组件是**纯视图**：编排状态与 SSE 连接都由 stores/workbench 持有。
 * 这样设计的原因是一次命题要跑 3 分钟量级，教师中途切到诊断/课堂再切回来
 * 是常态；若把连接放在组件里，卸载即断流，进度与产出会全部丢失。
 *
 * 等待体验的四个要点：
 * 1. 真实进度：每个节点的百分比与耗时全部来自后端事件，不做假动画；
 * 2. 剩余时间预估：以各阶段实测经验耗时为基准，已完成阶段用真实耗时校准；
 * 3. 可中止：中止会关闭 SSE，后端随之 abort 在途的大模型调用，停止计费；
 * 4. 后台继续：离开页面不中断，完成后由通知中心提醒教师回来查看。
 *
 * 设计要点（规范第 6、10、14 章）：
 * - 节点状态色：success-绿 / warning-进行 / error-失败 / tertiary-待定
 * - 运行中节点：左侧 3px 竖线脉动 + 背景 alpha 10%
 * - 进度条用 accent-primary 暖金色；耗时用 Tabular Numbers
 * - 流式输出末尾光标脉动；空态给出明确的启动引导
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Icon } from '@/components/ui'
import { usePlaybackVisibility } from '@/hooks/usePlaybackVisibility'
import {
    useWorkbenchStore,
    WORKBENCH_AGENT_NODES,
    WORKBENCH_TYPICAL_TOTAL_MS,
} from '@/stores/workbench'
import type { WorkbenchAgentStatus } from '@/lib/types'

/**
 * 把毫秒格式化为「约 X 分 Y 秒」
 *
 * 刻意用「约」字：这是基于经验耗时的预估，大模型的实际耗时受题量与
 * 验收结论影响会有波动，不该用一个精确到秒的数字暗示确定性。
 */
function formatEta(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000))
    if (total < 60) return `约 ${total} 秒`
    const m = Math.floor(total / 60)
    const s = total % 60
    return s === 0 ? `约 ${m} 分钟` : `约 ${m} 分 ${s} 秒`
}

function formatElapsed(ms: number): string {
    const total = Math.round(ms / 1000)
    if (total < 60) return `${total}s`
    return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
}

export const AgentProgressPanel = memo(function AgentProgressPanel() {
    const panelRef = useRef<HTMLDivElement>(null)
    const playback = usePlaybackVisibility(panelRef)
    const poemId = useWorkbenchStore((s) => s.poemId)
    const agentRuntimes = useWorkbenchStore((s) => s.agentRuntimes)
    const orchestrating = useWorkbenchStore((s) => s.orchestrating)
    const orchestrateStartedAt = useWorkbenchStore((s) => s.orchestrateStartedAt)
    const orchestrateError = useWorkbenchStore((s) => s.orchestrateError)
    const startOrchestration = useWorkbenchStore((s) => s.startOrchestration)
    const abortOrchestration = useWorkbenchStore((s) => s.abortOrchestration)

    /**
     * 每秒 tick 一次，用于刷新「已用时 / 预计剩余」
     *
     * 仅在编排进行中且面板可见时启动定时器；隐藏标签页或滚出视口立即
     * 停止 React 重渲染，恢复可见时用真实时钟重新校准，不改变后台任务。
     */
    const [nowTs, setNowTs] = useState(() => Date.now())
    useEffect(() => {
        if (!orchestrating || !playback.active) return
        setNowTs(Date.now())
        const timer = window.setInterval(() => setNowTs(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [orchestrating, playback.active])

    const runtimeList = useMemo(
        () => WORKBENCH_AGENT_NODES.map((node) => agentRuntimes[node.agentId]),
        [agentRuntimes],
    )

    const completedCount = runtimeList.filter((r) => r.status === 'success').length
    const hasFailed = runtimeList.some((r) => r.status === 'failed')
    const hasAnyActivity = runtimeList.some((r) => r.status !== 'pending')

    /** 整体进度：4 个节点进度的算术平均 */
    const overallProgress = useMemo(() => {
        const sum = runtimeList.reduce((acc, r) => acc + r.progress, 0)
        return Math.round(sum / Math.max(1, runtimeList.length))
    }, [runtimeList])

    /** 已用时 */
    const elapsedMs = orchestrateStartedAt ? Math.max(0, nowTs - orchestrateStartedAt) : 0

    /**
     * 预计剩余时间
     *
     * 算法：把「尚未完成的节点」的经验耗时相加；对当前正在运行的节点，
     * 按其已上报的进度百分比折算剩余部分。已完成节点用真实耗时校准整体基准，
     * 使预估随着本次实际速度自我修正，而不是永远播报同一个固定数字。
     */
    const remainingMs = useMemo(() => {
        if (!orchestrating) return 0

        const doneNodes = WORKBENCH_AGENT_NODES.filter(
            (n) => agentRuntimes[n.agentId].status === 'success',
        )
        const actualDone = doneNodes.reduce(
            (sum, n) => sum + (agentRuntimes[n.agentId].elapsedMs ?? n.typicalMs),
            0,
        )
        const typicalDone = doneNodes.reduce((sum, n) => sum + n.typicalMs, 0)
        // 校准系数：本次实际速度 / 经验速度（无已完成节点时为 1）
        const calibration = typicalDone > 0 ? actualDone / typicalDone : 1

        let remaining = 0
        for (const node of WORKBENCH_AGENT_NODES) {
            const rt = agentRuntimes[node.agentId]
            if (rt.status === 'success' || rt.status === 'failed') continue
            if (rt.status === 'running') {
                remaining += node.typicalMs * calibration * (1 - rt.progress / 100)
            } else {
                remaining += node.typicalMs * calibration
            }
        }
        return remaining
    }, [orchestrating, agentRuntimes])

    // ── 空态：从未启动过 ──
    if (!orchestrating && !hasAnyActivity) {
        return (
            <div
                ref={panelRef}
                className="pr-wb-agent pr-wb-agent--empty"
                data-playback={playback.active ? 'active' : 'paused'}
            >
                <div className="pr-wb-agent-empty-icon">
                    <Icon name="gear" size={28} weight="bold" />
                </div>
                <div className="pr-wb-agent-empty-title">多智能体待命</div>
                <div className="pr-wb-agent-empty-desc">
                    启动后编排官将依次调度 4 个 Agent：出题 → 验证 → 精修 → 验收。
                    全流程使用深度思考档位，通常需要 {formatEta(WORKBENCH_TYPICAL_TOTAL_MS)}，
                    期间可离开本页，完成后会收到通知。
                </div>
                {/* 本面板是「监视器」而非第二个启动入口：
                    启动动作只保留在左侧命题表单——配置完成后就地执行才是自然路径。
                    此前这里另有一个功能完全相同的主按钮，同屏出现两个「启动」，
                    既造成语义重复，也让教师不清楚两者是否走同一条流程。 */}
                <p className="pr-wb-agent-empty-hint">
                    {poemId
                        ? '已选定诗篇，点击左侧「启动六阶命题」开始协作'
                        : '请先在左侧表单选择目标诗篇'}
                </p>
            </div>
        )
    }

    return (
        <div
            ref={panelRef}
            className="pr-wb-agent"
            data-playback={playback.active ? 'active' : 'paused'}
        >
            <header className="pr-wb-agent-header">
                <div className="pr-wb-agent-title-row">
                    <Icon name="gear" size={16} />
                    <h3 className="pr-wb-agent-title">协作进度</h3>
                    {orchestrating && (
                        <Badge variant="warning">
                            <span className="pr-wb-agent-pulse-dot" aria-hidden />
                            实时
                        </Badge>
                    )}
                    {hasFailed && <Badge variant="error">存在失败</Badge>}
                </div>
                <span className="pr-wb-agent-overall">
                    {completedCount} / {WORKBENCH_AGENT_NODES.length}
                </span>
            </header>

            {/* 整体进度条 + 时间信息
                进度条本身用 aria-hidden 隐藏，改由外层 role="progressbar" 承载语义，
                避免屏幕阅读器把纯装饰的轨道与填充也念一遍。 */}
            <div
                className="pr-wb-agent-overall-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={overallProgress}
                aria-label="多智能体协作整体进度"
            >
                <div className="pr-wb-agent-overall-progress-track" aria-hidden>
                    <div
                        className="pr-wb-agent-overall-progress-fill"
                        style={{
                            transform: `scaleX(${overallProgress / 100})`,
                            backgroundColor: hasFailed
                                ? 'rgb(var(--c-accent-error))'
                                : 'rgb(var(--c-accent-primary))',
                        }}
                    />
                </div>
                <span className="pr-wb-agent-overall-progress-value">{overallProgress}%</span>
            </div>

            {/* 耗时与预估：长流程里这是教师最关心的信息，单独一行给足权重 */}
            {(orchestrating || elapsedMs > 0) && (
                <div className="pr-wb-agent-timing">
                    <span className="pr-wb-agent-timing-item">
                        <Icon name="clock" size={12} />
                        <span>已用 {formatElapsed(elapsedMs)}</span>
                    </span>
                    {orchestrating && (
                        <span className="pr-wb-agent-timing-item pr-wb-agent-timing-item--eta">
                            <span>预计还需 {formatEta(remainingMs)}</span>
                        </span>
                    )}
                    {orchestrating && (
                        <span className="pr-wb-agent-timing-hint">可离开本页，完成后通知你</span>
                    )}
                </div>
            )}

            {/* DAG 节点列表 */}
            <ol className="pr-wb-agent-dag">
                {WORKBENCH_AGENT_NODES.map((node, idx) => {
                    const rt = agentRuntimes[node.agentId]
                    return (
                        <li
                            key={node.agentId}
                            className={`pr-wb-agent-node pr-wb-agent-node--${rt.status}`}
                        >
                            <div className="pr-wb-agent-node-head">
                                <span className="pr-wb-agent-node-index">{idx + 1}</span>
                                <span className="pr-wb-agent-node-icon">
                                    <StatusIcon status={rt.status} />
                                </span>
                                <span className="pr-wb-agent-node-label">{rt.label}</span>
                                <span className="pr-wb-agent-node-status">
                                    {STATUS_TEXT[rt.status]}
                                </span>
                                {rt.elapsedMs !== undefined && (
                                    <span className="pr-wb-agent-node-latency">
                                        <Icon name="clock" size={11} />
                                        <span>{(rt.elapsedMs / 1000).toFixed(1)}s</span>
                                    </span>
                                )}
                            </div>
                            <p className="pr-wb-agent-node-desc">{rt.desc}</p>

                            {/* 进度条 */}
                            {(rt.status === 'running' || rt.status === 'success') && (
                                <div className="pr-wb-agent-progress">
                                    <div className="pr-wb-agent-progress-track" aria-hidden>
                                        <div
                                            className={`pr-wb-agent-progress-fill pr-wb-agent-progress-fill--${rt.status}`}
                                            style={{ transform: `scaleX(${rt.progress / 100})` }}
                                        />
                                    </div>
                                    <span className="pr-wb-agent-progress-value">{rt.progress}%</span>
                                </div>
                            )}

                            {/* 输出预览 */}
                            {rt.output && (
                                <div className="pr-wb-agent-output">
                                    <pre className="pr-wb-agent-output-text">
                                        {rt.output}
                                        {rt.status === 'running' && (
                                            <span className="pr-wb-agent-output-cursor" aria-hidden />
                                        )}
                                    </pre>
                                </div>
                            )}

                            {/* 失败错误 */}
                            {rt.status === 'failed' && rt.error && (
                                <p className="pr-wb-agent-node-error">{rt.error}</p>
                            )}
                        </li>
                    )
                })}
            </ol>

            {/* 底部操作 */}
            <div className="pr-wb-agent-actions">
                {orchestrating ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Icon name="stop" size={14} />}
                        onClick={abortOrchestration}
                    >
                        中止协作
                    </Button>
                ) : (
                    <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<Icon name="arrows-clockwise" size={14} />}
                        onClick={startOrchestration}
                        disabled={!poemId}
                    >
                        重新启动
                    </Button>
                )}
                {orchestrateError && (
                    <span className="pr-wb-agent-error-text" title={orchestrateError}>
                        <Icon name="warning-circle" size={12} />
                        <span>{orchestrateError}</span>
                    </span>
                )}
            </div>
        </div>
    )
})

/* ============================================================
 * 子组件：状态图标
 * ============================================================ */

const STATUS_TEXT: Record<WorkbenchAgentStatus, string> = {
    pending: '等待中',
    running: '执行中',
    success: '已完成',
    failed: '执行失败',
}

function StatusIcon({ status }: { status: WorkbenchAgentStatus }) {
    switch (status) {
        case 'success':
            return <Icon name="check-circle" size={14} weight="bold" />
        case 'running':
            return <span className="pr-wb-agent-spinner" aria-hidden />
        case 'failed':
            return <Icon name="x-circle" size={14} weight="bold" />
        default:
            return <Icon name="clock" size={14} />
    }
}
