/**
 * WebSocket 事件类型常量（前端镜像）
 *
 * 与后端 backend/src/orchestrator/types.ts 中的 ORCH_EVENTS 完全对齐。
 * 前端 store 通过此常量匹配事件类型，避免硬编码字符串。
 */

export const ORCH_EVENTS = {
    INSTRUCTION_PARSED: 'orch:instruction:parsed',
    TASK_START: 'orch:task:start',
    TASK_PROGRESS: 'orch:task:progress',
    TASK_DONE: 'orch:task:done',
    TASK_FAILED: 'orch:task:failed',
    TASK_PAUSED: 'orch:task:paused',
    TASK_RESUMED: 'orch:task:resumed',
    TASK_SKIPPED: 'orch:task:skipped',
    SESSION_START: 'orch:session:start',
    SESSION_END: 'orch:session:end',
    REFLECTION: 'orch:reflection',
    TEACHER_FEEDBACK: 'orch:teacher:feedback',
} as const

export type OrchEventName = (typeof ORCH_EVENTS)[keyof typeof ORCH_EVENTS]
