import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnswerRepository } from './answer.repository.js'
import { ClassRepository } from './class.repository.js'
import { EventRepository } from './event.repository.js'
import { EvolutionMemoryRepository } from './evolution-memory.repository.js'
import { LessonRepository } from './lesson.repository.js'
import {
    MarketplaceFeedbackRepository,
    MarketplaceForkRecordRepository,
    MarketplaceResourceRepository,
} from './marketplace-resource.repository.js'
import { MasteryRepository } from './mastery.repository.js'
import { PromptVersionRepository } from './prompt-version.repository.js'
import { QuestionRepository } from './question.repository.js'
import { RecitationRepository } from './recitation.repository.js'
import { StudentRepository } from './student.repository.js'
import { ThinkingChainRepository, splitReasoningIntoNodes } from './thinking-chain.repository.js'
import { DataExporter } from '../utils/export.js'

const TEST_SCHEMA = `
CREATE TABLE classes (id TEXT PRIMARY KEY, name TEXT, grade TEXT, teacher_id TEXT, student_count INTEGER, created_at INTEGER, updated_at INTEGER, metadata TEXT);
CREATE TABLE students (id TEXT PRIMARY KEY, class_id TEXT, name TEXT, anonymous_name TEXT, grade TEXT, cognitive_style TEXT, engagement_score REAL, created_at INTEGER, updated_at INTEGER, metadata TEXT);
CREATE TABLE lessons (id TEXT PRIMARY KEY, class_id TEXT, poem_id TEXT, teacher_id TEXT, scheduled_at INTEGER, started_at INTEGER, ended_at INTEGER, status TEXT, mode TEXT, created_at INTEGER, updated_at INTEGER, metadata TEXT);
CREATE TABLE questions (id TEXT PRIMARY KEY, poem_id TEXT, bloom_level TEXT, type TEXT, stem TEXT, options TEXT, answer TEXT, analysis TEXT, distractors_analysis TEXT, difficulty REAL, estimated_time_sec INTEGER, ai_generated INTEGER, prompt_version TEXT, created_at INTEGER, updated_at INTEGER, created_by TEXT, metadata TEXT);
CREATE TABLE answers (id TEXT PRIMARY KEY, student_id TEXT, question_id TEXT, lesson_id TEXT, answer_text TEXT, correct INTEGER, partial_score REAL, cognitive_attribution TEXT, feedback TEXT, teacher_hint TEXT, ai_confidence REAL, needs_human_review INTEGER, graded_by TEXT, graded_at INTEGER, submitted_at INTEGER, created_at INTEGER, updated_at INTEGER, metadata TEXT);
CREATE TABLE mastery (id TEXT PRIMARY KEY, student_id TEXT, poem_id TEXT, bloom_level TEXT, score REAL, attempts INTEGER, correct_count INTEGER, last_attempt_at INTEGER, created_at INTEGER, updated_at INTEGER, UNIQUE(student_id, poem_id, bloom_level));
CREATE TABLE events (id TEXT PRIMARY KEY, student_id TEXT, class_id TEXT, lesson_id TEXT, type TEXT, action TEXT, payload TEXT, poem_id TEXT, occurred_at INTEGER, recorded_at INTEGER, created_at INTEGER, updated_at INTEGER, metadata TEXT);
CREATE TABLE recitations (id TEXT PRIMARY KEY, student_id TEXT, poem_id TEXT, audio_url TEXT, transcript TEXT, pronunciation_score REAL, rhythm_score REAL, emotion_score REAL, mistakes TEXT, suggestion TEXT, audio_duration_sec REAL, ai_generated INTEGER, created_at INTEGER, updated_at INTEGER);
CREATE TABLE evolution_memory (id TEXT PRIMARY KEY, type TEXT, agent_id TEXT, pattern TEXT, before_prompt TEXT, after_prompt TEXT, improvement_reward REAL, ab_test_result TEXT, created_at INTEGER, updated_at INTEGER, applied_at INTEGER, metadata TEXT);
CREATE TABLE prompt_versions (id TEXT PRIMARY KEY, agent_id TEXT, version TEXT, system_prompt TEXT, user_prompt_template TEXT, changelog TEXT, is_active INTEGER, created_at INTEGER, updated_at INTEGER, UNIQUE(agent_id, version));
CREATE TABLE thinking_chains (id TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT, question TEXT, reasoning TEXT, answer TEXT, nodes TEXT, thinking_mode TEXT, duration_ms INTEGER, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, created_at INTEGER, updated_at INTEGER, metadata TEXT);
CREATE TABLE marketplace_resources (id TEXT PRIMARY KEY, title TEXT, description TEXT, type TEXT, content TEXT, tags TEXT, grade_level TEXT, bloom_weights TEXT, models_used TEXT, author_id TEXT, author_name TEXT, fork_count INTEGER, feedback_score REAL, feedback_count INTEGER, created_at INTEGER, updated_at INTEGER);
CREATE TABLE marketplace_fork_records (id TEXT PRIMARY KEY, resource_id TEXT, source_author TEXT, target_class_id TEXT, target_teacher TEXT, adaptation_meta TEXT, forked_at INTEGER, created_at INTEGER, updated_at INTEGER);
CREATE TABLE marketplace_feedback (id TEXT PRIMARY KEY, resource_id TEXT, rater_id TEXT, rater_name TEXT, score REAL, comment TEXT, created_at INTEGER, updated_at INTEGER);
CREATE VIEW v_student_bloom_radar AS SELECT student_id, bloom_level, AVG(score) AS avg_score, MAX(updated_at) AS last_updated FROM mastery GROUP BY student_id, bloom_level;
CREATE VIEW v_class_poem_mastery AS SELECT s.class_id, m.poem_id, m.bloom_level, AVG(m.score) AS avg_score, COUNT(DISTINCT m.student_id) AS student_count, COUNT(DISTINCT CASE WHEN m.score >= 60 THEN m.student_id END) AS mastered_count FROM mastery m JOIN students s ON m.student_id = s.id GROUP BY s.class_id, m.poem_id, m.bloom_level;
`

describe('repository integration contracts', () => {
    let db: Database.Database

    beforeEach(() => {
        db = new Database(':memory:')
        db.exec(TEST_SCHEMA)
    })

    afterEach(() => db.close())

    it('round-trips core entities and exercises query, update and delete paths', () => {
        const classes = new ClassRepository(db)
        const lessons = new LessonRepository(db)
        const questions = new QuestionRepository(db)
        const answers = new AnswerRepository(db)
        const mastery = new MasteryRepository(db)
        const events = new EventRepository(db)
        const recitations = new RecitationRepository(db)
        const evolution = new EvolutionMemoryRepository(db)
        const prompts = new PromptVersionRepository(db)
        const chains = new ThinkingChainRepository(db)

        const createdClass = classes.create({
            name: '五年级一班', grade: '五年级', teacherId: 'teacher-1', studentCount: 1, metadata: { source: 'test' },
        })
        expect(classes.findByTeacherId('teacher-1')).toHaveLength(1)
        expect(classes.count()).toBe(1)
        expect(classes.count({ teacher_id: 'teacher-1' })).toBe(1)
        expect(classes.update(createdClass.id, {})).toEqual(createdClass)
        expect(classes.update(createdClass.id, {
            name: '五年级甲班', grade: '五年级', teacherId: 'teacher-2', studentCount: 2, metadata: { revised: true },
        })?.teacherId).toBe('teacher-2')
        expect(classes.findAll(1, 0)).toHaveLength(1)

        db.prepare('INSERT INTO students VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
            'student-1', createdClass.id, '学生甲', '星河一号', '五年级', 'visual', 80, 1, 1, null,
        )
        const lesson = lessons.create({
            classId: createdClass.id, poemId: 'poem-1', teacherId: 'teacher-2', scheduledAt: 10,
            startedAt: 20, endedAt: 30, status: 'completed', mode: 'speed-pk', metadata: { unit: 1 },
        })
        expect(lessons.findByClassId(createdClass.id)).toHaveLength(1)
        expect(lessons.findByPoemId('poem-1')).toHaveLength(1)
        expect(lessons.update(lesson.id, {
            classId: createdClass.id, poemId: 'poem-2', teacherId: 'teacher-3', scheduledAt: 11,
            startedAt: 21, endedAt: 31, status: 'cancelled', mode: 'flying-flower', metadata: { unit: 2 },
        })?.status).toBe('cancelled')

        const question = questions.create({
            poemId: 'poem-1', bloomLevel: '理解', type: '选择', stem: '诗中写了什么？', options: ['月', '山'],
            answer: '月', analysis: '意象判断', distractorsAnalysis: ['正确', '干扰'], difficulty: 2,
            estimatedTimeSec: 30, aiGenerated: false, promptVersion: 'v1', createdBy: 'teacher-2', metadata: { checked: true },
        })
        expect(questions.findByPoemId('poem-1')).toHaveLength(1)
        expect(questions.findByPoemAndBloom('poem-1', '理解')).toHaveLength(1)
        expect(questions.update(question.id, {
            poemId: 'poem-2', bloomLevel: '应用', type: '简答', stem: '请解释', options: null, answer: '解释',
            analysis: null, distractorsAnalysis: null, difficulty: 4, estimatedTimeSec: 60, aiGenerated: true,
            promptVersion: null, createdBy: null, metadata: { revised: true },
        })?.aiGenerated).toBe(true)

        const answer = answers.create({
            studentId: 'student-1', questionId: question.id, lessonId: lesson.id, answerText: '月', correct: true,
            partialScore: 1, cognitiveAttribution: '理解正确', feedback: '继续保持', teacherHint: '补充意象',
            aiConfidence: 0.9, needsHumanReview: true, gradedBy: 'both', gradedAt: 40, submittedAt: 35,
            metadata: { channel: 'classroom' },
        })
        expect(answers.findByStudentId('student-1')).toHaveLength(1)
        expect(answers.findByQuestionId(question.id)).toHaveLength(1)
        expect(answers.findByLessonId(lesson.id)).toHaveLength(1)
        expect(answers.update(answer.id, {
            studentId: 'student-1', questionId: question.id, lessonId: null, answerText: '山', correct: null,
            partialScore: null, cognitiveAttribution: null, feedback: null, teacherHint: null, aiConfidence: null,
            needsHumanReview: false, gradedBy: 'teacher', gradedAt: null, metadata: { revised: true },
        })?.correct).toBeNull()

        const masteryFirst = mastery.upsertScore('student-1', 'poem-1', '记忆', 70, true)
        const masterySecond = mastery.upsertScore('student-1', 'poem-1', '记忆', 82, false)
        expect(masterySecond.attempts).toBe(2)
        expect(masterySecond.correctCount).toBe(1)
        expect(mastery.findByStudentPoemBloom('student-1', 'poem-1', '记忆')?.score).toBe(82)
        expect(mastery.findByStudentPoem('student-1', 'poem-1')).toHaveLength(1)
        expect(mastery.findByStudentId('student-1')).toHaveLength(1)
        expect(mastery.getStudentBloomRadarViaView('student-1')[0]?.avg_score).toBe(82)
        expect(mastery.getClassPoemMasteryViaView(createdClass.id, 'poem-1')).toHaveLength(1)
        expect(mastery.getClassBloomRadar(createdClass.id)).toHaveLength(1)
        expect(masteryFirst.id).toBe(masterySecond.id)

        const event = events.create({
            studentId: 'student-1', classId: createdClass.id, lessonId: lesson.id, type: 'answer', action: 'submit',
            payload: { score: 82 }, poemId: 'poem-1', occurredAt: 100, recordedAt: 101, metadata: { trace: 't1' },
        })
        expect(events.findRecentByStudentId('student-1')).toHaveLength(1)
        expect(events.findByClassAndTimeRange(createdClass.id, 0, 200)).toHaveLength(1)
        expect(events.findByClassAndTimeRange(createdClass.id, 0, 200, 'answer')).toHaveLength(1)
        expect(events.countByStudentSince('student-1', 0)[0]).toMatchObject({ type: 'answer', cnt: 1 })
        expect(events.update(event.id, {
            studentId: null, classId: null, lessonId: null, type: 'other', action: 'review', payload: null,
            poemId: null, occurredAt: 102, metadata: { reviewed: true },
        })?.type).toBe('other')

        const recitation = recitations.create({
            studentId: 'student-1', poemId: 'poem-1', audioUrl: '/audio/test.wav', transcript: '床前明月光',
            pronunciationScore: 90, rhythmScore: 88, emotionScore: 86, mistakes: [{ word: '光' }],
            suggestion: '放慢', audioDurationSec: 12, aiGenerated: false,
        })
        expect(recitations.findByStudentId('student-1')).toHaveLength(1)
        expect(recitations.findByPoemId('poem-1')).toHaveLength(1)
        expect(recitations.update(recitation.id, {
            studentId: 'student-1', poemId: 'poem-2', audioUrl: null, transcript: null,
            pronunciationScore: null, rhythmScore: null, emotionScore: null, mistakes: null,
            suggestion: null, audioDurationSec: null, aiGenerated: true,
        })?.aiGenerated).toBe(true)

        const memory = evolution.create({
            type: 'tactical', agentId: 'poem-agent', pattern: '遗漏出处', beforePrompt: '旧', afterPrompt: '新',
            improvementReward: 0.2, abTestResult: { win: true }, appliedAt: 200, metadata: { source: 'review' },
        })
        expect(evolution.findByAgentId('poem-agent')).toHaveLength(1)
        expect(evolution.findByAgentAndType('poem-agent', 'tactical')).toHaveLength(1)
        expect(evolution.update(memory.id, {
            type: 'strategic', agentId: 'mind-agent', pattern: '新模式', beforePrompt: null, afterPrompt: null,
            improvementReward: null, abTestResult: null, appliedAt: null, metadata: null,
        })?.type).toBe('strategic')

        const promptV1 = prompts.create({
            agentId: 'eye-agent', version: '1.0.0', systemPrompt: '识别', userPromptTemplate: '{{input}}', changelog: '初版', isActive: true,
        })
        prompts.create({ agentId: 'eye-agent', version: '1.1.0', systemPrompt: '识别并核验', isActive: false })
        expect(prompts.findByAgentId('eye-agent')).toHaveLength(2)
        expect(prompts.findActiveByAgentId('eye-agent')?.version).toBe('1.0.0')
        expect(prompts.findByAgentAndVersion('eye-agent', '1.1.0')).not.toBeNull()
        prompts.setActive('eye-agent', '1.1.0')
        expect(prompts.findActiveByAgentId('eye-agent')?.version).toBe('1.1.0')
        expect(prompts.update(promptV1.id, {
            agentId: 'eye-agent', version: '0.9.0', systemPrompt: '旧识别', userPromptTemplate: null,
            changelog: null, isActive: false,
        })?.version).toBe('0.9.0')

        const reasoning = '假设学生混淆意象。\n\n依据答题记录可见错误。\n\n结论是先做对比练习。'
        const nodes = splitReasoningIntoNodes(reasoning)
        expect(nodes.map((node) => node.type)).toEqual(['hypothesis', 'evidence', 'conclusion'])
        expect(splitReasoningIntoNodes('')).toEqual([])
        expect(splitReasoningIntoNodes(`${'因为需要验证。'.repeat(40)}`)).toHaveLength(40)
        const chain = chains.create({
            agentId: 'mind-agent', sessionId: 'session-1', question: '为何错误？', reasoning,
            answer: '先对比', nodes, thinkingMode: 'high', durationMs: 1200, model: 'deepseek-v4-pro',
            promptTokens: 100, completionTokens: 80, metadata: { source: 'diagnosis' },
        })
        expect(chains.findByAgentId('mind-agent')).toHaveLength(1)
        expect(chains.findBySessionId('session-1')).toHaveLength(1)
        expect(chains.findRecent()).toHaveLength(1)
        expect(chains.countByAgent('mind-agent')).toBe(1)
        expect(chains.update(chain.id, {
            agentId: 'mind-agent-2', sessionId: 'session-2', question: '如何改进？', reasoning: '为什么会错？',
            answer: null, nodes: [], thinkingMode: 'max', durationMs: 900, model: 'deepseek-v4-flash',
            promptTokens: 50, completionTokens: 40, metadata: null,
        })?.thinkingMode).toBe('max')

        expect(classes.delete(createdClass.id)).toBe(true)
        expect(classes.delete(createdClass.id)).toBe(false)
        expect(classes.findById('missing')).toBeNull()
    })

    it('supports marketplace filtering, fork trends and feedback aggregation', () => {
        const resources = new MarketplaceResourceRepository(db)
        const forks = new MarketplaceForkRecordRepository(db)
        const feedback = new MarketplaceFeedbackRepository(db)
        const bloomWeights = { 记忆: 10, 理解: 20, 应用: 20, 分析: 20, 评价: 15, 创造: 15 }
        const resource = resources.create({
            title: '月意象分层教案', description: '适合五年级的月意象教学', type: 'lesson-template',
            content: '# 教案', tags: ['月', '意象'], gradeLevel: '五年级', bloomWeights,
            modelsUsed: ['deepseek-v4-pro'], authorId: 'teacher-1', authorName: '李老师',
            forkCount: 1, feedbackScore: 4, feedbackCount: 1,
        })
        expect(resources.search({})).toHaveLength(1)
        expect(resources.search({
            type: 'lesson-template', gradeLevel: '五年级', tag: '月%_', model: 'deepseek-v4-pro', keyword: '意象%_', limit: 10, offset: 0,
        })).toHaveLength(1)
        resources.incrementForkCount(resource.id)
        expect(resources.findById(resource.id)?.forkCount).toBe(2)
        expect(resources.update(resource.id, {
            title: '更新教案', description: null, type: 'prompt-recipe', content: 'prompt', tags: ['更新'],
            gradeLevel: null, bloomWeights: null, modelsUsed: [], authorId: null, authorName: null,
            forkCount: 3, feedbackScore: 0, feedbackCount: 0,
        })?.type).toBe('prompt-recipe')

        const fork = forks.create({
            resourceId: resource.id, sourceAuthor: '李老师', targetClassId: 'class-1', targetTeacher: '王老师',
            adaptationMeta: { difficulty: 'medium' }, forkedAt: 1_700_000_000_000,
        })
        expect(forks.findByResource(resource.id)).toHaveLength(1)
        expect(forks.findByClass('class-1')).toHaveLength(1)
        expect(forks.aggregateByDay(resource.id, 0)[0]?.count).toBe(1)
        expect(forks.update(fork.id, {
            resourceId: resource.id, sourceAuthor: null, targetClassId: null, targetTeacher: null,
            adaptationMeta: null, forkedAt: 1_700_000_100_000,
        })?.targetClassId).toBeNull()

        const feedbackA = feedback.create({
            resourceId: resource.id, raterId: 'rater-1', raterName: '教师甲', score: 4.5, comment: '可复用',
        })
        feedback.create({ resourceId: resource.id, score: 2.5 })
        expect(feedback.findByResource(resource.id)).toHaveLength(2)
        expect(feedback.distribution(resource.id).reduce((sum, item) => sum + item.count, 0)).toBe(2)
        expect(feedback.update(feedbackA.id, {
            resourceId: resource.id, raterId: null, raterName: null, score: 5, comment: null,
        })?.score).toBe(5)
        resources.recomputeFeedbackStats(resource.id)
        expect(resources.findById(resource.id)).toMatchObject({ feedbackCount: 2, feedbackScore: 3.75 })

        db.prepare('UPDATE marketplace_resources SET tags = ?, models_used = ? WHERE id = ?').run('{}', '{}', resource.id)
        expect(resources.findById(resource.id)).toMatchObject({ tags: [], modelsUsed: [] })
    })

    it('exports an anonymized class report without leaking student names', () => {
        const classes = new ClassRepository(db)
        const students = new StudentRepository(db)
        const events = new EventRepository(db)
        const mastery = new MasteryRepository(db)
        const createdClass = classes.create({ name: '六年级一班', grade: '六年级', teacherId: 'teacher-report' })
        const student = students.create({
            classId: createdClass.id,
            name: '真实姓名不应导出',
            anonymousName: '星河七号',
            grade: '六年级',
        })
        mastery.create({ studentId: student.id, poemId: 'poem-report', bloomLevel: '记忆', score: 86 })
        mastery.create({ studentId: student.id, poemId: 'poem-report', bloomLevel: '理解', score: 74 })
        events.create({
            studentId: student.id,
            classId: createdClass.id,
            type: 'answer',
            action: 'submit',
            occurredAt: 100,
            recordedAt: 101,
        })
        events.create({ classId: createdClass.id, type: 'classroom', action: 'start', occurredAt: 102, recordedAt: 103 })

        const exporter = new DataExporter({
            classRepo: classes,
            studentRepo: students,
            eventRepo: events,
            masteryRepo: mastery,
        })
        const report = exporter.exportClassReportData(createdClass.id, { from: 0, to: 200 })

        expect(report).toMatchObject({
            className: '六年级一班',
            classId: createdClass.id,
            aiGenerated: true,
            classBloomRadar: { 记忆: 86, 理解: 74, 应用: 0, 分析: 0, 评价: 0, 创造: 0 },
        })
        expect(report.studentRadars[0]).toMatchObject({
            studentId: student.id,
            anonymousName: '星河七号',
            radar: { 记忆: 86, 理解: 74 },
        })
        expect(report.events).toEqual(expect.arrayContaining([
            expect.objectContaining({ studentId: student.id, anonymousName: '星河七号' }),
            expect.objectContaining({ studentId: null, anonymousName: null }),
        ]))
        expect(JSON.stringify(report)).not.toContain('真实姓名不应导出')
        expect(() => exporter.exportClassReportData('missing-class', { from: 0, to: 1 }))
            .toThrow('[exporter] 班级不存在')
    })
})
