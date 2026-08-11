/** 智能赋分参与者关系校验结果。 */
export type SmartScoreParticipantResolution =
    | { accepted: false; reason: 'STUDENT_CLASS_MISMATCH' }
    | { accepted: true; displayName: string; persistent: boolean }

/**
 * 把“真实学生归属”与“课堂内合成参与者”分开处理。
 *
 * - 数据库真实学生必须属于当前课堂班级，且展示名只取脱敏真相源；
 * - 查不到的 ID 可作为玩法内合成参与者，但永不允许写 mastery。
 */
export function resolveSmartScoreParticipant(
    runtimeClassId: string,
    studentId: string,
    knownStudent: { classId: string; anonymousName: string } | null,
    runtimeDisplayName: string | undefined,
    requestedDisplayName: string | undefined,
): SmartScoreParticipantResolution {
    if (knownStudent && knownStudent.classId !== runtimeClassId) {
        return { accepted: false, reason: 'STUDENT_CLASS_MISMATCH' }
    }
    if (knownStudent) {
        return {
            accepted: true,
            displayName: knownStudent.anonymousName,
            persistent: true,
        }
    }
    return {
        accepted: true,
        displayName: runtimeDisplayName ?? requestedDisplayName ?? studentId,
        persistent: false,
    }
}
