/**
 * 学情数据库初始化与单例仓储层
 *
 * 职责：
 * 1. 创建 better-sqlite3 连接
 * 2. 启用 WAL + 外键
 * 3. 加载 schema（内嵌常量，避免云同步占位符问题；同时兼容 schema.sql 文件覆盖）
 * 4. 实例化所有 Repository / Service / Util 单例
 *
 * 用法：
 *   import { initDatabase, repos, services, utils } from './db/index.js'
 *   initDatabase()  // 在 server 启动时调用
 */

import Database from 'better-sqlite3'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { config } from '../config.js'
import { dbLogger } from '../lib/logger/index.js'
import { prepareDatabasePath } from './database-path.js'
// 种子数据（冷启动写入，保证所有依赖数据库的功能可用）
import { SEED_CLASS_DEMO } from './seed/seed-class-demo.js'
import { syntheticStudentName } from './seed/synthetic-roster.js'
import { SEED_POEMS_FULL } from '../services/knowledge-graph/seed-poems-full.js'

/** DB 层 logger 单例 */
const log = dbLogger()

// ─────────────────────────────────────────────────────────────
// 内嵌 Schema（防止 schema.sql 被云同步清空导致初始化失败）
// ─────────────────────────────────────────────────────────────

const EMBEDDED_SCHEMA = `
-- 诗脉·启明 PoeticRealm AI v5.0 学情数据库 DDL
-- 11 张表 + 2 个视图 + 索引 + 外键约束

PRAGMA foreign_keys = ON;

-- =========================================================
-- 1. 班级表
-- =========================================================
CREATE TABLE IF NOT EXISTS classes (
    id              TEXT PRIMARY KEY NOT NULL,
    name            TEXT NOT NULL,
    grade           TEXT NOT NULL,
    teacher_id      TEXT NOT NULL,
    student_count   INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    metadata        TEXT
);

CREATE INDEX IF NOT EXISTS idx_classes_teacher_id ON classes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_classes_grade ON classes(grade);

-- =========================================================
-- 2. 学生表
-- =========================================================
CREATE TABLE IF NOT EXISTS students (
    id                TEXT PRIMARY KEY NOT NULL,
    class_id          TEXT NOT NULL,
    name              TEXT NOT NULL,
    anonymous_name    TEXT NOT NULL,
    grade             TEXT NOT NULL,
    cognitive_style   TEXT,
    engagement_score  REAL NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    metadata          TEXT,
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_students_class_id ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_students_anonymous_name ON students(anonymous_name);
CREATE INDEX IF NOT EXISTS idx_students_grade ON students(grade);

-- =========================================================
-- 3. 古诗表
-- =========================================================
CREATE TABLE IF NOT EXISTS poems (
    id                TEXT PRIMARY KEY NOT NULL,
    title             TEXT NOT NULL,
    poet              TEXT NOT NULL,
    dynasty           TEXT NOT NULL,
    content           TEXT NOT NULL,
    annotation        TEXT,
    theme             TEXT NOT NULL DEFAULT '[]',
    images            TEXT NOT NULL DEFAULT '[]',
    rhetoric          TEXT NOT NULL DEFAULT '[]',
    grade_level       TEXT,
    textbook_edition  TEXT NOT NULL DEFAULT '统编版',
    difficulty        REAL NOT NULL DEFAULT 0.5,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    metadata          TEXT
);

CREATE INDEX IF NOT EXISTS idx_poems_poet ON poems(poet);
CREATE INDEX IF NOT EXISTS idx_poems_dynasty ON poems(dynasty);
CREATE INDEX IF NOT EXISTS idx_poems_title ON poems(title);
CREATE INDEX IF NOT EXISTS idx_poems_grade_level ON poems(grade_level);

-- =========================================================
-- 4. 课程表
-- =========================================================
CREATE TABLE IF NOT EXISTS lessons (
    id            TEXT PRIMARY KEY NOT NULL,
    class_id      TEXT NOT NULL,
    poem_id       TEXT NOT NULL,
    teacher_id    TEXT NOT NULL,
    scheduled_at  INTEGER,
    started_at    INTEGER,
    ended_at      INTEGER,
    status        TEXT NOT NULL DEFAULT 'planned',
    mode          TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    metadata      TEXT,
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (poem_id) REFERENCES poems(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lessons_class_id ON lessons(class_id);
CREATE INDEX IF NOT EXISTS idx_lessons_poem_id ON lessons(poem_id);
CREATE INDEX IF NOT EXISTS idx_lessons_teacher_id ON lessons(teacher_id);
CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons(status);

-- =========================================================
-- 5. 题目表
-- =========================================================
CREATE TABLE IF NOT EXISTS questions (
    id                  TEXT PRIMARY KEY NOT NULL,
    poem_id             TEXT NOT NULL,
    bloom_level         TEXT NOT NULL,
    type                TEXT NOT NULL,
    stem                TEXT NOT NULL,
    options             TEXT,
    answer              TEXT NOT NULL,
    analysis            TEXT,
    distractors_analysis TEXT,
    difficulty          REAL NOT NULL DEFAULT 0.5,
    estimated_time_sec  INTEGER NOT NULL DEFAULT 60,
    ai_generated        INTEGER NOT NULL DEFAULT 0,
    prompt_version      TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    created_by          TEXT,
    metadata            TEXT,
    FOREIGN KEY (poem_id) REFERENCES poems(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_questions_poem_id ON questions(poem_id);
CREATE INDEX IF NOT EXISTS idx_questions_bloom_level ON questions(bloom_level);
CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_ai_generated ON questions(ai_generated);

-- =========================================================
-- 6. 作答表
-- =========================================================
CREATE TABLE IF NOT EXISTS answers (
    id                    TEXT PRIMARY KEY NOT NULL,
    student_id            TEXT NOT NULL,
    question_id           TEXT NOT NULL,
    lesson_id             TEXT,
    answer_text           TEXT NOT NULL,
    correct               INTEGER,
    partial_score         REAL,
    cognitive_attribution TEXT,
    feedback              TEXT,
    teacher_hint          TEXT,
    ai_confidence         REAL,
    needs_human_review    INTEGER NOT NULL DEFAULT 0,
    graded_by             TEXT,
    graded_at             INTEGER,
    submitted_at          INTEGER NOT NULL,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    metadata              TEXT,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
    FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_answers_student_id ON answers(student_id);
CREATE INDEX IF NOT EXISTS idx_answers_question_id ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_answers_lesson_id ON answers(lesson_id);
CREATE INDEX IF NOT EXISTS idx_answers_submitted_at ON answers(submitted_at);
CREATE INDEX IF NOT EXISTS idx_answers_needs_human_review ON answers(needs_human_review);

-- =========================================================
-- 7. 六阶掌握度表（核心：每首诗每阶 0-100%）
-- =========================================================
CREATE TABLE IF NOT EXISTS mastery (
    id              TEXT PRIMARY KEY NOT NULL,
    student_id      TEXT NOT NULL,
    poem_id         TEXT NOT NULL,
    bloom_level     TEXT NOT NULL,
    score           REAL NOT NULL DEFAULT 0,
    attempts        INTEGER NOT NULL DEFAULT 0,
    correct_count   INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE(student_id, poem_id, bloom_level),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (poem_id) REFERENCES poems(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mastery_student_id ON mastery(student_id);
CREATE INDEX IF NOT EXISTS idx_mastery_poem_id ON mastery(poem_id);
CREATE INDEX IF NOT EXISTS idx_mastery_bloom_level ON mastery(bloom_level);
CREATE INDEX IF NOT EXISTS idx_mastery_score ON mastery(score);

-- =========================================================
-- 8. 学情事件表（事件溯源）
-- =========================================================
CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY NOT NULL,
    student_id  TEXT,
    class_id    TEXT,
    lesson_id   TEXT,
    type        TEXT NOT NULL,
    action      TEXT NOT NULL,
    payload     TEXT,
    poem_id     TEXT,
    occurred_at INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    metadata    TEXT,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL,
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL,
    FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE SET NULL,
    FOREIGN KEY (poem_id) REFERENCES poems(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_events_student_id ON events(student_id);
CREATE INDEX IF NOT EXISTS idx_events_class_id ON events(class_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_recorded_at ON events(recorded_at);

-- =========================================================
-- 9. 朗读评测表
-- =========================================================
CREATE TABLE IF NOT EXISTS recitations (
    id                  TEXT PRIMARY KEY NOT NULL,
    student_id          TEXT NOT NULL,
    poem_id             TEXT NOT NULL,
    audio_url           TEXT,
    transcript          TEXT,
    pronunciation_score REAL,
    rhythm_score        REAL,
    emotion_score       REAL,
    mistakes            TEXT,
    suggestion          TEXT,
    audio_duration_sec  REAL,
    ai_generated        INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (poem_id) REFERENCES poems(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recitations_student_id ON recitations(student_id);
CREATE INDEX IF NOT EXISTS idx_recitations_poem_id ON recitations(poem_id);
CREATE INDEX IF NOT EXISTS idx_recitations_created_at ON recitations(created_at);

-- =========================================================
-- 10. 自我进化引擎记忆表（Task 22 用，提前实现）
-- =========================================================
CREATE TABLE IF NOT EXISTS evolution_memory (
    id                 TEXT PRIMARY KEY NOT NULL,
    type               TEXT NOT NULL,
    agent_id           TEXT NOT NULL,
    pattern            TEXT NOT NULL,
    before_prompt      TEXT,
    after_prompt       TEXT,
    improvement_reward REAL,
    ab_test_result     TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    applied_at         INTEGER,
    metadata           TEXT
);

CREATE INDEX IF NOT EXISTS idx_evolution_memory_agent_id ON evolution_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_evolution_memory_type ON evolution_memory(type);
CREATE INDEX IF NOT EXISTS idx_evolution_memory_created_at ON evolution_memory(created_at);

-- =========================================================
-- 11. Prompt 版本表（Task 22 用，提前实现）
-- =========================================================
CREATE TABLE IF NOT EXISTS prompt_versions (
    id                    TEXT PRIMARY KEY NOT NULL,
    agent_id              TEXT NOT NULL,
    version               TEXT NOT NULL,
    system_prompt         TEXT NOT NULL,
    user_prompt_template  TEXT,
    changelog             TEXT,
    is_active             INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    UNIQUE(agent_id, version)
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_agent_id ON prompt_versions(agent_id);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_is_active ON prompt_versions(is_active);

-- =========================================================
-- 12. 开源集市资源表（Task 21）
-- =========================================================
CREATE TABLE IF NOT EXISTS marketplace_resources (
    id              TEXT PRIMARY KEY NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    type            TEXT NOT NULL,
    content         TEXT NOT NULL,
    tags            TEXT NOT NULL DEFAULT '[]',
    grade_level     TEXT,
    bloom_weights   TEXT,
    models_used     TEXT NOT NULL DEFAULT '[]',
    author_id       TEXT,
    author_name     TEXT,
    fork_count      INTEGER NOT NULL DEFAULT 0,
    feedback_score  REAL NOT NULL DEFAULT 0,
    feedback_count  INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_resources_type ON marketplace_resources(type);
CREATE INDEX IF NOT EXISTS idx_marketplace_resources_grade_level ON marketplace_resources(grade_level);
CREATE INDEX IF NOT EXISTS idx_marketplace_resources_author_id ON marketplace_resources(author_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_resources_created_at ON marketplace_resources(created_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_resources_fork_count ON marketplace_resources(fork_count);
CREATE INDEX IF NOT EXISTS idx_marketplace_resources_feedback_score ON marketplace_resources(feedback_score);

-- =========================================================
-- 13. 开源集市复刻记录表（Task 21）
-- =========================================================
CREATE TABLE IF NOT EXISTS marketplace_fork_records (
    id              TEXT PRIMARY KEY NOT NULL,
    resource_id     TEXT NOT NULL,
    source_author   TEXT,
    target_class_id TEXT,
    target_teacher  TEXT,
    adaptation_meta TEXT,
    forked_at       INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (resource_id) REFERENCES marketplace_resources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_marketplace_fork_records_resource_id ON marketplace_fork_records(resource_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_fork_records_target_class ON marketplace_fork_records(target_class_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_fork_records_forked_at ON marketplace_fork_records(forked_at);

-- =========================================================
-- 14. 开源集市反馈表（Task 21）
-- =========================================================
CREATE TABLE IF NOT EXISTS marketplace_feedback (
    id              TEXT PRIMARY KEY NOT NULL,
    resource_id     TEXT NOT NULL,
    rater_id        TEXT,
    rater_name      TEXT,
    score           REAL NOT NULL,
    comment         TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (resource_id) REFERENCES marketplace_resources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_marketplace_feedback_resource_id ON marketplace_feedback(resource_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_feedback_score ON marketplace_feedback(score);
CREATE INDEX IF NOT EXISTS idx_marketplace_feedback_created_at ON marketplace_feedback(created_at);

-- =========================================================
-- 视图 1：班级 × 古诗 × 阶 的掌握度聚合
-- =========================================================
CREATE VIEW IF NOT EXISTS v_class_poem_mastery AS
SELECT
    s.class_id      AS class_id,
    m.poem_id       AS poem_id,
    m.bloom_level   AS bloom_level,
    ROUND(AVG(m.score), 2)                                              AS avg_score,
    COUNT(DISTINCT m.student_id)                                        AS student_count,
    COUNT(DISTINCT CASE WHEN m.score >= 60 THEN m.student_id END)       AS mastered_count
FROM mastery m
JOIN students s ON m.student_id = s.id
GROUP BY s.class_id, m.poem_id, m.bloom_level;

-- =========================================================
-- 视图 2：学生 × 阶 的雷达图聚合
-- =========================================================
CREATE VIEW IF NOT EXISTS v_student_bloom_radar AS
SELECT
    m.student_id    AS student_id,
    m.bloom_level   AS bloom_level,
    ROUND(AVG(m.score), 2)  AS avg_score,
    MAX(m.updated_at)       AS last_updated
FROM mastery m
GROUP BY m.student_id, m.bloom_level;

-- =========================================================
-- 15. 诗人表（知识图谱扩展，对应 SEED_POETS_FULL）
-- =========================================================
CREATE TABLE IF NOT EXISTS poets (
    id           TEXT PRIMARY KEY NOT NULL,
    name         TEXT NOT NULL,
    dynasty      TEXT NOT NULL,
    birth_year   INTEGER,
    death_year   INTEGER,
    style        TEXT,
    brief        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_poets_name ON poets(name);
CREATE INDEX IF NOT EXISTS idx_poets_dynasty ON poets(dynasty);

-- =========================================================
-- 16. 诗人师承关系表（知识图谱扩展，对应 SEED_MENTORSHIPS_FULL）
-- =========================================================
CREATE TABLE IF NOT EXISTS mentorships (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    mentor       TEXT NOT NULL,
    mentee       TEXT NOT NULL,
    note         TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE(mentor, mentee)
);

CREATE INDEX IF NOT EXISTS idx_mentorships_mentor ON mentorships(mentor);
CREATE INDEX IF NOT EXISTS idx_mentorships_mentee ON mentorships(mentee);

-- =========================================================
-- 17. 思考链表（Thinking Palace 用 —— 记录 DeepSeek reasoning_content 推理过程）
-- =========================================================
CREATE TABLE IF NOT EXISTS thinking_chains (
    id                 TEXT PRIMARY KEY NOT NULL,
    agent_id           TEXT NOT NULL,
    session_id         TEXT NOT NULL,
    question           TEXT NOT NULL,
    reasoning          TEXT NOT NULL,
    answer             TEXT,
    nodes              TEXT NOT NULL DEFAULT '[]',
    thinking_mode      TEXT NOT NULL DEFAULT 'medium',
    duration_ms        INTEGER NOT NULL DEFAULT 0,
    model              TEXT NOT NULL,
    prompt_tokens      INTEGER NOT NULL DEFAULT 0,
    completion_tokens  INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    metadata           TEXT
);

CREATE INDEX IF NOT EXISTS idx_thinking_chains_agent_id ON thinking_chains(agent_id);
CREATE INDEX IF NOT EXISTS idx_thinking_chains_session_id ON thinking_chains(session_id);
CREATE INDEX IF NOT EXISTS idx_thinking_chains_created_at ON thinking_chains(created_at);

-- =========================================================
-- 18. 进化模式聚合表（SubTask 14.1：进化之眼 predict/ab-test 数据源）
-- =========================================================
CREATE TABLE IF NOT EXISTS evolution_patterns (
    id              TEXT PRIMARY KEY NOT NULL,
    agent_id        TEXT NOT NULL,
    pattern         TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'agent-error',
    occurrence      INTEGER NOT NULL DEFAULT 1,
    last_occurred_at INTEGER NOT NULL,
    first_seen_at   INTEGER NOT NULL,
    resolved        INTEGER NOT NULL DEFAULT 0,
    resolved_at     INTEGER,
    metadata        TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE(agent_id, pattern)
);

CREATE INDEX IF NOT EXISTS idx_evolution_patterns_agent_id ON evolution_patterns(agent_id);
CREATE INDEX IF NOT EXISTS idx_evolution_patterns_source ON evolution_patterns(source);
CREATE INDEX IF NOT EXISTS idx_evolution_patterns_occurrence ON evolution_patterns(occurrence);
CREATE INDEX IF NOT EXISTS idx_evolution_patterns_last_occurred_at ON evolution_patterns(last_occurred_at);
CREATE INDEX IF NOT EXISTS idx_evolution_patterns_resolved ON evolution_patterns(resolved);
`

// ─────────────────────────────────────────────────────────────
// 数据库路径解析
// ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * 解析数据库文件路径
 * 优先级：SQLITE_PATH > APP_DATA_DIR/poetic-realm.db > 默认 ./data/poetic-realm.db
 */
function resolveDbPath(): string {
    return prepareDatabasePath(
        config.sqlite.path,
        config.runtimePaths.dataDir,
        config.runtimePaths.databaseFile,
    )
}

// ─────────────────────────────────────────────────────────────
// 数据库连接单例
// ─────────────────────────────────────────────────────────────

const DB_PATH = resolveDbPath()

export const db = new Database(DB_PATH)

// 启用 WAL 模式（Write-Ahead Logging）提升并发读性能
db.pragma('journal_mode = WAL')
// 多课堂/后台任务可能同时提交同步写入；显式等待短暂的写锁竞争，
// 避免把可恢复的并发冲突直接暴露成 500。业务超时仍由上层请求边界控制。
db.pragma('busy_timeout = 5000')
// 启用外键约束
db.pragma('foreign_keys = ON')
// 启用同步 NORMAL（WAL 模式下的推荐值，性能与安全性平衡）
db.pragma('synchronous = NORMAL')

// ─────────────────────────────────────────────────────────────
// Schema 初始化
// ─────────────────────────────────────────────────────────────

let schemaInitialized = false

/**
 * 初始化数据库 schema
 * 幂等：重复调用不会报错
 *
 * 策略：
 * 1. 优先读取 schema.sql 文件（如果存在且非空）—— 保持文档可读性
 * 2. 文件为空或不存在时，回退到内嵌 EMBEDDED_SCHEMA —— 保证云同步环境下可用
 */
export function initDatabase(): void {
    if (schemaInitialized) return
    let schema = EMBEDDED_SCHEMA
    const schemaPath = join(__dirname, 'schema.sql')
    if (existsSync(schemaPath)) {
        try {
            const fileContent = readFileSync(schemaPath, 'utf-8').trim()
            if (fileContent.length > 0 && fileContent.includes('CREATE TABLE')) {
                schema = fileContent
            }
        } catch {
            // 读取失败，使用内嵌 schema
        }
    }
    db.exec(schema)
    // SqliteMap 运行时表由各 store 构造时自行创建和迁移。不能在这里再次
    // 执行一份手写总表 DDL：路由模块会在 initDatabase() 前完成求值并建表，
    // 两份 schema 一旦漂移，CREATE TABLE IF NOT EXISTS 不会补列，随后的
    // CREATE INDEX 会令全新安装直接崩溃。
    schemaInitialized = true
    log.info({ path: DB_PATH, tables: 18 }, 'SQLite schema 已初始化')
}

/**
 * 关闭数据库连接（用于优雅关闭）
 */
export function closeDatabase(): void {
    try {
        db.close()
        log.info('SQLite 连接已关闭')
    } catch (err) {
        log.error({ err }, '关闭数据库失败')
    }
}

/**
 * 幂等写入种子数据（冷启动保障）
 *
 * 根因修复：seed-class-demo.ts 与 seed-poems-full.ts 此前从未被任何文件 import，
 * 导致 poems/students/classes 等表在系统启动后全部为空，
 * 连锁导致诗音阁诗列表为空、朗读记录无法持久化、排行榜永远为空、作品墙查不到作品等
 * 多个致命问题。
 *
 * 本函数在 initDatabase() 之后调用，使用 INSERT OR IGNORE 幂等写入：
 *  - 3 个具有唯一主键和唯一业务含义的示范班级
 *  - 与班级 student_count 一致的 113 个脱敏名册学生
 *  - 全量收录诗集（SEED_POEMS_FULL，教材候选 + 拓展篇目；逐首溯源后才能确认范围）
 *
 * 历史版本为了迁就前端硬编码，为同一班级创建了三个 ID 别名，并复制学生，
 * 造成“班级总数 5 / 下拉选项 3 / 学生总数虚增 43”的数据污染。启动时只清理
 * 两个精确命名的旧演示别名；真实教师创建的班级不在清理范围内。
 */
export function seedDatabase(): void {
    if (!schemaInitialized) {
        throw new Error('seedDatabase 必须在 initDatabase 之后调用')
    }

    const now = Date.now()
    const seed = SEED_CLASS_DEMO

    // ── 0. 清理旧版本精确命名的演示别名（外键级联删除其复制学生） ──
    db.prepare(`DELETE FROM classes WHERE id IN ('class-demo-001', 'class-demo-302')`).run()
    // 旧版 5 名 canonical 演示学生没有 provenance；若其作答来自学习演示
    // 种子，则补上同源标记，避免在界面上被误认为真实学生。
    db.prepare(`
        UPDATE students
           SET metadata = '{"seedSource":"learning-demo-v1"}'
         WHERE metadata IS NULL
           AND EXISTS (
               SELECT 1
                 FROM answers a
                WHERE a.student_id = students.id
                  AND a.metadata LIKE '%"seedSource":"learning-demo-v1"%'
           )
    `).run()

    // ── 1. 写入三个权威班级 ──
    const insertClass = db.prepare(`
        INSERT INTO classes (id, name, grade, teacher_id, student_count, created_at, updated_at, metadata)
        VALUES (@id, @name, @grade, @teacherId, @studentCount, @createdAt, @updatedAt, '{"seedSource":"roster-demo-v2"}')
        ON CONFLICT(id) DO UPDATE SET
            teacher_id = excluded.teacher_id,
            updated_at = excluded.updated_at
    `)
    const classRows = [
        {
            id: 'class-001',
            name: seed.classInfo.name,
            grade: seed.classInfo.grade,
            teacherId: config.auth.teacherId,
            studentCount: seed.classInfo.studentCount,
        },
        {
            id: 'class-002',
            name: '三（3）班',
            grade: seed.classInfo.grade,
            teacherId: config.auth.teacherId,
            studentCount: 35,
        },
        {
            id: 'class-003',
            name: '四（1）班',
            grade: '四年级',
            teacherId: config.auth.teacherId,
            studentCount: 38,
        },
    ]
    for (const c of classRows) {
        insertClass.run({ ...c, createdAt: now, updatedAt: now })
    }
    // 权威演示班属于当前单租户教师；同步历史课堂，修复旧版 teacher-demo-001 遗留。
    db.prepare(`
        UPDATE lessons
           SET teacher_id = ?, updated_at = ?
         WHERE class_id IN ('class-001', 'class-002', 'class-003')
    `).run(config.auth.teacherId, now)

    // ── 2. 写入与班级声明人数一致的脱敏名册 ──
    const insertStudent = db.prepare(`
        INSERT INTO students (id, class_id, name, anonymous_name, grade, cognitive_style, engagement_score, created_at, updated_at, metadata)
        VALUES (@id, @classId, @name, @anonymousName, @grade, @cognitiveStyle, @engagementScore, @createdAt, @updatedAt, @metadata)
        ON CONFLICT(id) DO UPDATE SET
            class_id = excluded.class_id,
            name = excluded.name,
            anonymous_name = excluded.anonymous_name,
            grade = excluded.grade,
            cognitive_style = excluded.cognitive_style,
            updated_at = excluded.updated_at,
            metadata = excluded.metadata
    `)
    const insertStudentTx = db.transaction(() => {
        const styles = ['visual', 'auditory', 'kinesthetic']
        const rosterCreatedAt = now - 120 * 86_400_000
        const metadata = JSON.stringify({ seedSource: 'roster-demo-v2' })
        let globalRosterIndex = 0

        for (const classRow of classRows) {
            for (let index = 0; index < classRow.studentCount; index += 1) {
                const sequence = index + 1
                const number = String(sequence).padStart(2, '0')
                const displayName = syntheticStudentName(globalRosterIndex)
                // class-001 前五个 ID 沿用历史值，避免升级已有演示库时复制学生；
                // 其余 ID 与 seed-learning-demo.ts 完全一致。
                const id = classRow.id === 'class-001' && index < 5
                    ? `class001-student-S${number}`
                    : `${classRow.id}-stu-${number}`
                insertStudent.run({
                    id,
                    classId: classRow.id,
                    name: displayName,
                    anonymousName: displayName,
                    grade: classRow.grade,
                    cognitiveStyle: styles[index % styles.length],
                    // 名册只用于保证班级选择与人数闭环，不得凭空制造“学生参与度”。
                    // 参与度必须由真实 events 计算；空环境下明确为 0/暂无数据。
                    engagementScore: 0,
                    createdAt: rosterCreatedAt,
                    updatedAt: now,
                    metadata,
                })
                globalRosterIndex += 1
            }
        }
    })
    insertStudentTx()

    // ── 3. 写入古诗（SEED_POEMS_FULL 全量） ──
    const insertPoem = db.prepare(`
        INSERT OR IGNORE INTO poems (id, title, poet, dynasty, content, annotation, theme, images, rhetoric, grade_level, textbook_edition, difficulty, created_at, updated_at, metadata)
        VALUES (@id, @title, @poet, @dynasty, @content, @annotation, @theme, @images, @rhetoric, @gradeLevel, @textbookEdition, @difficulty, @createdAt, @updatedAt, NULL)
    `)
    const insertPoemTx = db.transaction(() => {
        for (const p of SEED_POEMS_FULL) {
            insertPoem.run({
                id: p.id,
                title: p.title,
                poet: p.poet,
                dynasty: p.dynasty,
                content: p.content,
                annotation: JSON.stringify(p.annotation ?? {}),
                theme: JSON.stringify(p.themes ?? []),
                images: JSON.stringify(p.images ?? []),
                rhetoric: JSON.stringify(p.rhetoric ?? []),
                gradeLevel: p.gradeLevel ?? '3-4年级',
                textbookEdition: '统编版',
                difficulty: (p.difficulty ?? 3) / 5, // 1-5 整数 → 0-1 浮点数
                createdAt: now,
                updatedAt: now,
            })
        }
    })
    insertPoemTx()

    // ── 4. 为全量诗库写入可追溯的六阶基础题库 ──
    // 题目是教学资源，不是学生表现数据；这里只建立课程冷启动所需的可复核题目，
    // 绝不写入 mastery / answers 等学习结果表。
    const insertQuestion = db.prepare(`
        INSERT INTO questions (
            id, poem_id, bloom_level, type, stem, options, answer, analysis,
            distractors_analysis, difficulty, estimated_time_sec, ai_generated,
            prompt_version, created_at, updated_at, created_by, metadata
        )
        VALUES (
            @id, @poemId, @bloomLevel, @type, @stem, NULL, @answer, @analysis,
            NULL, @difficulty, @estimatedTimeSec, 0,
            'curriculum-baseline-v2', @createdAt, @updatedAt, 'system-curriculum',
            @metadata
        )
        ON CONFLICT(id) DO UPDATE SET
            poem_id = excluded.poem_id,
            bloom_level = excluded.bloom_level,
            type = excluded.type,
            stem = excluded.stem,
            answer = excluded.answer,
            analysis = excluded.analysis,
            difficulty = excluded.difficulty,
            estimated_time_sec = excluded.estimated_time_sec,
            ai_generated = excluded.ai_generated,
            prompt_version = excluded.prompt_version,
            updated_at = excluded.updated_at,
            metadata = excluded.metadata
        WHERE questions.created_by = 'system-curriculum'
    `)
    const insertQuestionTx = db.transaction(() => {
        for (const poem of SEED_POEMS_FULL) {
            const firstSentence = poem.content
                .split(/[。！？；\n]/u)
                .map((part) => part.trim())
                .find(Boolean) ?? poem.title
            const firstSentenceParts = firstSentence
                .split(/[，、]/u)
                .map((part) => part.trim())
                .filter(Boolean)
            const memoryTail = firstSentenceParts.at(-1) ?? firstSentence
            const shouldBlankWholeSentence =
                firstSentenceParts.length < 2 || memoryTail.length < 2
            const memoryPrefix = firstSentenceParts.slice(0, -1).join('，')
            const memoryStem = shouldBlankWholeSentence
                ? `请根据原诗补写《${poem.title}》的开篇：“______。”`
                : `请根据原诗补写《${poem.title}》中的诗句：“${memoryPrefix}，______。”`
            const memoryAnswer = shouldBlankWholeSentence ? firstSentence : memoryTail
            const themeText = poem.themes.length > 0 ? poem.themes.join('、') : '诗歌表达的情感与主题'
            const imageText = poem.images.length > 0 ? poem.images.join('、') : '诗中的景物与意象'
            const rhetoricText = poem.rhetoric.length > 0 ? poem.rhetoric.join('、') : '用词、节奏与画面'
            const baseMetadata = {
                source: '统编版全量诗库',
                provenance: 'curriculum-baseline-v2',
                reviewStatus: 'teacher-review-recommended',
                gradeLevel: poem.gradeLevel,
            }
            const questions = [
                {
                    level: '记忆',
                    type: '填空',
                    stem: memoryStem,
                    answer: memoryAnswer,
                    analysis: `考查对《${poem.title}》原文的准确识记。答案须与教材原文一致：${memoryAnswer}。`,
                    difficulty: 0.2,
                    estimatedTimeSec: 35,
                },
                {
                    level: '理解',
                    type: '简答',
                    stem: `《${poem.title}》主要写了什么？请结合一处原文说明诗歌表达的情感。`,
                    answer: `评分要点：能够概括诗歌内容，引用或准确转述原文，并联系“${themeText}”说明情感。`,
                    analysis: `开放题按“内容概括、原文依据、情感理解”三个要点评分，不以单一关键词代替理解。`,
                    difficulty: 0.38,
                    estimatedTimeSec: 90,
                },
                {
                    level: '应用',
                    type: '应用',
                    stem: `如果你要在班级朗诵《${poem.title}》，会怎样处理语速、重音和停顿？请结合诗句说明。`,
                    answer: `评分要点：朗读设计与“${themeText}”相匹配，至少指出一处重音或停顿，并说明依据。`,
                    analysis: `把文本理解迁移到朗读实践，评价朗读策略与诗意是否一致。`,
                    difficulty: 0.5,
                    estimatedTimeSec: 110,
                },
                {
                    level: '分析',
                    type: '简答',
                    stem: `请选择《${poem.title}》中的一个核心意象，分析它如何帮助形成画面并表达情感。`,
                    answer: `评分要点：可从“${imageText}”中选择意象，结合具体诗句分析画面、情感或结构作用。`,
                    analysis: `分析必须建立在文本证据上；可联系${rhetoricText}，但不得只罗列术语。`,
                    difficulty: 0.64,
                    estimatedTimeSec: 140,
                },
                {
                    level: '评价',
                    type: '简答',
                    stem: `你认为《${poem.title}》中最有表现力的一句是哪一句？请用两条文本证据说明理由。`,
                    answer: `评分要点：观点明确；至少提供两条可核验依据，可从用词、意象、修辞、节奏或情感效果展开。`,
                    analysis: `评价结论可多样，评分依据是证据质量与论证完整性，不预设唯一审美答案。`,
                    difficulty: 0.76,
                    estimatedTimeSec: 170,
                },
                {
                    level: '创造',
                    type: '创作',
                    stem: `保留《${poem.title}》的一种意象或情感，仿写两句，并写一句话说明你的构思。`,
                    answer: `评分要点：作品包含明确意象，与原诗形成可解释的联系；语言完整；构思说明能够对应创作选择。`,
                    analysis: `创造题采用“关联原诗、表达完整、语言表现、构思说明”四维量规，允许个性化答案。`,
                    difficulty: 0.86,
                    estimatedTimeSec: 220,
                },
            ] as const
            questions.forEach((question, index) => {
                insertQuestion.run({
                    id: `baseline-${poem.id}-${index + 1}`,
                    poemId: poem.id,
                    bloomLevel: question.level,
                    type: question.type,
                    stem: question.stem,
                    answer: question.answer,
                    analysis: question.analysis,
                    difficulty: question.difficulty,
                    estimatedTimeSec: question.estimatedTimeSec,
                    createdAt: now,
                    updatedAt: now,
                    metadata: JSON.stringify(baseMetadata),
                })
            })
        }
    })
    insertQuestionTx()

    // ── 5. 教师主体由认证配置统一管理；classes.teacher_id 是资源所有权真相源 ──

    const classCount = db.prepare('SELECT COUNT(*) as cnt FROM classes').get() as { cnt: number }
    const studentCount = db.prepare('SELECT COUNT(*) as cnt FROM students').get() as { cnt: number }
    const poemCount = db.prepare('SELECT COUNT(*) as cnt FROM poems').get() as { cnt: number }
    const questionCount = db.prepare('SELECT COUNT(*) as cnt FROM questions').get() as { cnt: number }
    log.info(
        {
            classes: classCount.cnt,
            students: studentCount.cnt,
            poems: poemCount.cnt,
            questions: questionCount.cnt,
        },
        '种子数据已写入',
    )
}

/**
 * 获取数据库状态（用于健康检查）
 */
export function getDbStatus(): {
    connected: boolean
    path: string
    schemaInitialized: boolean
    tableCount: number
} {
    let tableCount = 0
    let connected = true
    try {
        const row = db
            .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table'")
            .get() as { cnt: number } | undefined
        tableCount = row?.cnt ?? 0
    } catch {
        connected = false
    }
    return {
        connected,
        path: DB_PATH,
        schemaInitialized,
        tableCount,
    }
}

// ─────────────────────────────────────────────────────────────
// 仓储层单例
// ─────────────────────────────────────────────────────────────

import { ClassRepository } from './repositories/class.repository.js'
import { StudentRepository } from './repositories/student.repository.js'
import { PoemRepository } from './repositories/poem.repository.js'
import { LessonRepository } from './repositories/lesson.repository.js'
import { QuestionRepository } from './repositories/question.repository.js'
import { AnswerRepository } from './repositories/answer.repository.js'
import { MasteryRepository } from './repositories/mastery.repository.js'
import { EventRepository } from './repositories/event.repository.js'
import { RecitationRepository } from './repositories/recitation.repository.js'
import { EvolutionMemoryRepository } from './repositories/evolution-memory.repository.js'
import { PromptVersionRepository } from './repositories/prompt-version.repository.js'
import {
    MarketplaceResourceRepository,
    MarketplaceForkRecordRepository,
    MarketplaceFeedbackRepository,
} from './repositories/marketplace-resource.repository.js'
import { ThinkingChainRepository } from './repositories/thinking-chain.repository.js'

export const repos = {
    classes: new ClassRepository(db),
    students: new StudentRepository(db),
    poems: new PoemRepository(db),
    lessons: new LessonRepository(db),
    questions: new QuestionRepository(db),
    answers: new AnswerRepository(db),
    mastery: new MasteryRepository(db),
    events: new EventRepository(db),
    recitations: new RecitationRepository(db),
    evolutionMemory: new EvolutionMemoryRepository(db),
    promptVersions: new PromptVersionRepository(db),
    marketplaceResources: new MarketplaceResourceRepository(db),
    marketplaceForkRecords: new MarketplaceForkRecordRepository(db),
    marketplaceFeedback: new MarketplaceFeedbackRepository(db),
    thinkingChains: new ThinkingChainRepository(db),
} as const

// ─────────────────────────────────────────────────────────────
// 服务层单例
// ─────────────────────────────────────────────────────────────

import { MasteryService } from './services/mastery-service.js'
import { EventService } from './services/event-service.js'

export const services = {
    mastery: new MasteryService({
        db,
        masteryRepo: repos.mastery,
        eventRepo: repos.events,
        questionRepo: repos.questions,
        studentRepo: repos.students,
    }),
    event: new EventService({
        eventRepo: repos.events,
    }),
} as const

// ─────────────────────────────────────────────────────────────
// 工具层单例
// ─────────────────────────────────────────────────────────────

import { Anonymizer } from './utils/anonymize.js'
import { DataExporter } from './utils/export.js'

export const utils = {
    anonymizer: new Anonymizer({ studentRepo: repos.students }),
    exporter: new DataExporter({
        classRepo: repos.classes,
        studentRepo: repos.students,
        eventRepo: repos.events,
        masteryRepo: repos.mastery,
    }),
} as const

// ─────────────────────────────────────────────────────────────
// 类型重导出
// ─────────────────────────────────────────────────────────────

export type * from './types.js'
export type { ClassRepository } from './repositories/class.repository.js'
export type { StudentRepository } from './repositories/student.repository.js'
export type { PoemRepository } from './repositories/poem.repository.js'
export type { LessonRepository } from './repositories/lesson.repository.js'
export type { QuestionRepository } from './repositories/question.repository.js'
export type { AnswerRepository } from './repositories/answer.repository.js'
export type { MasteryRepository } from './repositories/mastery.repository.js'
export type { EventRepository } from './repositories/event.repository.js'
export type { RecitationRepository } from './repositories/recitation.repository.js'
export type { EvolutionMemoryRepository } from './repositories/evolution-memory.repository.js'
export type { PromptVersionRepository } from './repositories/prompt-version.repository.js'
export type {
    MarketplaceResourceRepository,
    MarketplaceForkRecordRepository,
    MarketplaceFeedbackRepository,
} from './repositories/marketplace-resource.repository.js'

export type { MasteryService, ClassPoemMastery } from './services/mastery-service.js'
export type { EventService, RecordEventInput } from './services/event-service.js'
export type { Anonymizer } from './utils/anonymize.js'
export type { DataExporter, ClassReportData } from './utils/export.js'
