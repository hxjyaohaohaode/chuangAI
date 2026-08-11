/**
 * Prompt 版本仓储（Task 22 用，提前实现）
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type { PromptVersionEntity, CreatePromptVersionInput } from '../types.js'

export class PromptVersionRepository extends BaseRepository<PromptVersionEntity, CreatePromptVersionInput> {
    constructor(db: Database.Database) {
        super(db, 'prompt_versions', 'id')
    }

    protected get mapper(): RowMapper<PromptVersionEntity, CreatePromptVersionInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                agent_id: input.agentId,
                version: input.version,
                system_prompt: input.systemPrompt,
                user_prompt_template: input.userPromptTemplate ?? null,
                changelog: input.changelog ?? null,
                is_active: input.isActive ? 1 : 0,
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.agentId !== undefined) row['agent_id'] = patch.agentId
                if (patch.version !== undefined) row['version'] = patch.version
                if (patch.systemPrompt !== undefined) row['system_prompt'] = patch.systemPrompt
                if (patch.userPromptTemplate !== undefined) row['user_prompt_template'] = patch.userPromptTemplate
                if (patch.changelog !== undefined) row['changelog'] = patch.changelog
                if (patch.isActive !== undefined) row['is_active'] = patch.isActive ? 1 : 0
                return row
            },
            fromRow: (row) => ({
                id: row['id'] as string,
                agentId: row['agent_id'] as string,
                version: row['version'] as string,
                systemPrompt: row['system_prompt'] as string,
                userPromptTemplate: (row['user_prompt_template'] as string | null) ?? null,
                changelog: (row['changelog'] as string | null) ?? null,
                isActive: (row['is_active'] as number) === 1,
                createdAt: row['created_at'] as number,
            }),
        }
    }

    /** 按 Agent 查询所有版本 */
    findByAgentId(agentId: string): PromptVersionEntity[] {
        return this.findByWhere({ agent_id: agentId }, 100, 0)
    }

    /** 查询 Agent 当前活跃版本 */
    findActiveByAgentId(agentId: string): PromptVersionEntity | null {
        const list = this.findByWhere({ agent_id: agentId, is_active: 1 }, 1, 0)
        return list[0] ?? null
    }

    /** 按 Agent + 版本号精确查询 */
    findByAgentAndVersion(agentId: string, version: string): PromptVersionEntity | null {
        const list = this.findByWhere({ agent_id: agentId, version }, 1, 0)
        return list[0] ?? null
    }

    /**
     * 将某版本设为活跃（同时将该 Agent 其他版本置为非活跃）
     * 调用方应包裹在事务中。
     */
    setActive(agentId: string, version: string): void {
        this.db
            .prepare(`UPDATE prompt_versions SET is_active = 0 WHERE agent_id = ?`)
            .run(agentId)
        this.db
            .prepare(`UPDATE prompt_versions SET is_active = 1 WHERE agent_id = ? AND version = ?`)
            .run(agentId, version)
    }
}
