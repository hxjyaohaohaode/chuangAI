/**
 * 古诗拆句 —— 全后端唯一口径
 *
 * 为什么必须共用一份实现：
 * 课堂「逐句讲解」面板会把两个接口的数据按 lineIndex 合并渲染：
 *   - GET /api/classroom/explain/:poemId   → 每句的教学要点
 *   - GET /api/poem-content/:poemId        → 每句的原文/拼音/译文
 * 两边只要拆句规则差一个标点，lineIndex 就会错位，教师看到的讲解要点
 * 会挂到错误的诗句上。因此拆句逻辑收敛到本模块，任何一方都不得自行实现。
 *
 * 切分口径：以「句读」为单位，即逗号、句号、问号、叹号、分号、顿号与换行。
 * 五言绝句因此得到 4 行（而非按句号切出的 2 行），这与教师逐句讲解、
 * 学生逐句注音的实际教学单位一致。
 */

/** 句读切分符：逗号 / 句号 / 问号 / 叹号 / 分号 / 顿号 / 换行 */
const CLAUSE_SEPARATORS = /[，,。．！!？?；;、\n\r]+/

/**
 * 将诗文拆分为教学用的「句」
 *
 * @param content 诗文原文（可含换行与标点）
 * @returns 去除标点与空白后的句子数组，顺序即 lineIndex 顺序
 */
export function splitPoemClauses(content: string): string[] {
    return (content ?? '')
        .split(CLAUSE_SEPARATORS)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
}

/**
 * 统计一句中的汉字数量
 *
 * 用于校验 AI 返回的逐字拼音数组长度是否与原文对齐——
 * 对不齐说明注音发生错位，宁可整句丢弃注音也不能让小学生看到错误读音。
 */
export function countHanChars(line: string): number {
    return Array.from(line).filter((c) => /\p{Script=Han}/u.test(c)).length
}
