/**
 * 进化视图中的 Agent 标识必须在紧凑图表和模式卡中明确表达截断，不能让
 * `slice` 把一个仍然存在的真实标识伪装成较短的另一标识。Array.from 保留
 * Unicode 码位边界；完整值仍由调用点的 title 暴露给鼠标与辅助工具链。
 */
export function formatCompactAgentId(agentId: string, maxVisibleCharacters = 8): string {
    const characters = Array.from(agentId)
    const limit = Math.max(2, Math.floor(maxVisibleCharacters))

    if (characters.length <= limit) return agentId

    return `${characters.slice(0, limit - 1).join('')}…`
}
