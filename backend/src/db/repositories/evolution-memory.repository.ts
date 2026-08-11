/**
 * 自我进化引擎记忆仓储（Task 22 用，提前实现）
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type { EvolutionMemoryEntity, CreateEvolutionMemoryInput, EvolutionMemoryType } from '../types.js'
import { parseJson, stringifyJson } from '../utils/json.js'

export class EvolutionMemoryRepository extends BaseRepository<EvolutionMemoryEntity, CreateEvolutionMemoryInput> {
    constructor(db: Database.Database) {
        super(db, 'evolution_memory', 'id')
    }

    protected get mapper(): RowMapper<EvolutionMemoryEntity, CreateEvolutionMemoryInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                type: input.type,
                agent_id: input.agentId,
                pattern: input.pattern,
                before_prompt: input.beforePrompt ?? null,
                after_prompt: input.afterPrompt ?? null,
                improvement_reward: input.improvementReward ?? null,
                ab_test_result: stringifyJson(input.abTestResult ?? null),
                applied_at: input.appliedAt ?? null,
                metadata: stringifyJson(input.metadata ?? null),
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.type !== undefined) row['type'] = patch.type
                if (patch.agentId !== undefined) row['agent_id'] = patch.agentId
                if (patch.pattern !== undefined) row['pattern'] = patch.pattern
                if (patch.beforePrompt !== undefined) row['before_prompt'] = patch.beforePrompt
                if (patch.afterPrompt !== undefined) row['after_prompt'] = patch.afterPrompt
                if (patch.improvementReward !== undefined) row['improvement_reward'] = patch.improvementReward
                if (patch.abTestResult !== undefined) row['ab_test_result'] = stringifyJson(patch.abTestResult)
                if (patch.appliedAt !== undefined) row['applied_at'] = patch.appliedAt
                if (patch.metadata !== undefined) row['metadata'] = stringifyJson(patch.metadata)
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                type: row['type'] as EvolutionMemoryType,
                agentId: row['agent_id'] as string,
                pattern: row['pattern'] as string,
                beforePrompt: (row['before_prompt'] as string | null) ?? null,
                afterPrompt: (row['after_prompt'] as string | null) ?? null,
                improvementReward: (row['improvement_reward'] as number | null) ?? null,
                abTestResult: parseJson<Record<string, unknown>>(row['ab_test_result'] as string | null),
                createdAt: row['created_at'] as number,
                appliedAt: (row['applied_at'] as number | null) ?? null,
                metadata: parseJson(row['metadata'] as string | null),
            }),
        }
    }

    /** 按 Agent 查询 */
    findByAgentId(agentId: string): EvolutionMemoryEntity[] {
        return this.findByWhere({ agent_id: agentId }, 200, 0)
    }

    /** 按 Agent + 类型查询 */
    findByAgentAndType(agentId: string, type: EvolutionMemoryType): EvolutionMemoryEntity[] {
        return this.findByWhere({ agent_id: agentId, type }, 100, 0)
    }
}
