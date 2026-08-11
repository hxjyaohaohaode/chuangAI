/**
 * HTML 转义工具（XSS 防御）
 *
 * 在使用 innerHTML 拼接动态字符串的场景中，必须先经过此函数转义，
 * 防止恶意脚本注入（XSS）。
 *
 * 转义字符映射（OWASP 推荐）：
 *   &  →  &amp;
 *   <  →  &lt;
 *   >  →  &gt;
 *   "  →  &quot;
 *   '  →  &#x27;
 *
 * @example
 *   tooltip.innerHTML = `<div>${escapeHtml(userInput)}</div>`
 */

const HTML_ESCAPE_MAP: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
}

const HTML_ESCAPE_RE = /[&<>"']/g

/** 将字符串中的 HTML 特殊字符转义为对应的 HTML 实体 */
export function escapeHtml(text: string | number | null | undefined): string {
    if (text === null || text === undefined) return ''
    return String(text).replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch] ?? ch)
}
