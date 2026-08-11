/**
 * 竞赛演示名册（全部为固定生成的虚构姓名，不对应任何真实学生）。
 *
 * 姓名必须像真实课堂名册一样易读，不能继续把 S01-Li 这类数据库代号直接暴露
 * 给教师；同时通过 metadata.seedSource 保持“合成演示数据”可识别、可清除。
 */
const SURNAMES = [
    '林', '沈', '苏', '周', '顾', '陈', '许', '江',
    '陆', '宋', '叶', '唐', '温', '夏', '何', '赵',
] as const

const GIVEN_NAMES = [
    '诗涵', '子墨', '若溪', '明远', '语桐', '景行', '知夏', '安然',
] as const

/** 生成稳定且在 128 个名额内不重复的虚构中文姓名。 */
export function syntheticStudentName(index: number): string {
    const normalized = Math.max(0, Math.trunc(index))
    const surname = SURNAMES[normalized % SURNAMES.length] ?? '林'
    const givenName = GIVEN_NAMES[Math.floor(normalized / SURNAMES.length) % GIVEN_NAMES.length] ?? '诗涵'
    return `${surname}${givenName}`
}

