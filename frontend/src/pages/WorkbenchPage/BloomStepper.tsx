/**
 * 六阶步骤条 BloomStepper（SubTask 10.2）
 *
 * 以布鲁姆六阶（记忆→理解→应用→分析→评价→创造）为锚点，
 * 根据当前 agentTasks 进度，点亮对应阶层的圆点。
 *
 * 视觉特征：
 * - 六个圆点横向排列，用极淡 alpha 线连接
 * - 已完成阶：实色填充 + check 图标
 * - 进行中阶：脉动呼吸动画（ring 扩散）
 * - 未开始阶：surface-tertiary 描边
 * - 每个圆点下方显示阶层中文名 + 当前 Agent 名称
 *
 * 进度推断逻辑：
 * - agentTasks 中的 agentId 含 "brush.question" → 命题阶段，按生成顺序推进
 * - agentId 含 "mind.verify" → 验收阶段，全部点亮
 * - 失败时对应阶变红
 */

import { memo } from 'react'
import { Icon } from '@/components/ui'
import { useWorkbenchStore } from '@/stores/workbench'
import { WORKBENCH_BLOOM_TIERS, WORKBENCH_BLOOM_COLORS } from '@/lib/types'
import type { BloomLevel } from '@/lib/types'

/** Agent 名称中文映射 */
const AGENT_LABELS: Record<string, string> = {
    'brush.question': '诗笔·命题',
    'mind.verify': '诗心·验收',
    'orchestrator': '编排官',
}

/** 阶层状态 */
type TierStatus = 'idle' | 'running' | 'success' | 'failed'

export const BloomStepper = memo(function BloomStepper() {
    const agentTasks = useWorkbenchStore((s) => s.agentTasks)
    const questions = useWorkbenchStore((s) => s.questions)
    const generating = useWorkbenchStore((s) => s.generating)
    const currentAgentId = useWorkbenchStore((s) => s.currentAgentId)

    // 推断每个阶层的进度状态
    const tierStatuses = inferTierStatuses(agentTasks, questions, generating, currentAgentId)

    return (
        <div className="pr-wb-stepper" role="progressbar" aria-label="六阶命题进度">
            <div className="pr-wb-stepper-track">
                {WORKBENCH_BLOOM_TIERS.map((tier, idx) => (
                    <BloomStep
                        key={tier.key}
                        level={tier.label}
                        index={idx}
                        status={tierStatuses[idx] ?? 'idle'}
                    />
                ))}
            </div>
        </div>
    )
})

/* ============================================================
 * 子组件：单个步骤点
 * ============================================================ */

interface BloomStepProps {
    level: BloomLevel
    index: number
    status: TierStatus
}

function BloomStep({ level, index, status }: BloomStepProps) {
    const color = WORKBENCH_BLOOM_COLORS[level]
    return (
        <div className={`pr-wb-step pr-wb-step--${status}`}>
            <div className="pr-wb-step-node-wrap">
                {index > 0 && <span className="pr-wb-step-connector" aria-hidden />}
                <div
                    className="pr-wb-step-node"
                    style={{ '--pr-step-color': color } as React.CSSProperties}
                >
                    {status === 'success' ? (
                        <Icon name="check" size={12} weight="bold" />
                    ) : status === 'running' ? (
                        <span className="pr-wb-step-pulse" aria-hidden />
                    ) : status === 'failed' ? (
                        <Icon name="x" size={12} weight="bold" />
                    ) : (
                        <span className="pr-wb-step-index">{index + 1}</span>
                    )}
                </div>
                {status === 'running' && <span className="pr-wb-step-ring" aria-hidden />}
            </div>
            <div className="pr-wb-step-label">{level}</div>
        </div>
    )
}

/* ============================================================
 * 进度推断
 * ============================================================ */

/**
 * 根据当前 agentTasks 与已生成题目，推断六阶每层的状态。
 *
 * 推断策略：
 * 1. 若有题目已生成，按题目的 bloomLevel 标记对应阶为 success
 * 2. 若正在生成且当前 agentId 为 brush.question，标记"下一未完成阶"为 running
 * 3. 若有 task failed，标记其 agentId 对应阶段为 failed
 * 4. 其余为 idle
 */
function inferTierStatuses(
    agentTasks: Array<{ agentId: string; status: string }>,
    questions: Array<{ bloomLevel: BloomLevel }>,
    generating: boolean,
    currentAgentId: string | null,
): TierStatus[] {
    const statuses: TierStatus[] = WORKBENCH_BLOOM_TIERS.map(() => 'idle' as TierStatus)

    // 1. 已生成的题目覆盖到的阶层 → success
    const coveredLevels = new Set(questions.map((q) => q.bloomLevel))
    WORKBENCH_BLOOM_TIERS.forEach((tier, idx) => {
        if (coveredLevels.has(tier.label)) {
            statuses[idx] = 'success'
        }
    })

    // 3. 失败任务标记
    const hasFailed = agentTasks.some((t) => t.status === 'failed')
    if (hasFailed && !generating) {
        // 将第一个 idle 阶标记为 failed（粗粒度，仅用于视觉反馈）
        const firstIdle = statuses.findIndex((s) => s === 'idle')
        if (firstIdle >= 0) statuses[firstIdle] = 'failed'
    }

    // 2. 进行中：标记下一未完成阶
    if (generating && currentAgentId) {
        const isVerifyPhase = currentAgentId.includes('verify')
        if (isVerifyPhase) {
            // 验收阶段：全部已生成阶标记 success，进行中标记运行在最后一阶
            const lastSuccess = statuses.lastIndexOf('success')
            if (lastSuccess >= 0) {
                statuses[lastSuccess] = 'running'
            }
        } else {
            // 命题阶段：第一个 idle 阶标记为 running
            const firstIdle = statuses.findIndex((s) => s === 'idle')
            if (firstIdle >= 0) {
                statuses[firstIdle] = 'running'
            } else {
                // 所有阶都已覆盖，标记最后一阶为 running（验收前）
                statuses[statuses.length - 1] = 'running'
            }
        }
    }

    return statuses
}

/** 导出 Agent 标签映射供其他组件复用 */
export { AGENT_LABELS }
