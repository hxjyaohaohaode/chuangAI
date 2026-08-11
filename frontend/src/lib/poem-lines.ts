/**
 * 古诗拆句 —— 前端唯一口径
 *
 * 必须与后端 `backend/src/lib/poem-lines.ts` 保持完全一致：
 * 逐句讲解、诗篇接龙、思考宫殿的诗句展示都以「句读」为单位，
 * 若前后端切分规则不同，同一首诗在不同界面会被切成不同的行数，
 * lineIndex 对不上，教学要点就会挂到错误的诗句上。
 *
 * 切分符：逗号 / 句号 / 问号 / 叹号 / 分号 / 顿号 / 换行。
 * 五言绝句因此得到 4 句，与教师逐句讲解的实际单位一致。
 */

/** 句读切分符（与后端 CLAUSE_SEPARATORS 一致） */
const CLAUSE_SEPARATORS = /[，,。．！!？?；;、\n\r]+/

/**
 * 将诗文拆分为教学用的「句」
 *
 * @param content 诗文原文（可含换行与标点）
 * @returns 去除标点与空白后的句子数组，顺序即 lineIndex 顺序
 */
export function splitPoemClauses(content: string | null | undefined): string[] {
    return (content ?? '')
        .split(CLAUSE_SEPARATORS)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
}
