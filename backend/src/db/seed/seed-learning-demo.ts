/**
 * 演示学情数据种子脚本（**显式执行，不随服务启动自动运行**）
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么单独成一个脚本，而不是并入 seedDatabase()
 * ─────────────────────────────────────────────────────────────
 * `db/index.ts` 的 seedDatabase() 有一条明确原则：只写教学**资源**
 * （班级、学生名册、诗库、基础题库），绝不写 mastery / answers 这类
 * **学生表现数据**——因为凭空生成的成绩会被下游当成真实学情，用来
 * 驱动诊断结论与教研报告，那是危险的。这条原则必须保留。
 *
 * 但空库也带来一个真实问题：六阶雷达、认知热力图、暗物质检测、周进度、
 * 班级预警全都依赖作答记录，没有数据时整个诊断链路只能展示空状态，
 * 评审与演示时无法体现系统真正的分析能力。
 *
 * 折中方案就是本脚本：**显式、可复现、可撤销、且全程自标注**。
 *   npm run seed:learning        写入演示学情
 *   npm run seed:learning:clear  清除本脚本写入的全部数据
 *
 * ─────────────────────────────────────────────────────────────
 * 数据可识别性（重要）
 * ─────────────────────────────────────────────────────────────
 * 本脚本写入的每一条 answers / mastery / events 记录都在 metadata 中带有
 * `seedSource: 'learning-demo-v1'` 标记。因此：
 *   1. 任何人都能在库里一眼区分「演示数据」与「真实课堂产生的数据」；
 *   2. clear 操作只删除带该标记的行，绝不误伤教师真实录入的数据。
 *
 * ─────────────────────────────────────────────────────────────
 * 生成模型（可解释，非随机凑数）
 * ─────────────────────────────────────────────────────────────
 * - 固定种子 mulberry32(20260725)，同一份代码永远生成同一份数据；
 * - 学生能力：正态分布 N(68, 14)，截断到 [30, 98]；
 * - 六阶难度惩罚：记忆 0 / 理解 5 / 应用 10 / 分析 15 / 评价 20 / 创造 25，
 *   符合布卢姆分类学"高阶认知达成度更低"的教学规律；
 * - 单题得分 = clamp(学生能力 - 阶层惩罚 + N(0, 8), 0, 100)，≥60 记为正确；
 * - 认知暗物质刻意注入：每个班随机选 2 个 (诗篇, 阶层) 组合额外 -18 分，
 *   让暗物质检测算法有真实可检出的目标，而不是面对一片均匀数据。
 */

import { db, initDatabase } from '../index.js'
import { syntheticStudentName } from './synthetic-roster.js'
import { pathToFileURL } from 'node:url'

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** 种子标记：写入 metadata.seedSource，用于识别与清除 */
export const LEARNING_SEED_TAG = 'learning-demo-v1'

/** 布卢姆六阶（由易到难，与 questions.bloom_level 取值一致） */
const BLOOM_LEVELS = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const
type BloomLevel = (typeof BLOOM_LEVELS)[number]

/** 各阶层难度惩罚（分） */
const BLOOM_PENALTY: Record<BloomLevel, number> = {
    记忆: 0,
    理解: 5,
    应用: 10,
    分析: 15,
    评价: 20,
    创造: 25,
}

/** 需要补齐名册并生成学情的班级 */
const TARGET_CLASSES = ['class-001', 'class-002', 'class-003'] as const

/** 每个班覆盖的教学诗篇数量（按 tongbian 序号取前 N 首） */
const POEMS_PER_CLASS = 12

/** 认知风格（循环分配） */
const COGNITIVE_STYLES = ['visual', 'auditory', 'kinesthetic'] as const

const DAY_MS = 86_400_000

/** 学期起点：种子学生的入学时间回填到此，避免被统计成「本周新增」 */
const semesterStart = Date.now() - 120 * DAY_MS

/**
 * 第 idx 节课的时间
 *
 * 排布依据是驾驶舱三个统计口径各自的时间窗：
 *   - 「今日学习总时长」统计 started_at 落在今天的课 → 最后一节放在今天 3 小时前
 *   - 「本周已学古诗」统计近 7 天内 status='completed' 的课 → 倒数第 2、3 节放在 2 天前与 4 天前
 *   - 更早的课按每周一节向前回溯，形成可观察的学期纵深
 * 注意 status 必须是 LessonStatus 的合法值 'completed'——写 'ended' 这类
 * 表面看得懂、实则不在枚举内的值，会让本周进度恒为 0 且不报任何错。
 */
function lessonTimeAt(idx: number, total: number): number {
    const fromEnd = total - 1 - idx
    if (fromEnd === 0) return Date.now() - 3 * 60 * 60 * 1000
    if (fromEnd === 1) return Date.now() - 2 * DAY_MS
    if (fromEnd === 2) return Date.now() - 4 * DAY_MS
    return Date.now() - (fromEnd + 4) * DAY_MS
}

// ─────────────────────────────────────────────────────────────
// 可复现伪随机
// ─────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
    let state = seed
    return () => {
        state = (state + 0x6d2b79f5) | 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function gaussian(rng: () => number, mean: number, std: number): number {
    const u = Math.max(rng(), 1e-10)
    const v = rng()
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x))
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

interface SeedStats {
    studentsCreated: number
    answers: number
    mastery: number
    events: number
    lessons: number
    darkMatterInjected: Array<{ classId: string; poemId: string; bloomLevel: string }>
}

export function seedLearningDemo(): SeedStats {
    initDatabase()

    const rng = mulberry32(20260725)
    const now = Date.now()
    const stats: SeedStats = {
        studentsCreated: 0,
        answers: 0,
        mastery: 0,
        events: 0,
        lessons: 0,
        darkMatterInjected: [],
    }

    const meta = JSON.stringify({ seedSource: LEARNING_SEED_TAG })

    // ── 0. 取教学诗篇与题库 ──
    // 只用 tongbian-* 统编版诗篇，且必须已有基础题库，保证 answers.question_id 外键有效
    const poems = db
        .prepare(
            `SELECT p.id, p.title
               FROM poems p
              WHERE p.id LIKE 'tongbian-0%'
                AND EXISTS (SELECT 1 FROM questions q WHERE q.poem_id = p.id)
              ORDER BY p.id
              LIMIT ?`,
        )
        .all(POEMS_PER_CLASS) as Array<{ id: string; title: string }>

    if (poems.length === 0) {
        throw new Error('诗库或基础题库为空，请先启动一次后端完成 seedDatabase() 再执行本脚本')
    }

    // 每首诗按阶层取一道基础题（baseline-*，由 seedDatabase 生成，可追溯）
    const questionByPoemLevel = new Map<string, string>()
    const qRows = db
        .prepare(
            `SELECT id, poem_id, bloom_level FROM questions
              WHERE id LIKE 'baseline-%' AND poem_id IN (${poems.map(() => '?').join(',')})`,
        )
        .all(...poems.map((p) => p.id)) as Array<{ id: string; poem_id: string; bloom_level: string }>
    for (const q of qRows) {
        questionByPoemLevel.set(`${q.poem_id}|${q.bloom_level}`, q.id)
    }

    const insertStudent = db.prepare(`
        INSERT OR IGNORE INTO students
            (id, class_id, name, anonymous_name, grade, cognitive_style, engagement_score, created_at, updated_at, metadata)
        VALUES (@id, @classId, @name, @anonymousName, @grade, @cognitiveStyle, @engagementScore, @createdAt, @now, @metadata)
    `)
    const updateStudentEngagement = db.prepare(`
        UPDATE students
           SET engagement_score = @engagementScore,
               updated_at = @now
         WHERE id = @studentId
           AND metadata LIKE '%"seedSource":"roster-demo-v2"%'
    `)
    const insertLesson = db.prepare(`
        INSERT OR IGNORE INTO lessons
            (id, class_id, poem_id, teacher_id, scheduled_at, started_at, ended_at, status, mode, created_at, updated_at, metadata)
        VALUES (@id, @classId, @poemId, @teacherId, @at, @at, @endedAt, 'completed', @mode, @now, @now, @metadata)
    `)
    const insertAnswer = db.prepare(`
        INSERT OR IGNORE INTO answers
            (id, student_id, question_id, lesson_id, answer_text, correct, partial_score,
             cognitive_attribution, feedback, teacher_hint, ai_confidence, needs_human_review,
             graded_by, graded_at, submitted_at, created_at, updated_at, metadata)
        VALUES (@id, @studentId, @questionId, @lessonId, @answerText, @correct, @partialScore,
                @attribution, @feedback, NULL, 0.9, 0,
                'ai', @at, @at, @now, @now, @metadata)
    `)
    const insertMastery = db.prepare(`
        INSERT INTO mastery
            (id, student_id, poem_id, bloom_level, score, attempts, correct_count, last_attempt_at, created_at, updated_at)
        VALUES (@id, @studentId, @poemId, @bloomLevel, @score, @attempts, @correctCount, @at, @now, @now)
        ON CONFLICT(student_id, poem_id, bloom_level) DO UPDATE SET
            score = excluded.score,
            attempts = excluded.attempts,
            correct_count = excluded.correct_count,
            last_attempt_at = excluded.last_attempt_at,
            updated_at = excluded.updated_at
    `)
    const insertEvent = db.prepare(`
        INSERT OR IGNORE INTO events
            (id, student_id, class_id, lesson_id, type, action, payload, poem_id,
             occurred_at, recorded_at, created_at, updated_at, metadata)
        VALUES (@id, @studentId, @classId, @lessonId, @type, @action, @payload, @poemId,
                @at, @at, @now, @now, @metadata)
    `)

    const run = db.transaction(() => {
        for (const [classIndex, classId] of TARGET_CLASSES.entries()) {
            const cls = db
                .prepare('SELECT id, name, grade, teacher_id AS teacherId, student_count AS studentCount FROM classes WHERE id = ?')
                .get(classId) as
                | { id: string; name: string; grade: string; teacherId: string; studentCount: number }
                | undefined
            if (!cls) continue

            // ── 1. 补齐名册：让实际学生行数与 classes.student_count 一致 ──
            // 现状是 class-001 声明 40 人却只有 5 行、class-002/003 一个学生都没有，
            // 导致「班级 40 人」与热力图只有 5 行并存，教师会直接怀疑数据可信度。
            const existing = db
                .prepare('SELECT id, anonymous_name AS anon FROM students WHERE class_id = ? ORDER BY anonymous_name')
                .all(classId) as Array<{ id: string; anon: string }>

            const need = Math.max(0, cls.studentCount - existing.length)
            for (let i = 0; i < need; i++) {
                const seq = existing.length + i + 1
                const num = String(seq).padStart(2, '0')
                const displayName = syntheticStudentName(classIndex * 40 + seq - 1)
                insertStudent.run({
                    id: `${classId}-stu-${num}`,
                    classId,
                    // 固定虚构姓名既便于教师演示，也不会映射到真实儿童身份。
                    name: displayName,
                    anonymousName: displayName,
                    grade: cls.grade,
                    cognitiveStyle: COGNITIVE_STYLES[(seq - 1) % COGNITIVE_STYLES.length] as string,
                    engagementScore: Math.round(clamp(gaussian(rng, 72, 12), 40, 99)),
                    // 入学时间回填到学期初：若用当前时间，驾驶舱的「本周新增学生」
                    // 会把整个种子名册算成本周新生（实测 108 人），明显失真。
                    createdAt: semesterStart,
                    now,
                    metadata: meta,
                })
                stats.studentsCreated += 1
            }

            const students = db
                .prepare('SELECT id FROM students WHERE class_id = ? ORDER BY anonymous_name')
                .all(classId) as Array<{ id: string }>

            // ── 2. 认知暗物质注入点：每班 2 个 (诗篇, 阶层) 组合额外压低 ──
            // 没有这一步，全班数据分布均匀，暗物质检测算法无从检出任何东西，
            // 演示时"暗物质"这一核心创新点会显得徒有其名。
            const darkMatter: Array<{ poemId: string; level: BloomLevel }> = []
            for (let i = 0; i < 2; i++) {
                const poem = poems[Math.floor(rng() * poems.length)] as { id: string; title: string }
                // 只在高阶注入：低阶普遍性卡顿不符合真实教学规律
                const level = BLOOM_LEVELS[3 + Math.floor(rng() * 3)] as BloomLevel
                darkMatter.push({ poemId: poem.id, level })
                stats.darkMatterInjected.push({ classId, poemId: poem.id, bloomLevel: level })
            }
            const isDark = (poemId: string, level: BloomLevel): boolean =>
                darkMatter.some((d) => d.poemId === poemId && d.level === level)

            // ── 3. 每首诗一节已结束的课，作为 answers.lesson_id 归属 ──
            const lessonIdByPoem = new Map<string, string>()
            poems.forEach((poem, idx) => {
                // 课时排布：最后两节落在本周（分别为 1 天前与 3 天前），
                // 其余按每周一节向前回溯。这样「本周学习进度」面板有真实数据，
                // 而不是排出一串全在历史周、当周恒为空的课表。
                const at = lessonTimeAt(idx, poems.length)
                const lessonId = `${classId}-lesson-${poem.id}`
                // 课时长度 30–45 分钟不等，让「今日学习总时长」等聚合有真实分布
                const durationMin = 30 + Math.floor(rng() * 16)
                insertLesson.run({
                    id: lessonId,
                    classId,
                    poemId: poem.id,
                    teacherId: cls.teacherId,
                    at,
                    endedAt: at + durationMin * 60 * 1000,
                    mode: 'six-level-immersive',
                    now,
                    metadata: meta,
                })
                lessonIdByPoem.set(poem.id, lessonId)
                stats.lessons += 1
            })

            // ── 4. 逐生逐诗逐阶生成作答与掌握度 ──
            for (const stu of students) {
                const ability = clamp(gaussian(rng, 68, 14), 30, 98)
                // 出勤率：真实班级不可能人人全勤。按 Beta 形态取 0.62–1.0，
                // 少数学生明显缺课，多数接近全勤。
                const attendance = clamp(0.62 + rng() * 0.38, 0.62, 1)
                // 投入度：影响单节课实际作答的题量（有人只做完前两阶就下课了）
                const diligence = clamp(gaussian(rng, 0.82, 0.16), 0.35, 1)
                updateStudentEngagement.run({
                    studentId: stu.id,
                    engagementScore: Math.round(clamp(ability * 0.56 + attendance * 24 + diligence * 20, 35, 98)),
                    now,
                })

                poems.forEach((poem, poemIdx) => {
                    const lessonId = lessonIdByPoem.get(poem.id) as string
                    const lessonAt = lessonTimeAt(poemIdx, poems.length)

                    // 缺课：该生这节课没来，不产生任何作答与事件。
                    // 这是让热力图「有深浅、有空格」的关键——原实现人人每节课
                    // 都答满六题，矩阵里每个格子都是 40m，看上去像假数据。
                    if (rng() > attendance) return

                    // 当节实际完成的阶层数（按六阶顺序推进，未完成的高阶不作答）
                    const levelsDone = Math.max(
                        1,
                        Math.round(BLOOM_LEVELS.length * diligence * (0.75 + rng() * 0.35)),
                    )
                    let levelIdx = 0

                    for (const level of BLOOM_LEVELS) {
                        if (levelIdx >= levelsDone) break
                        levelIdx += 1
                        const questionId = questionByPoemLevel.get(`${poem.id}|${level}`)
                        if (!questionId) continue

                        const penalty = BLOOM_PENALTY[level]
                        const darkPenalty = isDark(poem.id, level) ? 18 : 0
                        const score = Math.round(
                            clamp(ability - penalty - darkPenalty + gaussian(rng, 0, 8), 0, 100),
                        )
                        const correct = score >= 60
                        const at = lessonAt + Math.floor(rng() * 30 * 60 * 1000)

                        insertAnswer.run({
                            id: `${stu.id}-${questionId}`,
                            studentId: stu.id,
                            questionId,
                            lessonId,
                            answerText: correct
                                ? `（演示作答）针对《${poem.title}》${level}层级的作答，要点基本命中。`
                                : `（演示作答）针对《${poem.title}》${level}层级的作答，要点未命中。`,
                            correct: correct ? 1 : 0,
                            partialScore: score / 100,
                            attribution: correct
                                ? `${level}层级达成`
                                : `${level}层级未达成：${darkPenalty > 0 ? '存在共性认知盲区' : '个体掌握不足'}`,
                            feedback: correct
                                ? '作答符合该阶层要求，可进入下一阶层训练。'
                                : '建议回到原文与注释，重新梳理该阶层的关键要点。',
                            at,
                            now,
                            metadata: meta,
                        })
                        stats.answers += 1

                        insertMastery.run({
                            id: `${stu.id}-${poem.id}-${level}`,
                            studentId: stu.id,
                            poemId: poem.id,
                            bloomLevel: level,
                            score,
                            attempts: 1,
                            correctCount: correct ? 1 : 0,
                            at,
                            now,
                        })
                        stats.mastery += 1
                    }

                    // ── 5. 学情事件（仅出勤且有作答时产生） ──
                    insertEvent.run({
                        id: `${stu.id}-${poem.id}-answer`,
                        studentId: stu.id,
                        classId,
                        lessonId,
                        type: 'answer',
                        action: 'submit',
                        payload: JSON.stringify({ poemId: poem.id, levels: BLOOM_LEVELS.length }),
                        poemId: poem.id,
                        at: lessonAt + 20 * 60 * 1000,
                        now,
                        metadata: meta,
                    })
                    stats.events += 1
                })
            }
        }
    })

    run()
    return stats
}

/**
 * 清除本脚本写入的全部演示学情
 *
 * 只删除 metadata 带 seedSource 标记的行；mastery 表没有 metadata 列，
 * 因此按「该生存在带标记的 answers」这一从属关系连带清理，
 * 保证不会误删教师在真实课堂中产生的掌握度记录。
 */
export function clearLearningDemo(): { answers: number; mastery: number; events: number; lessons: number; students: number } {
    initDatabase()
    const tag = `%"seedSource":"${LEARNING_SEED_TAG}"%`

    const run = db.transaction(() => {
        const seededStudents = db
            .prepare('SELECT id FROM students WHERE metadata LIKE ?')
            .all(tag) as Array<{ id: string }>
        const ids = seededStudents.map((s) => s.id)

        const answers = db.prepare('DELETE FROM answers WHERE metadata LIKE ?').run(tag).changes
        const events = db.prepare('DELETE FROM events WHERE metadata LIKE ?').run(tag).changes
        const lessons = db.prepare('DELETE FROM lessons WHERE metadata LIKE ?').run(tag).changes

        let mastery = 0
        if (ids.length > 0) {
            const chunk = 400
            for (let i = 0; i < ids.length; i += chunk) {
                const part = ids.slice(i, i + chunk)
                mastery += db
                    .prepare(`DELETE FROM mastery WHERE student_id IN (${part.map(() => '?').join(',')})`)
                    .run(...part).changes
            }
        }
        const students = db.prepare('DELETE FROM students WHERE metadata LIKE ?').run(tag).changes

        return { answers, mastery, events, lessons, students }
    })

    return run()
}

// ─────────────────────────────────────────────────────────────
// CLI 入口
// ─────────────────────────────────────────────────────────────

const isDirectExecution = Boolean(
    process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href,
)

if (isDirectExecution) {
    const isClear = process.argv.includes('--clear')
    if (isClear) {
        const r = clearLearningDemo()
        console.log('[seed:learning] 已清除演示学情：', r)
    } else {
        const r = seedLearningDemo()
        console.log('[seed:learning] 已写入演示学情：')
        console.log(`  新增学生      ${r.studentsCreated}`)
        console.log(`  课时          ${r.lessons}`)
        console.log(`  作答记录      ${r.answers}`)
        console.log(`  六阶掌握度    ${r.mastery}`)
        console.log(`  学情事件      ${r.events}`)
        console.log(`  暗物质注入点  ${r.darkMatterInjected.map((d) => `${d.classId}/${d.poemId}/${d.bloomLevel}`).join('，')}`)
        console.log('  全部记录已标记 seedSource=learning-demo-v1，可用 npm run seed:learning:clear 撤销')
    }
}
