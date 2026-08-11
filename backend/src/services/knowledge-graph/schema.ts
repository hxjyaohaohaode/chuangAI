/**
 * 知识图谱 Schema —— Cypher DDL 约束与索引
 *
 * 设计原则：
 * 1. 所有唯一性约束用 IF NOT EXISTS 保证幂等
 * 2. 索引覆盖高频查询字段（poem.id / poet.name / poem.difficulty / poem.title）
 * 3. 文本字段用 Neo4j 5 的命名约束（CONSTRAINT ... REQUIRE ... IS UNIQUE）
 * 4. 不创建复合索引（Neo4j 5 对单字段索引优化已足够，避免维护负担）
 *
 * 节点 Label：
 *   Poet / Poem / Image / Theme / Era / Rhetoric
 *
 * 边 Type：
 *   WROTE / MENTORS / CONTEMPORARY / OF_ERA / USES_IMAGE / EXPRESSES_THEME /
 *   USES_RHETORIC / SHARES_IMAGE / SIMILAR_THEME / BORROWS_RHETORIC
 */

/**
 * 唯一性约束 + 索引 DDL
 *
 * 在 Neo4j 5 中，CREATE CONSTRAINT ... REQUIRE ... IS UNIQUE 会同时建立唯一约束 + 索引，
 * 因此对约束字段不再单独 CREATE INDEX。
 */
export const SCHEMA_CONSTRAINTS = `
// ───────── 唯一性约束 ─────────
CREATE CONSTRAINT poet_id IF NOT EXISTS
  FOR (p:Poet) REQUIRE p.id IS UNIQUE;

CREATE CONSTRAINT poem_id IF NOT EXISTS
  FOR (p:Poem) REQUIRE p.id IS UNIQUE;

CREATE CONSTRAINT image_name IF NOT EXISTS
  FOR (i:Image) REQUIRE i.name IS UNIQUE;

CREATE CONSTRAINT theme_name IF NOT EXISTS
  FOR (t:Theme) REQUIRE t.name IS UNIQUE;

CREATE CONSTRAINT era_name IF NOT EXISTS
  FOR (e:Era) REQUIRE e.name IS UNIQUE;

CREATE CONSTRAINT rhetoric_name IF NOT EXISTS
  FOR (r:Rhetoric) REQUIRE r.name IS UNIQUE;

// ───────── 索引（非约束字段，加速查询） ─────────
CREATE INDEX poem_title IF NOT EXISTS
  FOR (p:Poem) ON (p.title);

CREATE INDEX poet_name IF NOT EXISTS
  FOR (p:Poet) ON (p.name);

CREATE INDEX poem_difficulty IF NOT EXISTS
  FOR (p:Poem) ON (p.difficulty);

CREATE INDEX poem_grade_level IF NOT EXISTS
  FOR (p:Poem) ON (p.gradeLevel);

CREATE INDEX poem_textbook_edition IF NOT EXISTS
  FOR (p:Poem) ON (p.textbookEdition);
` as const

/**
 * 节点 Label 枚举（用于运行时校验与类型守卫）
 */
export const NODE_LABELS = [
  'Poet',
  'Poem',
  'Image',
  'Theme',
  'Era',
  'Rhetoric',
] as const

export type NodeLabel = (typeof NODE_LABELS)[number]

/**
 * 边 Type 枚举
 */
export const RELATIONSHIP_TYPES = [
  'WROTE',              // (:Poet)-[:WROTE]->(:Poem)
  'MENTORS',            // (:Poet)-[:MENTORS]->(:Poet)
  'CONTEMPORARY',       // (:Poet)-[:CONTEMPORARY]->(:Poet)
  'OF_ERA',             // (:Poem)-[:OF_ERA]->(:Era)
  'USES_IMAGE',         // (:Poem)-[:USES_IMAGE]->(:Image)
  'EXPRESSES_THEME',    // (:Poem)-[:EXPRESSES_THEME]->(:Theme)
  'USES_RHETORIC',      // (:Poem)-[:USES_RHETORIC]->(:Rhetoric)
  'SHARES_IMAGE',       // (:Poem)-[:SHARES_IMAGE {count}]->(:Poem)
  'SIMILAR_THEME',      // (:Poem)-[:SIMILAR_THEME {score}]->(:Poem)
  'BORROWS_RHETORIC',   // (:Poem)-[:BORROWS_RHETORIC]->(:Poem)
] as const

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number]

/**
 * 关系置信度 —— 移植自 Graphify 的 EXTRACTED|INFERRED|AMBIGUOUS 范式
 *
 * 用于标注推断关系的可信度，让下游消费方（暗物质检测器、前端可视化、
 * 认知诊断 Agent）能区分"硬证据"与"算法猜测"。
 *
 * - EXTRACTED：直接从诗的元数据提取的边
 *   （WROTE / OF_ERA / USES_IMAGE / EXPRESSES_THEME / USES_RHETORIC）
 * - INFERRED ：通过算法推导的边
 *   （SHARES_IMAGE / SIMILAR_THEME / BORROWS_RHETORIC / CONTEMPORARY）
 * - AMBIGUOUS：模糊存疑的边（如 MENTORS 师承关系，文献多有争议）
 *
 * 设计原则（不强制写库迁移）：
 * 1. 现有边无 confidence 属性时，查询时按边类型映射默认值（见 defaultConfidenceFor）
 * 2. 未识别的边类型兜底为 INFERRED（保守默认，符合"推断关系"语义）
 * 3. 未来若写入 confidence 属性，查询优先用边自身的值
 */
export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'

/** 提取类边（直接来自诗的元数据，硬证据） */
const EXTRACTED_RELATIONSHIP_TYPES: ReadonlySet<string> = new Set([
  'WROTE',
  'OF_ERA',
  'USES_IMAGE',
  'EXPRESSES_THEME',
  'USES_RHETORIC',
])

/** 模糊存疑类边（文献多有争议，需人工复核） */
const AMBIGUOUS_RELATIONSHIP_TYPES: ReadonlySet<string> = new Set([
  'MENTORS',
])

/**
 * 根据边类型返回默认的 confidence。
 *
 * - 提取类边（WROTE/OF_ERA/USES_IMAGE/EXPRESSES_THEME/USES_RHETORIC）→ EXTRACTED
 * - 模糊类边（MENTORS）→ AMBIGUOUS
 * - 其余（SHARES_IMAGE/SIMILAR_THEME/BORROWS_RHETORIC/CONTEMPORARY 与未知）→ INFERRED
 *
 * 用于查询时为缺失 confidence 属性的边补全标注，避免强制写库迁移。
 * 符合 spec"若现有边无此属性，查询时默认 INFERRED"的兜底约定。
 */
export function defaultConfidenceFor(relType: string): Confidence {
  if (EXTRACTED_RELATIONSHIP_TYPES.has(relType)) return 'EXTRACTED'
  if (AMBIGUOUS_RELATIONSHIP_TYPES.has(relType)) return 'AMBIGUOUS'
  return 'INFERRED'
}

/**
 * 各 Label 对应的属性 Schema（用于文档与运行时校验）
 */
export interface PoetProperties {
  id: string
  name: string
  dynasty: string
  birthYear?: number
  deathYear?: number
  style?: string
  brief?: string
}

export interface PoemProperties {
  id: string
  title: string
  content: string
  difficulty: number
  gradeLevel: string
  textbookEdition: string
  /** 冗余字段，便于直接展示，不参与关系 */
  poet?: string
  dynasty?: string
}

export interface ImageProperties {
  name: string
  culturalMeaning?: string
}

export interface ThemeProperties {
  name: string
}

export interface EraProperties {
  name: string
  startYear?: number
  endYear?: number
}

export interface RhetoricProperties {
  name: string
  description?: string
}

/**
 * 边属性 Schema
 */
export interface SharesImageProperties {
  /** 共享意象数量 */
  count: number
  /** 共享的具体意象列表（便于诊断"为何关联"） */
  images: string[]
  /** 关系置信度；缺失时按 defaultConfidenceFor('SHARES_IMAGE') = INFERRED 处理 */
  confidence?: Confidence
}

export interface SimilarThemeProperties {
  /** 主题相似度 0-1（基于 Jaccard 系数） */
  score: number
  /** 共享主题列表 */
  themes: string[]
  /** 关系置信度；缺失时按 defaultConfidenceFor('SIMILAR_THEME') = INFERRED 处理 */
  confidence?: Confidence
}

export interface MentorsProperties {
  /** 师承关系说明 */
  note: string
  /** 师承关系置信度；缺失时按 defaultConfidenceFor('MENTORS') = AMBIGUOUS 处理 */
  confidence?: Confidence
}
