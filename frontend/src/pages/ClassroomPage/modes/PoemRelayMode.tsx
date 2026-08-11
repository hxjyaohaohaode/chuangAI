/**
 * 诗词接龙模式（SubTask 19.2 —— 创新 2：诗词接龙 + AI 判断）
 *
 * 设计背景：
 * - "寓教于乐"理念：借鉴"成语接龙"玩法，将诗词学习游戏化
 * - 单设备场景：教师选择起始诗 → 学生轮流接下一句 → AI 判断是否合规
 * - AI 虚拟对手作为陪练，能接学生给出的句子，形成"人机对擂"
 *
 * 创新点：
 * 1. 起始诗可选（教师从诗库中选）→ 自动展示起始句
 * 2. 接龙链可视化：时间轴样式，每句标注来源（学生/AI）
 * 3. AI 判断机制：每句接龙都调用 AI 判断是否合规（同诗题/同韵/同字）
 * 4. AI 自动接花：学生提交后自动触发 AI 接下一句
 * 5. 智能赋分：每句接龙的"诗意匹配度"由 AI 评分
 *
 * 职责：
 * 1. 起始诗选择 + 起始句展示
 * 2. 学生接龙输入（StudentInputPanel，但隐藏赋分结果）
 * 3. AI 接龙（aiRelayContinue，调用 triggerAIOpponent）
 * 4. 接龙链时间轴展示（含学生/AI 来源标识）
 * 5. 结束接龙 + 报告
 *
 * 数据来源：
 * - useClassroomStore.poemRelay：接龙会话状态
 * - useClassroomStore.submitRelayLine / aiRelayContinue
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, Button, Badge, Combobox, type ComboboxOption } from '@/components/ui'
import { useClassroomStore } from '@/stores/classroom'
import { api } from '@/lib/api'
import { useDemoModeStore } from '@/lib/demo-mode'
import { splitPoemClauses } from '@/lib/poem-lines'
import type { PoemRelayLine, WorkbenchPoemOption } from '@/lib/types'
import { StudentInputPanel } from '../shared/StudentInputPanel'

export interface PoemRelayModeProps {
    /** 起始诗 ID（由父组件传入，默认 undefined 表示未选择） */
    startPoemId?: string
}

/** 接龙链单条样式配置 */
const RELAY_LINE_STYLES = {
    student: {
        bg: 'var(--accent-primary-10)',
        color: 'rgb(var(--c-text-primary))',
        icon: 'user' as const,
        label: '学生',
    },
    'ai-opponent': {
        bg: 'var(--accent-info-10)',
        color: 'rgb(var(--c-accent-info))',
        icon: 'robot' as const,
        label: 'AI 对手',
    },
    system: {
        bg: 'var(--surface-secondary)',
        color: 'rgb(var(--c-text-secondary))',
        icon: 'book-open' as const,
        label: '起始',
    },
}

type PoemSource = 'loading' | 'live' | 'demo-mode' | 'stale-live' | 'unavailable'

function toPoemOptions(poems: ReadonlyArray<{ id: string; title: string; poet: string; dynasty: string }>): WorkbenchPoemOption[] {
    return poems.map((poem) => ({
        id: poem.id,
        title: poem.title,
        poet: poem.poet,
        dynasty: poem.dynasty,
    }))
}

function firstLinesFor(poems: ReadonlyArray<{ id: string; content: string }>): Record<string, string> {
    const firstLines: Record<string, string> = {}
    for (const poem of poems) {
        const first = splitPoemClauses(poem.content)[0]
        if (first) firstLines[poem.id] = first
    }
    return firstLines
}

export const PoemRelayMode = memo(function PoemRelayMode({
    startPoemId: initialPoemId,
}: PoemRelayModeProps) {
    // store 状态与动作
    const poemRelay = useClassroomStore((s) => s.poemRelay)
    const aiOpponent = useClassroomStore((s) => s.aiOpponent)
    const aiThinking = useClassroomStore((s) => s.aiOpponentThinking)
    const submitRelayLine = useClassroomStore((s) => s.submitRelayLine)
    const aiRelayContinue = useClassroomStore((s) => s.aiRelayContinue)
    const scoreAnswer = useClassroomStore((s) => s.scoreAnswer)
    const lessonId = useClassroomStore((s) => s.lessonId)
    const isDemoMode = useDemoModeStore((s) => s.isDemoMode)

    /** 起始诗选择 */
    const [startPoemId, setStartPoemId] = useState<string>(initialPoemId ?? '')
    /** 起始句输入（教师可手动指定，默认从诗篇获取第一句） */
    const [startLine, setStartLine] = useState<string>('')
    /** 诗篇选项 */
    const [poemOptions, setPoemOptions] = useState<WorkbenchPoemOption[]>([])
    /** 诗篇首句映射 */
    const [poemFirstLine, setPoemFirstLine] = useState<Record<string, string>>({})
    /** 当前诗库来源；课堂活动不得用局部失败时的本地样例伪造教材。 */
    const [poemSource, setPoemSource] = useState<PoemSource>('loading')
    const [poemLoadError, setPoemLoadError] = useState<string | null>(null)
    const [poemReloadVersion, setPoemReloadVersion] = useState(0)
    const livePoemsRef = useRef<{
        options: WorkbenchPoemOption[]
        firstLines: Record<string, string>
    } | null>(null)

    /** 拉取诗库 */
    useEffect(() => {
        let active = true
        // 用 recitation.listPoems 而非 workbench.listPoems：
        // 接龙的起始句必须是**真实诗句**，而 workbench 的诗篇选项只有
        // id/title/poet/dynasty，没有正文。此前这里退而用「诗题 · 诗人」
        // 充当首句，接龙从一个根本不是诗句的字符串开始，玩法从第一步就是错的。
        const cachedLive = livePoemsRef.current
        if (isDemoMode) {
            setPoemSource('loading')
            setPoemLoadError(null)
        } else if (cachedLive) {
            // 保留已经确认过来源的真实诗篇，等同步完成后再决定是否降级为 stale-live。
            setPoemOptions(cachedLive.options)
            setPoemFirstLine(cachedLive.firstLines)
            setPoemSource('live')
            setPoemLoadError(null)
        } else {
            setPoemOptions([])
            setPoemFirstLine({})
            setPoemSource('loading')
            setPoemLoadError(null)
        }

        void api.recitation.listPoems()
            .then((response) => {
                if (!active) return
                const poems = response.poems.slice(0, 30)
                const nextOptions = toPoemOptions(poems)
                const nextFirstLines = firstLinesFor(poems)
                setPoemOptions(nextOptions)
                setPoemFirstLine(nextFirstLines)
                setStartPoemId((current) => (
                    current && nextOptions.some((poem) => poem.id === current) ? current : ''
                ))
                if (isDemoMode) {
                    setPoemSource('demo-mode')
                    return
                }
                livePoemsRef.current = { options: nextOptions, firstLines: nextFirstLines }
                setPoemSource('live')
            })
            .catch(() => {
                if (!active) return
                if (isDemoMode) {
                    // DEMO 模式中的失败不会用未知来源替代；全局横幅会继续说明离线状态。
                    setPoemSource('unavailable')
                    setPoemLoadError('离线演示诗库暂不可用；请恢复服务后重试。')
                    return
                }
                if (cachedLive) {
                    setPoemOptions(cachedLive.options)
                    setPoemFirstLine(cachedLive.firstLines)
                    setPoemSource('stale-live')
                    setPoemLoadError('真实诗库最新同步失败；当前仅保留此前加载的真实诗篇。')
                    return
                }
                setPoemOptions([])
                setPoemFirstLine({})
                setPoemSource('unavailable')
                setPoemLoadError('暂时无法连接真实诗库；未显示本地样例，避免以演示诗篇启动课堂。')
            })
        return () => {
            active = false
        }
    }, [isDemoMode, poemReloadVersion])

    const handleRetryPoems = useCallback(() => {
        setPoemReloadVersion((version) => version + 1)
    }, [])

    /** 选项转换为 Combobox 格式 */
    const comboboxOptions: ComboboxOption[] = useMemo(() => {
        return poemOptions.map((p) => ({
            value: p.id,
            label: `${p.title} · ${p.poet}${p.dynasty ? `（${p.dynasty}）` : ''}`,
        }))
    }, [poemOptions])

    /** 启动接龙会话 */
    const handleStartRelay = useCallback(() => {
        if (!startPoemId || poemSource === 'unavailable' || poemSource === 'loading') return
        const firstLine = startLine.trim() || poemFirstLine[startPoemId]
        if (!firstLine) return
        // 初始化接龙会话（在 store 中创建）
        // 这里通过 triggerAIOpponent 触发 AI 接第一句，让会话有起始
        // 实际上 store 的 poemRelay 应该有初始化方法，这里手动设置
        const initRelay = {
            startPoemId,
            startLine: firstLine,
            chain: [{
                line: firstLine,
                source: 'system' as const,
                at: Date.now(),
            }],
            finished: false,
        }
        // 直接更新 store（虽然 store 中没有专门的方法，但可以通过 triggerAIOpponent 间接触发）
        // 这里通过设置 store 的方式来初始化
        useClassroomStore.setState({ poemRelay: initRelay })
    }, [poemFirstLine, poemSource, startLine, startPoemId])

    /** 学生接龙提交 */
    const handleStudentSubmitted = useCallback(
        async (studentId: string, _studentName: string, answer: string, _score: number | null) => {
            if (!answer.trim()) return
            // 1. 学生提交接龙
            await submitRelayLine(answer, studentId, _studentName)
            // 2. AI 判断 + 赋分（与上一句的连贯度）
            await scoreAnswer({
                studentId,
                answer,
                mode: 'poem-relay',
                referenceAnswer: poemRelay?.chain[poemRelay.chain.length - 1]?.line,
            })
            // 3. 自动触发 AI 接花
            if (aiOpponent.enabled) {
                void aiRelayContinue(studentId)
            }
        },
        [submitRelayLine, scoreAnswer, aiOpponent.enabled, aiRelayContinue, poemRelay],
    )

    /** 手动触发 AI 接花 */
    const handleTriggerAI = useCallback(() => {
        void aiRelayContinue()
    }, [aiRelayContinue])

    /** 结束接龙 */
    const handleFinishRelay = useCallback(() => {
        if (!poemRelay) return
        useClassroomStore.setState({
            poemRelay: { ...poemRelay, finished: true },
        })
    }, [poemRelay])

    /** 重置接龙 */
    const handleReset = useCallback(() => {
        useClassroomStore.setState({ poemRelay: null })
        setStartPoemId('')
        setStartLine('')
    }, [])

    /** 接龙链按来源分类展示 */
    const chainLines = useMemo<PoemRelayLine[]>(() => {
        return poemRelay?.chain ?? []
    }, [poemRelay])

    /** 学生/AI 接龙数量统计 */
    const stats = useMemo(() => {
        let studentCount = 0
        let aiCount = 0
        for (const line of chainLines) {
            if (line.source === 'student') studentCount += 1
            else if (line.source === 'ai-opponent') aiCount += 1
        }
        return { studentCount, aiCount, total: chainLines.length }
    }, [chainLines])

    const comboboxValue = useMemo(() => {
        return comboboxOptions.find((opt) => opt.value === startPoemId)?.value ?? ''
    }, [comboboxOptions, startPoemId])

    return (
        <div className="pr-poem-relay">
            <div className="pr-poem-relay-header">
                <Icon name="link" size={18} />
                <span className="pr-poem-relay-title">诗词接龙</span>
                <Badge variant="primary" style={{ marginLeft: 'var(--space-sm)' }}>
                    寓教于乐
                </Badge>
                {poemRelay && (
                    <Badge variant="info" style={{ marginLeft: 'var(--space-xs)' }}>
                        已接 {stats.total} 句
                    </Badge>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'rgb(var(--c-text-secondary))' }}>
                    {poemRelay?.finished ? '接龙已结束' : poemRelay ? '接龙进行中' : '请选择起始诗'}
                </span>
            </div>

            {/* 起始诗选择（未启动时） */}
            {!poemRelay && (
                <div className="pr-poem-relay-setup">
                    {poemSource !== 'live' && (
                        <div
                            className={`pr-poem-relay-source is-${poemSource}`}
                            role={poemSource === 'unavailable' ? 'alert' : 'status'}
                        >
                            <Icon
                                name={poemSource === 'unavailable' ? 'warning-circle' : 'info'}
                                size={15}
                                weight="bold"
                                aria-hidden
                            />
                            <div>
                                <strong>
                                    {poemSource === 'demo-mode'
                                        ? '当前诗篇来自离线演示数据'
                                        : poemSource === 'stale-live'
                                            ? '正在使用已加载的真实诗篇'
                                            : poemSource === 'loading'
                                                ? '正在加载真实诗库'
                                                : '真实诗库暂不可用'}
                                </strong>
                                <span>
                                    {poemSource === 'demo-mode'
                                        ? '仅用于演示课堂流程，不能作为真实教学记录依据。'
                                        : poemSource === 'loading'
                                            ? '加载完成后才能选择起始诗篇。'
                                            : poemLoadError}
                                </span>
                            </div>
                            {(poemSource === 'unavailable' || poemSource === 'stale-live') && (
                                <button type="button" onClick={handleRetryPoems}>
                                    重试真实诗库
                                </button>
                            )}
                        </div>
                    )}
                    <div className="pr-poem-relay-setup-row">
                        <label className="pr-poem-relay-label">起始诗篇</label>
                        <Combobox
                            options={comboboxOptions}
                            value={comboboxValue}
                            onChange={(val) => setStartPoemId(typeof val === 'string' ? val : '')}
                            ariaLabel="起始诗篇"
                            placeholder={poemSource === 'loading' ? '正在加载真实诗库…' : '请选择起始诗...'}
                            searchable
                            disabled={poemSource === 'loading' || poemSource === 'unavailable'}
                        />
                    </div>
                    <div className="pr-poem-relay-setup-row">
                        <label className="pr-poem-relay-label">起始句（可选）</label>
                        <input
                            type="text"
                            value={startLine}
                            onChange={(e) => setStartLine(e.target.value)}
                            placeholder={startPoemId && poemFirstLine[startPoemId]
                                ? `默认：${poemFirstLine[startPoemId]}`
                                : '留空则使用诗篇首句'}
                            className="pr-poem-relay-start-input"
                        />
                    </div>
                    <Button
                        variant="primary"
                        onClick={handleStartRelay}
                        disabled={!startPoemId || !poemFirstLine[startPoemId] || poemSource === 'loading' || poemSource === 'unavailable'}
                        leftIcon={<Icon name="play" size={14} />}
                    >
                        启动接龙
                    </Button>
                </div>
            )}

            {/* 接龙链时间轴 */}
            {poemRelay && (
                <div className="pr-poem-relay-chain">
                    <div className="pr-poem-relay-chain-header">
                        <Icon name="clock" size={14} />
                        <span>接龙链</span>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-sm)' }}>
                            <Badge variant="primary">学生 {stats.studentCount}</Badge>
                            <Badge variant="info">AI {stats.aiCount}</Badge>
                        </div>
                    </div>

                    <ol className="pr-poem-relay-chain-list">
                        {chainLines.map((line, idx) => {
                            const style = RELAY_LINE_STYLES[line.source]
                            return (
                                <li
                                    key={`${idx}-${line.at}`}
                                    className={`pr-poem-relay-chain-item is-${line.source}`}
                                    style={{ backgroundColor: style.bg }}
                                >
                                    <span className="pr-poem-relay-chain-index">{idx + 1}</span>
                                    <span className="pr-poem-relay-chain-source">
                                        <Icon name={style.icon} size={12} />
                                        {style.label}
                                    </span>
                                    <span className="pr-poem-relay-chain-text" style={{ color: style.color }}>
                                        {line.line}
                                    </span>
                                    {line.poemTitle && (
                                        <span className="pr-poem-relay-chain-poem">
                                            —— {line.poemTitle}
                                        </span>
                                    )}
                                    {line.correct === false && (
                                        <Badge variant="error" style={{ marginLeft: 'auto' }}>
                                            不合规
                                        </Badge>
                                    )}
                                </li>
                            )
                        })}
                    </ol>

                    {/* AI 思考中提示 */}
                    {aiThinking && (
                        <div className="pr-poem-relay-ai-thinking">
                            <span className="pr-poem-relay-ai-thinking-dot" />
                            AI 正在搜索合适的下句...
                        </div>
                    )}
                </div>
            )}

            {/* 学生接龙输入 */}
            {poemRelay && !poemRelay.finished && (
                <>
                    <StudentInputPanel
                        autoFocus
                        hideScoreResult
                        placeholder="请输入学生姓名（接下一句）..."
                        onSubmitted={(sid, name, ans, score) => {
                            void handleStudentSubmitted(sid, name, ans, score)
                        }}
                    />

                    {/* AI 对手 */}
                    <AIVirtualOpponentInline
                        onTrigger={handleTriggerAI}
                        thinking={aiThinking}
                    />

                    {/* 操作按钮 */}
                    <div className="pr-poem-relay-actions">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleReset}
                            leftIcon={<Icon name="refresh" size={12} />}
                        >
                            重新开始
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleFinishRelay}
                            leftIcon={<Icon name="stop" size={12} />}
                        >
                            结束接龙
                        </Button>
                    </div>
                </>
            )}

            {/* 接龙已结束提示 */}
            {poemRelay?.finished && (
                <div className="pr-poem-relay-finished">
                    <Icon name="check-circle" size={20} />
                    <span>接龙已结束，共接 {stats.total} 句，学生 {stats.studentCount} 句，AI {stats.aiCount} 句</span>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleReset}
                        style={{ marginLeft: 'var(--space-md)' }}
                        leftIcon={<Icon name="refresh" size={12} />}
                    >
                        再来一局
                    </Button>
                </div>
            )}

            {lessonId && !poemRelay && (
                <div className="pr-poem-relay-empty">
                    <Icon name="info" size={14} />
                    <span>选择起始诗篇后启动接龙，AI 将作为陪练与你轮流接花</span>
                </div>
            )}
        </div>
    )
})

/** AI 虚拟对手内联版（紧凑横向布局） */
interface AIVirtualOpponentInlineProps {
    onTrigger: () => void
    thinking: boolean
}

function AIVirtualOpponentInline({ onTrigger, thinking }: AIVirtualOpponentInlineProps) {
    const aiOpponent = useClassroomStore((s) => s.aiOpponent)
    const setEnabled = useClassroomStore((s) => s.setAIOpponentEnabled)
    const setLevel = useClassroomStore((s) => s.setAIOpponentLevel)

    if (!aiOpponent.enabled) {
        return (
            <div className="pr-poem-relay-ai-toggle">
                <Icon name="robot" size={14} />
                <span>未启用 AI 陪练</span>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEnabled(true)}
                    style={{ marginLeft: 'auto' }}
                >
                    启用
                </Button>
            </div>
        )
    }

    return (
        <div className="pr-poem-relay-ai-inline">
            <div className="pr-poem-relay-ai-info">
                <Icon name="robot" size={14} />
                <span>{aiOpponent.name}</span>
                <Badge variant="info">{aiOpponent.level === 'easy' ? '新秀' : aiOpponent.level === 'medium' ? '老练' : '诗仙'}</Badge>
                {thinking && (
                    <span className="pr-poem-relay-ai-thinking-badge">
                        <span className="pr-poem-relay-ai-thinking-dot" />
                        思考中
                    </span>
                )}
            </div>
            <div className="pr-poem-relay-ai-levels">
                {(['easy', 'medium', 'hard'] as const).map((lv) => (
                    <button
                        key={lv}
                        type="button"
                        className={`pr-poem-relay-ai-level-btn ${aiOpponent.level === lv ? 'is-active' : ''}`}
                        onClick={() => setLevel(lv)}
                        disabled={thinking}
                    >
                        {lv === 'easy' ? '新秀' : lv === 'medium' ? '老练' : '诗仙'}
                    </button>
                ))}
            </div>
            <Button
                variant="secondary"
                size="sm"
                onClick={onTrigger}
                loading={thinking}
                leftIcon={<Icon name="bolt" size={12} />}
            >
                让 AI 接花
            </Button>
        </div>
    )
}
