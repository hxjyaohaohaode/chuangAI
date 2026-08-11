/**
 * 命题表单（SubTask 10.1）
 *
 * 教师最常用的命题入口，包含：
 * 1. 诗篇选择（下拉，拉取自 /api/workbench/poems）
 * 2. 年级分段（分段控件 1-2 / 3-4 / 5-6 年级）
 * 3. 题型标签（多选 chips：选择 / 填空 / 配对 / 简答 / 创作 / 应用）
 * 4. 六阶权重滑块（记忆 → 创造，0-100，配色按 WORKBENCH_BLOOM_COLORS）
 * 5. Canvas 饼图（实时绘制六阶权重分布，色彩语义化）
 * 6. 三档预设（基础识记 / 六阶均衡 / 高阶挑战）
 * 7. 数量输入（1-20，步进 ±1）
 * 8. 排除已用题目（开关）
 * 9. 生成按钮（提交，触发 store.startOrchestration —— 与右侧协作面板同一条流程）
 *
 * 设计要点（规范第 5、7、14 章）：
 * - 松紧得当：表单项内紧带，分组间稳带
 * - 完整三态：所有可交互元素具备 hover/active/focus-visible
 * - 流体尺寸：滑块、饼图随容器宽度自适应
 * - 零硬编码：所有色值/尺寸引用 tokens.css 变量
 */

import { memo, useCallback, useEffect, useRef } from 'react'
import { Button, Combobox, Icon, type ComboboxOption } from '@/components/ui'
import { useWorkbenchStore } from '@/stores/workbench'
import { useDemoModeStore } from '@/lib/demo-mode'
import {
    WORKBENCH_BLOOM_TIERS,
    WORKBENCH_BLOOM_COLORS,
    WORKBENCH_PRESETS,
} from '@/lib/types'
import type {
    WorkbenchGradeLevel,
    WorkbenchQuestionType,
    BloomLevel,
} from '@/lib/types'

/** 年级分段选项 */
const GRADE_OPTIONS: ReadonlyArray<{ key: WorkbenchGradeLevel; label: string; short: string }> = [
    { key: '1-2年级', label: '1-2 年级', short: '低段' },
    { key: '3-4年级', label: '3-4 年级', short: '中段' },
    { key: '5-6年级', label: '5-6 年级', short: '高段' },
]

/** 题型选项 */
const QUESTION_TYPE_OPTIONS: ReadonlyArray<{ key: WorkbenchQuestionType; icon: string }> = [
    { key: '选择', icon: 'list' },
    { key: '填空', icon: 'feather' },
    { key: '配对', icon: 'arrows-clockwise' },
    { key: '简答', icon: 'pen-nib' },
    { key: '创作', icon: 'sparkle' },
    { key: '应用', icon: 'lightbulb' },
]

/** 预设键顺序 */
const PRESET_KEYS = ['basic', 'balanced', 'advanced'] as const

export const WorkbenchForm = memo(function WorkbenchForm() {
    const poemId = useWorkbenchStore((s) => s.poemId)
    const gradeLevel = useWorkbenchStore((s) => s.gradeLevel)
    const questionTypes = useWorkbenchStore((s) => s.questionTypes)
    const bloomWeights = useWorkbenchStore((s) => s.bloomWeights)
    const count = useWorkbenchStore((s) => s.count)
    const excludeUsedQuestions = useWorkbenchStore((s) => s.excludeUsedQuestions)
    const poems = useWorkbenchStore((s) => s.poems)
    const poemsLoading = useWorkbenchStore((s) => s.poemsLoading)
    const poemsSource = useWorkbenchStore((s) => s.poemsSource)
    const poemsLoadError = useWorkbenchStore((s) => s.poemsLoadError)
    const generating = useWorkbenchStore((s) => s.generating)
    const isDemoMode = useDemoModeStore((s) => s.isDemoMode)

    const setPoemId = useWorkbenchStore((s) => s.setPoemId)
    const setGradeLevel = useWorkbenchStore((s) => s.setGradeLevel)
    const toggleQuestionType = useWorkbenchStore((s) => s.toggleQuestionType)
    const setBloomWeight = useWorkbenchStore((s) => s.setBloomWeight)
    const applyPreset = useWorkbenchStore((s) => s.applyPreset)
    const setCount = useWorkbenchStore((s) => s.setCount)
    const setExcludeUsedQuestions = useWorkbenchStore((s) => s.setExcludeUsedQuestions)
    const fetchPoems = useWorkbenchStore((s) => s.fetchPoems)
    const startOrchestration = useWorkbenchStore((s) => s.startOrchestration)

    // 挂载时拉取古诗列表
    useEffect(() => {
        if (poems.length === 0 && !poemsLoading) {
            void fetchPoems()
        }
    }, [poems.length, poemsLoading, fetchPoems])

    // 全局离线演示模式恢复后，之前的演示诗篇不能继续被当作当前诗库。
    // 只针对 `demo-mode` 来源重新拉取，局部 fallback 则由教师显式点击重试，
    // 避免临时网络抖动导致无限请求循环。
    const wasDemoModeRef = useRef(isDemoMode)
    useEffect(() => {
        const exitedDemoMode = wasDemoModeRef.current && !isDemoMode
        wasDemoModeRef.current = isDemoMode
        if (exitedDemoMode && poemsSource === 'demo-mode' && !poemsLoading) {
            void fetchPoems()
        }
    }, [fetchPoems, isDemoMode, poemsLoading, poemsSource])

    /** 找出当前激活的预设 key（权重完全匹配时高亮） */
    const activePresetKey = PRESET_KEYS.find((k) => {
        const preset = WORKBENCH_PRESETS[k]
        if (!preset) return false
        return WORKBENCH_BLOOM_TIERS.every(
            (tier) => bloomWeights[tier.key] === preset.weights[tier.key],
        )
    })

    /**
     * 提交命题
     *
     * 统一走 startOrchestration（SSE 编排），与右侧「多智能体协作」面板是同一条流程。
     * 此前本按钮走的是 store.generate（fire-and-forget + WS），与面板的 SSE 各跑各的，
     * 页面上因此出现两个语义重复的「启动」按钮，且从这里启动时右侧面板毫无反应。
     */
    const handleSubmit = useCallback(() => {
        startOrchestration()
    }, [startOrchestration])

    return (
        <div className="pr-wb-form">
            {/* 诗篇选择 */}
            <div className="pr-wb-form-group">
                <label className="pr-wb-form-label" htmlFor="wb-poem-select">
                    <Icon name="book-open" size={14} />
                    <span>目标诗篇</span>
                </label>
                <div className="pr-wb-poem-select-wrapper">
                    <Combobox
                        id="wb-poem-select"
                        className="pr-wb-poem-select"
                        value={poemId}
                        onChange={(v) => setPoemId(v as string)}
                        disabled={poemsLoading || generating}
                        ariaLabel="选择目标诗篇"
                        placeholder={poemsLoading ? '正在加载古诗列表…' : '请选择一首古诗'}
                        options={poems.map<ComboboxOption>((p) => ({
                            value: p.id,
                            label: `${p.title} · ${p.poet}（${p.dynasty}）`,
                        }))}
                    />
                </div>
                {poemsSource === 'fallback' && (
                    <div className="pr-wb-poem-source pr-wb-poem-source--fallback" role="status">
                        <Icon name="warning-circle" size={16} weight="bold" aria-hidden />
                        <div>
                            <strong>当前诗篇来自内置演示数据</strong>
                            <span>{poemsLoadError ?? '真实诗库暂不可用；恢复前不能启动命题或发布教学任务。'}</span>
                        </div>
                        <button type="button" onClick={() => void fetchPoems()} disabled={poemsLoading || generating}>
                            {poemsLoading ? '正在重试' : '重试真实诗库'}
                        </button>
                    </div>
                )}
                {poemsSource === 'live' && poemsLoadError && (
                    <div className="pr-wb-poem-source" role="status">
                        <Icon name="info" size={16} weight="bold" aria-hidden />
                        <div>
                            <strong>正在使用已加载的真实诗篇</strong>
                            <span>{poemsLoadError}</span>
                        </div>
                        <button type="button" onClick={() => void fetchPoems()} disabled={poemsLoading || generating}>
                            {poemsLoading ? '正在重试' : '重新同步'}
                        </button>
                    </div>
                )}
            </div>

            {/* 年级分段 */}
            <div className="pr-wb-form-group">
                <span className="pr-wb-form-label">
                    <Icon name="graduation" size={14} />
                    <span>年级分段</span>
                </span>
                <div className="pr-wb-segmented" role="radiogroup" aria-label="年级分段">
                    {GRADE_OPTIONS.map((opt) => {
                        const active = gradeLevel === opt.key
                        return (
                            <button
                                key={opt.key}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                className={`pr-wb-segmented-item${active ? ' is-active' : ''}`}
                                onClick={() => setGradeLevel(opt.key)}
                                disabled={generating}
                            >
                                <span className="pr-wb-segmented-label">{opt.label}</span>
                                <span className="pr-wb-segmented-short">{opt.short}</span>
                            </button>
                        )
                    })}
                </div>
            </div>

            {/* 题型标签 */}
            <div className="pr-wb-form-group">
                <span className="pr-wb-form-label">
                    <Icon name="list" size={14} />
                    <span>题型（可多选）</span>
                </span>
                <div className="pr-wb-chips" role="group" aria-label="题型选择">
                    {QUESTION_TYPE_OPTIONS.map((opt) => {
                        const active = questionTypes.includes(opt.key)
                        return (
                            <button
                                key={opt.key}
                                type="button"
                                aria-pressed={active}
                                className={`pr-wb-chip${active ? ' is-active' : ''}`}
                                onClick={() => toggleQuestionType(opt.key)}
                                disabled={generating}
                            >
                                <Icon name={opt.icon as 'list'} size={14} active={active} />
                                <span>{opt.key}</span>
                            </button>
                        )
                    })}
                </div>
            </div>

            {/* 六阶权重 + Canvas 饼图 */}
            <div className="pr-wb-form-group">
                <div className="pr-wb-bloom-header">
                    <span className="pr-wb-form-label">
                        <Icon name="chart-bar" size={14} />
                        <span>布鲁姆六阶权重</span>
                    </span>
                    <div className="pr-wb-presets" role="group" aria-label="权重预设">
                        {PRESET_KEYS.map((k) => (
                            <button
                                key={k}
                                type="button"
                                className={`pr-wb-preset${activePresetKey === k ? ' is-active' : ''}`}
                                onClick={() => applyPreset(k)}
                                disabled={generating}
                            >
                                {WORKBENCH_PRESETS[k]?.label ?? k}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="pr-wb-bloom-grid">
                    <div className="pr-wb-bloom-sliders">
                        {WORKBENCH_BLOOM_TIERS.map((tier) => (
                            <BloomSlider
                                key={tier.key}
                                level={tier.label}
                                value={bloomWeights[tier.key]}
                                color={WORKBENCH_BLOOM_COLORS[tier.label]}
                                disabled={generating}
                                onChange={(v) => setBloomWeight(tier.label, v)}
                            />
                        ))}
                    </div>
                    <BloomPieCanvas weights={bloomWeights} />
                </div>
            </div>

            {/* 数量 + 排除已用 */}
            <div className="pr-wb-form-row">
                <div className="pr-wb-form-group pr-wb-form-group--count">
                    <label className="pr-wb-form-label" htmlFor="wb-count">
                        <Icon name="list" size={14} />
                        <span>题目数量</span>
                    </label>
                    <div className="pr-wb-stepper">
                        <button
                            type="button"
                            className="pr-wb-stepper-btn"
                            onClick={() => setCount(count - 1)}
                            disabled={generating || count <= 1}
                            aria-label="减少"
                        >
                            <Icon name="minus" size={14} />
                        </button>
                        <input
                            id="wb-count"
                            type="number"
                            className="pr-wb-stepper-input"
                            value={count}
                            min={1}
                            max={20}
                            onChange={(e) => {
                                const v = Number.parseInt(e.target.value, 10)
                                if (!Number.isNaN(v)) setCount(v)
                            }}
                            disabled={generating}
                        />
                        <button
                            type="button"
                            className="pr-wb-stepper-btn"
                            onClick={() => setCount(count + 1)}
                            disabled={generating || count >= 20}
                            aria-label="增加"
                        >
                            <Icon name="plus" size={14} />
                        </button>
                    </div>
                </div>

                <div className="pr-wb-form-group pr-wb-form-group--exclude">
                    <span className="pr-wb-form-label">
                        <Icon name="arrows-clockwise" size={14} />
                        <span>排除已用题目</span>
                    </span>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={excludeUsedQuestions}
                        aria-label="排除最近已使用的题目"
                        className={`pr-wb-switch${excludeUsedQuestions ? ' is-on' : ''}`}
                        onClick={() => setExcludeUsedQuestions(!excludeUsedQuestions)}
                        disabled={generating}
                    >
                        <span className="pr-wb-switch-thumb" />
                    </button>
                </div>
            </div>

            {/* 生成按钮 */}
            <div className="pr-wb-form-actions">
                <Button
                    variant="primary"
                    size="lg"
                    block
                    leftIcon={<Icon name="sparkle" size={18} />}
                    loading={generating}
                    onClick={handleSubmit}
                    disabled={!poemId || poemsSource === 'fallback'}
                >
                    {generating ? '多智能体协作中…' : poemsSource === 'fallback' ? '等待真实诗库恢复' : '启动六阶命题'}
                </Button>
                {poemsSource === 'fallback' ? (
                    <p className="pr-wb-form-hint">内置诗篇只用于预览表单；请重试真实诗库后再启动命题。</p>
                ) : !poemId && !generating && (
                    <p className="pr-wb-form-hint">请先选择目标诗篇</p>
                )}
            </div>
        </div>
    )
})

/* ============================================================
 * 子组件：六阶权重滑块
 * ============================================================ */

interface BloomSliderProps {
    level: BloomLevel
    value: number
    color: string
    disabled?: boolean
    onChange: (value: number) => void
}

const BloomSlider = memo(function BloomSlider({
    level,
    value,
    color,
    disabled,
    onChange,
}: BloomSliderProps) {
    return (
        <div className="pr-wb-bloom-slider">
            <div className="pr-wb-bloom-slider-head">
                <span className="pr-wb-bloom-slider-dot" style={{ backgroundColor: color }} />
                <span className="pr-wb-bloom-slider-label">{level}</span>
                <span className="pr-wb-bloom-slider-value">{value}</span>
            </div>
            <input
                type="range"
                className="pr-wb-bloom-slider-input"
                min={0}
                max={100}
                step={1}
                value={value}
                disabled={disabled}
                onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
                style={{ '--pr-bloom-color': color } as React.CSSProperties}
                aria-label={`${level}权重`}
            />
        </div>
    )
})

/* ============================================================
 * 子组件：六阶权重饼图（Canvas 实时绘制）
 * ============================================================ */

interface BloomPieCanvasProps {
    weights: WorkbenchBloomWeightsLike
}

type WorkbenchBloomWeightsLike = Record<BloomLevel, number>

function BloomPieCanvas({ weights }: BloomPieCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null)

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        // 高 DPI 适配
        const dpr = window.devicePixelRatio || 1
        const rect = canvas.getBoundingClientRect()
        const size = Math.max(rect.width, 160)
        canvas.width = size * dpr
        canvas.height = size * dpr
        ctx.scale(dpr, dpr)

        const cx = size / 2
        const cy = size / 2
        const outerR = size / 2 - 4
        const innerR = outerR * 0.55

        ctx.clearRect(0, 0, size, size)

        // 解析 CSS 变量取色
        const computed = getComputedStyle(document.documentElement)
        const colors = WORKBENCH_BLOOM_TIERS.map((t) => {
            const cssVar = WORKBENCH_BLOOM_COLORS[t.label]
            // cssVar 形如 "rgb(var(--c-accent-info))"，需解析
            return resolveColor(cssVar, computed)
        })

        const values = WORKBENCH_BLOOM_TIERS.map((t) => weights[t.key])
        const total = values.reduce((a, b) => a + b, 0)

        // 总权重为 0 → 绘制空环
        // 规范 14.2：色值锚定 --c-surface-tertiary token（v5.0 实际值 237 232 226）
        if (total <= 0) {
            const surfaceTertiary = normalizeRgbChannels(
                computed.getPropertyValue('--c-surface-tertiary'),
                '237, 232, 226',
            )
            ctx.beginPath()
            ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
            ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true)
            ctx.fillStyle = `rgba(${surfaceTertiary}, 0.6)`
            ctx.fill()
            return
        }

        // 绘制扇形
        // Fallback 色锚定 --c-text-tertiary token（v5.0 暖调深灰），规范 14.2
        const segmentFallback = (() => {
            const txtTertiary = normalizeRgbChannels(
                computed.getPropertyValue('--c-text-tertiary'),
                '110, 102, 92',
            )
            return `rgba(${txtTertiary}, 0.8)`
        })()
        let startAngle = -Math.PI / 2
        WORKBENCH_BLOOM_TIERS.forEach((_tier, idx) => {
            const v = values[idx] ?? 0
            if (v <= 0) return
            const angle = (v / total) * Math.PI * 2
            ctx.beginPath()
            ctx.moveTo(cx, cy)
            ctx.arc(cx, cy, outerR, startAngle, startAngle + angle)
            ctx.closePath()
            ctx.fillStyle = colors[idx] ?? segmentFallback
            ctx.fill()
            startAngle += angle
        })

        // 中心环挖空（用 surface-secondary 覆盖）
        ctx.beginPath()
        ctx.arc(cx, cy, innerR, 0, Math.PI * 2)
        const surface = computed.getPropertyValue('--c-surface-secondary').trim()
        ctx.fillStyle = `rgb(${surface})`
        ctx.fill()

        // 中心文字：总权重
        ctx.fillStyle = `rgb(${computed.getPropertyValue('--c-text-primary').trim()})`
        ctx.font = `600 ${Math.max(size * 0.16, 16)}px var(--font-display, 'Inter')`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(total), cx, cy - 4)

        ctx.fillStyle = `rgb(${computed.getPropertyValue('--c-text-tertiary').trim()})`
        ctx.font = `500 ${Math.max(size * 0.08, 9)}px var(--font-sans, 'Inter')`
        ctx.fillText('总权重', cx, cy + size * 0.12)
    }, [weights])

    const totalWeight = WORKBENCH_BLOOM_TIERS.reduce((sum, tier) => sum + weights[tier.key], 0)

    return (
        <div className="pr-wb-pie-wrapper">
            <canvas
                ref={canvasRef}
                className="pr-wb-pie-canvas"
                role="img"
                aria-label={`六阶题目权重分布，总权重 ${totalWeight}`}
            />
            <div className="pr-wb-pie-legend">
                {WORKBENCH_BLOOM_TIERS.map((tier) => (
                    <div key={tier.key} className="pr-wb-pie-legend-item">
                        <span
                            className="pr-wb-pie-legend-swatch"
                            style={{ backgroundColor: WORKBENCH_BLOOM_COLORS[tier.label] }}
                        />
                        <span className="pr-wb-pie-legend-label">{tier.label}</span>
                        <span className="pr-wb-pie-legend-value">{weights[tier.key]}</span>
                    </div>
                ))}
            </div>
        </div>
    )
}

/**
 * 规范化 RGB 通道字符串（"237 232 226" 或 "237,232,226"）为 Canvas 可用的 "r, g, b" 格式。
 * tokens.css 中 --c-* 变量统一使用空格分隔（如 "237 232 226"），需转为逗号分隔以适配 rgba() 语法。
 */
function normalizeRgbChannels(value: string, fallback: string): string {
    const trimmed = value.trim()
    if (!trimmed) return fallback
    // 兼容空格分隔与逗号分隔两种输入
    return trimmed.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ' ').replace(/\s+/g, ', ')
}

/**
 * 解析 "rgb(var(--c-accent-info))" 形式的 CSS 变量字符串为可用的 rgb 字符串。
 * 失败时返回 --c-text-tertiary token 对应色值（v5.0 暖调深灰），避免 Canvas 渲染崩溃。
 * 规范 14.2：禁止硬编码色值，所有 fallback 必须锚定 tokens.css 变量。
 */
function resolveColor(cssVar: string, computed: CSSStyleDeclaration): string {
    const match = cssVar.match(/var\((--[^)]+)\)/)
    if (match) {
        const varName = match[1]
        if (varName) {
            const rgb = normalizeRgbChannels(computed.getPropertyValue(varName), '')
            if (rgb) return `rgb(${rgb})`
        }
    }
    // Fallback：--c-text-tertiary 实际值为 "110 102 92"（#6E665C 暖调深灰）
    const fallback = normalizeRgbChannels(computed.getPropertyValue('--c-text-tertiary'), '110, 102, 92')
    return `rgba(${fallback}, 0.8)`
}
