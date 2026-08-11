/**
 * 作答仓储
 */
import type Database from 'better-sqlite3'
import { BaseRepository, type RowMapper } from './base.repository.js'
import type { AnswerEntity, CreateAnswerInput, GradedBy } from '../types.js'
import { parseJson, stringifyJson } from '../utils/json.js'

export class AnswerRepository extends BaseRepository<AnswerEntity, CreateAnswerInput> {
    constructor(db: Database.Database) {
        super(db, 'answers', 'id')
    }

    protected get mapper(): RowMapper<AnswerEntity, CreateAnswerInput> {
        return {
            toRow: (input) => ({
                id: input.id ?? null,
                student_id: input.studentId,
                question_id: input.questionId,
                lesson_id: input.lessonId ?? null,
                answer_text: input.answerText,
                correct: input.correct === null ? null : input.correct === undefined ? null : input.correct ? 1 : 0,
                partial_score: input.partialScore ?? null,
                cognitive_attribution: input.cognitiveAttribution ?? null,
                feedback: input.feedback ?? null,
                teacher_hint: input.teacherHint ?? null,
                ai_confidence: input.aiConfidence ?? null,
                needs_human_review: input.needsHumanReview ? 1 : 0,
                graded_by: input.gradedBy ?? null,
                graded_at: input.gradedAt ?? null,
                submitted_at: input.submittedAt,
                metadata: stringifyJson(input.metadata ?? null),
            }),
            toUpdateRow: (patch) => {
                const row: Record<string, unknown> = {}
                if (patch.studentId !== undefined) row['student_id'] = patch.studentId
                if (patch.questionId !== undefined) row['question_id'] = patch.questionId
                if (patch.lessonId !== undefined) row['lesson_id'] = patch.lessonId
                if (patch.answerText !== undefined) row['answer_text'] = patch.answerText
                if (patch.correct !== undefined) {
                    row['correct'] = patch.correct === null ? null : patch.correct ? 1 : 0
                }
                if (patch.partialScore !== undefined) row['partial_score'] = patch.partialScore
                if (patch.cognitiveAttribution !== undefined) row['cognitive_attribution'] = patch.cognitiveAttribution
                if (patch.feedback !== undefined) row['feedback'] = patch.feedback
                if (patch.teacherHint !== undefined) row['teacher_hint'] = patch.teacherHint
                if (patch.aiConfidence !== undefined) row['ai_confidence'] = patch.aiConfidence
                if (patch.needsHumanReview !== undefined) row['needs_human_review'] = patch.needsHumanReview ? 1 : 0
                if (patch.gradedBy !== undefined) row['graded_by'] = patch.gradedBy
                if (patch.gradedAt !== undefined) row['graded_at'] = patch.gradedAt
                if (patch.metadata !== undefined) row['metadata'] = stringifyJson(patch.metadata)
                return row
            },
            fromRow: (row) => {
                const correctRaw = row['correct'] as number | null | undefined
                return {
                    id: row['id'] as string,
                    studentId: row['student_id'] as string,
                    questionId: row['question_id'] as string,
                    lessonId: (row['lesson_id'] as string | null) ?? null,
                    answerText: row['answer_text'] as string,
                    correct: correctRaw === null || correctRaw === undefined ? null : correctRaw === 1,
                    partialScore: (row['partial_score'] as number | null) ?? null,
                    cognitiveAttribution: (row['cognitive_attribution'] as string | null) ?? null,
                    feedback: (row['feedback'] as string | null) ?? null,
                    teacherHint: (row['teacher_hint'] as string | null) ?? null,
                    aiConfidence: (row['ai_confidence'] as number | null) ?? null,
                    needsHumanReview: (row['needs_human_review'] as number) === 1,
                    gradedBy: (row['graded_by'] as GradedBy | null) ?? null,
                    gradedAt: (row['graded_at'] as number | null) ?? null,
                    submittedAt: row['submitted_at'] as number,
                    metadata: parseJson(row['metadata'] as string | null),
                }
            },
        }
    }

    /** 按学生查询作答 */
    findByStudentId(studentId: string, limit = 100): AnswerEntity[] {
        return this.findByWhere({ student_id: studentId }, limit, 0)
    }

    /** 按题目查询作答 */
    findByQuestionId(questionId: string): AnswerEntity[] {
        return this.findByWhere({ question_id: questionId }, 500, 0)
    }

    /** 按课程查询作答 */
    findByLessonId(lessonId: string): AnswerEntity[] {
        return this.findByWhere({ lesson_id: lessonId }, 500, 0)
    }
}
