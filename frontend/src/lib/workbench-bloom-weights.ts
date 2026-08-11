import type { BloomLevel, WorkbenchBloomWeights } from './types'

/** 固定顺序同时决定全零均分和最大余数相同时的余数归属。 */
export const WORKBENCH_BLOOM_ORDER = [
    '记忆',
    '理解',
    '应用',
    '分析',
    '评价',
    '创造',
] as const satisfies readonly BloomLevel[]

function toSafeIntegerWeight(value: unknown): number {
    if (value === Number.POSITIVE_INFINITY) return 100
    if (value === Number.NEGATIVE_INFINITY || !Number.isFinite(value as number)) return 0
    return Math.max(0, Math.min(100, Math.round(value as number)))
}

/**
 * 修改一个 Bloom 权重后，按其余五项当前占比稳定重分配剩余百分比。
 *
 * - 所有结果都是 0..100 整数且严格合计 100；
 * - 比例换算采用最大余数法，余数相同按六阶固定顺序分配；
 * - 其余项全为 0 时均匀分配，不能整除的余数仍按固定顺序分配；
 * - NaN/未知值按 0，+Infinity 按 100，-Infinity 按 0，绝不污染 store。
 */
export function rebalanceBloomWeights(
    current: WorkbenchBloomWeights,
    changedLevel: BloomLevel,
    requestedValue: number,
): WorkbenchBloomWeights {
    const changedValue = toSafeIntegerWeight(requestedValue)
    const remaining = 100 - changedValue
    const otherLevels = WORKBENCH_BLOOM_ORDER.filter((level) => level !== changedLevel)
    const currentOthers = otherLevels.map((level, order) => ({
        level,
        order,
        weight: toSafeIntegerWeight(current[level]),
    }))
    const currentOtherTotal = currentOthers.reduce((sum, item) => sum + item.weight, 0)
    const result = {} as WorkbenchBloomWeights
    result[changedLevel] = changedValue

    if (currentOtherTotal === 0) {
        const base = Math.floor(remaining / otherLevels.length)
        let remainder = remaining - base * otherLevels.length
        for (const level of otherLevels) {
            result[level] = base + (remainder > 0 ? 1 : 0)
            if (remainder > 0) remainder -= 1
        }
        return result
    }

    const allocations = currentOthers.map((item) => {
        const exact = (remaining * item.weight) / currentOtherTotal
        const allocated = Math.floor(exact)
        return { ...item, allocated, fraction: exact - allocated }
    })
    let remainder = remaining - allocations.reduce((sum, item) => sum + item.allocated, 0)
    const remainderOrder = [...allocations].sort(
        (left, right) => right.fraction - left.fraction || left.order - right.order,
    )
    for (let index = 0; remainder > 0; index += 1, remainder -= 1) {
        const item = remainderOrder[index % remainderOrder.length]
        if (item) item.allocated += 1
    }
    for (const item of allocations) result[item.level] = item.allocated
    return result
}
