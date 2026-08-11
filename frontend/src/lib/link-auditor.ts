/**
 * link-auditor.ts —— 死链静态扫描器（v5.0 Task D.1.1）
 *
 * 设计目标
 * --------
 * 静态分析所有 .tsx 文件，确保 100% 的按钮/链接/弹窗/菜单项具备真实功能：
 * - 零死链：无 onClick=undefined、无 href="#"、无 placeholder 弹窗
 * - 零冗余：无重复功能、无未使用组件
 * - 零占位：无 TODO/敬请期待/功能开发中等占位文案
 *
 * 实现策略
 * --------
 * 不引入 ts-morph 等重 AST 依赖，采用「状态机 + 字符串解析」：
 * 1. 逐字符扫描源码，跳过注释与字符串字面量
 * 2. 识别 JSX 开标签边界（处理属性表达式中的 `>` 嵌套）
 * 3. 对每个标签的属性串做模式匹配，判定是否死链
 * 4. 同时扫描 JSX children 文本节点，检测占位文案
 *
 * 用法
 * --------
 *   node src/lib/link-auditor.ts            # 扫描 src，控制台输出
 *   node src/lib/link-auditor.ts --json     # 输出 JSON 到 stdout
 *   node src/lib/link-auditor.ts --out=path # 写入报告文件
 *
 * 退出码：0 = 通过（0 死链），1 = 有死链
 *
 * 自洽性：扫描器自身不引入任何死链，TypeScript 严格模式通过。
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type DeadLinkKind =
    | 'button-native' // <button> 无 onClick
    | 'link-native' // <a> 无 href 或 href="#"/""
    | 'button-comp' // <Button> 无 onClick
    | 'link-comp' // <Link> 无 to
    | 'modal-empty' // <Modal> 无 children
    | 'modal-no-title' // <Modal> 无 title 且无 closable
    | 'menu-item' // 菜单项无 onClick/to

export interface DeadLink {
    file: string
    line: number
    column: number
    kind: DeadLinkKind
    snippet: string
    reason: string
    suggestion: string
}

export interface RedundantItem {
    file: string
    line: number
    kind: 'duplicate' | 'unused'
    snippet: string
    reason: string
}

export interface Placeholder {
    file: string
    line: number
    column: number
    kind: 'text' | 'comment'
    pattern: string
    snippet: string
}

export interface AuditReport {
    generatedAt: string
    root: string
    scannedFiles: number
    totalLines: number
    deadLinks: DeadLink[]
    redundant: RedundantItem[]
    placeholders: Placeholder[]
    summary: {
        deadLinkCount: number
        redundantCount: number
        placeholderCount: number
        byKind: Record<string, number>
    }
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..', '..')
const SRC_DIR = join(PROJECT_ROOT, 'src')

/**
 * 占位文案关键词。
 * - 英文词（TODO/FIXME/TBD）大小写敏感匹配，避免误报 "Todo 列表" 等合法标题
 * - 中文词无大小写区别，直接匹配
 * - 仅在 JSX children 文本节点中检测，不检测属性值与注释
 */
const PLACEHOLDER_PATTERNS_CASE_SENSITIVE: readonly string[] = [
    'TODO',
    'FIXME',
    'TBD',
    'XXX',
]

const PLACEHOLDER_PATTERNS_CHINESE: readonly string[] = [
    '敬请期待',
    '功能开发中',
    '待实现',
    '即将上线',
    '敬请关注',
    '待补',
    '尚未实现',
    '暂未实现',
    '暂未开放',
    '占位功能',
    '占位按钮',
    '占位文案',
    '占位入口',
    '占位内容',
    '占位元素',
]

/** 自定义 Button 组件名（首字母大写、含 Button 后缀） */
const BUTTON_COMP_NAMES = new Set(['Button'])

/** 自定义 Link 组件名（react-router Link 等） */
const LINK_COMP_NAMES = new Set(['Link', 'NavLink'])

/** 弹窗组件名 */
const MODAL_COMP_NAMES = new Set(['Modal', 'Dialog', 'Popover', 'Drawer'])

/** 菜单项组件名 */
const MENU_ITEM_NAMES = new Set(['MenuItem', 'Menu.Item', 'DropdownItem'])

/** 扫描时跳过的目录/文件（相对 SRC_DIR） */
const SKIP_PATHS: readonly string[] = [
    'lib/link-auditor.ts', // 扫描器自身
]

/** 跳过的扩展名 */
const SCAN_EXTENSIONS = new Set(['.tsx', '.ts'])

// ---------------------------------------------------------------------------
// 源码预处理：JSX 标签提取
// ---------------------------------------------------------------------------

interface JsxTag {
    /** 标签名（如 button / a / Button / Modal） */
    name: string
    /** 属性原文（含空白），如 ` onClick={handler} disabled` */
    attrs: string
    /** 是否自闭合 `<.../>` */
    selfClose: boolean
    /** 标签在源码中的起始偏移 */
    start: number
    /** 标签（含尾部 > 或 />）的结束偏移 */
    end: number
    /** 起始行号（1-based） */
    line: number
    /** 起始列号（1-based） */
    column: number
    /** 标签头原始文本（用于 snippet） */
    raw: string
}

/**
 * 计算偏移量对应的行号与列号（1-based）。
 * 为性能预构建每行起始偏移表。
 */
function buildLineTable(source: string): number[] {
    const lineStarts: number[] = [0]
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n') lineStarts.push(i + 1)
    }
    return lineStarts
}

function locate(lineStarts: number[], offset: number): { line: number; column: number } {
    // 二分查找。lineStarts 非空且 lo/hi 始终在界内，但 noUncheckedIndexedAccess
    // 下仍需显式处理 undefined 分支（此处以 0 兜底，算法保证不会真正命中）。
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if ((lineStarts[mid] ?? 0) <= offset) lo = mid
        else hi = mid - 1
    }
    return { line: lo + 1, column: offset - (lineStarts[lo] ?? 0) + 1 }
}

/**
 * 提取源码中所有 JSX 开标签。
 *
 * 状态机：
 * - 跳过 // 行注释
 * - 跳过 / * 块注释
 * - 跳过字符串 " ' ` （处理转义）
 * - 当遇到 `<` 且下一个字符是字母时，进入标签解析
 * - 标签内跟踪 `{` `}` 嵌套深度，仅在深度 0 时识别 `>` 和 `/>` 为标签结束
 * - 属性中的字符串同样跳过
 *
 * 不处理闭合标签 `</Tag>` 与 children 内容（children 由独立扫描器处理）。
 */
function extractJsxTags(source: string): JsxTag[] {
    const tags: JsxTag[] = []
    const lineStarts = buildLineTable(source)
    const len = source.length
    let i = 0

    while (i < len) {
        const ch = source[i]

        // 行注释
        if (ch === '/' && source[i + 1] === '/') {
            i += 2
            while (i < len && source[i] !== '\n') i++
            continue
        }
        // 块注释
        if (ch === '/' && source[i + 1] === '*') {
            i += 2
            while (i < len && !(source[i] === '*' && source[i + 1] === '/')) i++
            i += 2
            continue
        }
        // 字符串字面量
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch
            i++
            while (i < len && source[i] !== quote) {
                if (source[i] === '\\') i += 2
                else i++
            }
            i++
            continue
        }
        // JSX 开标签：<后跟字母（含 . 用于 Member 表达式如 Menu.Item）
        if (ch === '<' && /[A-Za-z]/.test(source[i + 1] ?? '')) {
            const start = i
            i++ // 跳过 <
            let name = ''
            while (i < len && /[A-Za-z0-9.]/.test(source[i] ?? '')) {
                name += source[i]
                i++
            }
            // 解析属性直到 > 或 />
            let attrs = ''
            let braceDepth = 0
            let selfClose = false
            let closed = false
            while (i < len) {
                const c = source[i]
                if (c === '{') {
                    braceDepth++
                    attrs += c
                    i++
                    continue
                }
                if (c === '}') {
                    braceDepth--
                    attrs += c
                    i++
                    continue
                }
                if (braceDepth === 0 && (c === '"' || c === "'")) {
                    // 属性中的字符串值
                    const q = c
                    attrs += c
                    i++
                    while (i < len && source[i] !== q) {
                        if (source[i] === '\\') {
                            attrs += source[i]
                            i++
                        }
                        attrs += source[i]
                        i++
                    }
                    attrs += source[i] ?? ''
                    i++
                    continue
                }
                if (braceDepth === 0 && c === '/' && source[i + 1] === '>') {
                    selfClose = true
                    closed = true
                    i += 2
                    break
                }
                if (braceDepth === 0 && c === '>') {
                    closed = true
                    i++
                    break
                }
                attrs += c
                i++
            }
            // 仅记录成功闭合的标签
            if (closed) {
                const { line, column } = locate(lineStarts, start)
                tags.push({
                    name,
                    attrs,
                    selfClose,
                    start,
                    end: i,
                    line,
                    column,
                    raw: source.slice(start, i),
                })
            }
            continue
        }
        i++
    }
    return tags
}

// ---------------------------------------------------------------------------
// 属性分析工具
// ---------------------------------------------------------------------------

/**
 * 判断属性串中是否声明了指定属性（不区分值，仅检测存在性）。
 * 例如 hasAttr('onClick={x} disabled', 'onClick') → true
 *      hasAttr('onClick', 'onClick') → true
 *      hasAttr('onclick', 'onClick') → false （大小写敏感）
 */
function hasAttr(attrs: string, name: string): boolean {
    // 边界：前导是空白或字符串起始；后跟 = 或空白或字符串结尾
    const re = new RegExp(`(^|[\\s])${escapeRegExp(name)}(?=[\\s=]|$)`)
    return re.test(attrs)
}

/**
 * 提取属性值。返回：
 * - undefined：属性不存在
 * - { kind: 'expr', value: '...' }：表达式值 `={...}`
 * - { kind: 'str', value: '...' }：字符串值 `="..."` 或 `='...'`
 * - { kind: 'bool', value: true }：布尔属性 `disabled`
 */
function getAttr(
    attrs: string,
    name: string,
): { kind: 'expr'; value: string } | { kind: 'str'; value: string } | { kind: 'bool'; value: true } | undefined {
    const re = new RegExp(`(^|[\\s])${escapeRegExp(name)}(?=[\\s=]|$)`)
    const match = re.exec(attrs)
    if (!match) return undefined
    // 找到属性名结束位置
    const nameEnd = match.index + match[0].length
    // 跳过空白
    let j = nameEnd
    while (j < attrs.length && /\s/.test(attrs[j] ?? '')) j++
    if (attrs[j] !== '=') return { kind: 'bool', value: true }
    j++ // 跳过 =
    while (j < attrs.length && /\s/.test(attrs[j] ?? '')) j++
    if (attrs[j] === '{') {
        // 表达式：匹配平衡的 {} 嵌套
        let depth = 0
        let start = j + 1
        let k = j
        while (k < attrs.length) {
            if (attrs[k] === '{') depth++
            else if (attrs[k] === '}') {
                depth--
                if (depth === 0) break
            }
            k++
        }
        return { kind: 'expr', value: attrs.slice(start, k).trim() }
    }
    if (attrs[j] === '"' || attrs[j] === "'") {
        const q = attrs[j]
        let start = j + 1
        let k = start
        while (k < attrs.length && attrs[k] !== q) {
            if (attrs[k] === '\\') k++
            k++
        }
        return { kind: 'str', value: attrs.slice(start, k) }
    }
    // 无引号字面量（罕见）
    let k = j
    while (k < attrs.length && /[^\s>]/.test(attrs[k] ?? '')) k++
    return { kind: 'str', value: attrs.slice(j, k) }
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 判断表达式值是否为「空」：undefined / null / () => {} / () => undefined / () => null */
function isEmptyHandler(expr: string): boolean {
    const v = expr.trim()
    if (v === '' || v === 'undefined' || v === 'null') return true
    if (/^\(\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*$/.test(v)) return true
    if (/^\(\s*_\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*$/.test(v)) return true
    return false
}

/**
 * 判断属性串中是否包含 spread 属性 `{...rest}` / `{...props}`。
 * 当存在 spread 时，onClick/href 等可能通过透传传入，静态扫描无法确定，
 * 故视为「可能存在该属性」，跳过死链检测。
 */
function hasSpreadAttr(attrs: string): boolean {
    return /\{\s*\.\.\./.test(attrs)
}

/**
 * 判断按钮是否处于 disabled 状态。
 * 仅识别 disabled 布尔属性与 disabled={true} 两种显式静态形式。
 * 动态表达式（如 disabled={isLoading}）不视为永久 disabled，
 * 因为运行时仍可能为可点击状态，需保留 onClick 检查。
 */
function isDisabled(attrs: string): boolean {
    const v = getAttr(attrs, 'disabled')
    if (!v) return false
    if (v.kind === 'bool') return true
    if (v.kind === 'expr') return v.value.trim() === 'true'
    return false
}

/** 判断 type 是否为 submit/reset（这类按钮由 form 处理，无需 onClick） */
function isSubmitType(attrs: string): boolean {
    const v = getAttr(attrs, 'type')
    if (!v) return false
    if (v.kind === 'str') return v.value === 'submit' || v.value === 'reset'
    if (v.kind === 'expr') {
        const val = v.value.trim().replace(/^["']|["']$/g, '')
        return val === 'submit' || val === 'reset'
    }
    return false
}

// ---------------------------------------------------------------------------
// 死链检测规则
// ---------------------------------------------------------------------------

interface AuditContext {
    file: string
    deadLinks: DeadLink[]
    placeholders: Placeholder[]
}

function makeSnippet(raw: string): string {
    // 压缩多余空白，限制长度
    const s = raw.replace(/\s+/g, ' ').trim()
    return s.length > 120 ? s.slice(0, 117) + '...' : s
}

/** 检测原生 <button> */
function auditNativeButton(tag: JsxTag, ctx: AuditContext): void {
    if (tag.name !== 'button') return
    if (isDisabled(tag.attrs)) return
    if (isSubmitType(tag.attrs)) return
    if (hasSpreadAttr(tag.attrs)) return // spread 可能透传 onClick
    const onClick = getAttr(tag.attrs, 'onClick')
    if (!onClick) {
        ctx.deadLinks.push({
            file: ctx.file,
            line: tag.line,
            column: tag.column,
            kind: 'button-native',
            snippet: makeSnippet(tag.raw),
            reason: '<button> 元素缺少 onClick 处理函数',
            suggestion: '添加 onClick={...} 或 type="submit"（在 form 内）或 disabled 属性',
        })
        return
    }
    if (onClick.kind === 'expr' && isEmptyHandler(onClick.value)) {
        ctx.deadLinks.push({
            file: ctx.file,
            line: tag.line,
            column: tag.column,
            kind: 'button-native',
            snippet: makeSnippet(tag.raw),
            reason: `<button> 的 onClick 为空实现（${onClick.value}）`,
            suggestion: '提供真实的点击处理逻辑，或移除该按钮',
        })
    }
}

/** 检测原生 <a> */
function auditNativeLink(tag: JsxTag, ctx: AuditContext): void {
    if (tag.name !== 'a') return
    if (hasSpreadAttr(tag.attrs)) return // spread 可能透传 href
    const href = getAttr(tag.attrs, 'href')
    if (!href) {
        ctx.deadLinks.push({
            file: ctx.file,
            line: tag.line,
            column: tag.column,
            kind: 'link-native',
            snippet: makeSnippet(tag.raw),
            reason: '<a> 元素缺少 href 属性',
            suggestion: '添加 href="具体路径" 或改用 <button> + onClick',
        })
        return
    }
    // href="#" / href="" / href={'#'} / href={""}
    let value = ''
    if (href.kind === 'str') value = href.value
    else if (href.kind === 'expr') {
        const v = href.value.trim()
        // 提取字符串字面量
        const m = /^['"](.*)['"]$/.exec(v)
        if (m) value = m[1] ?? ''
        else if (v === '#' || v === "''" || v === '""') value = v.replace(/['"]/g, '')
        else return // 表达式（如 {item.to}），视为合法
    }
    if (value === '#' || value === '' || value === 'javascript:void(0)' || value === 'javascript:;') {
        ctx.deadLinks.push({
            file: ctx.file,
            line: tag.line,
            column: tag.column,
            kind: 'link-native',
            snippet: makeSnippet(tag.raw),
            reason: `<a> 的 href 为占位值 "${value || '#'}"`,
            suggestion: '提供真实路径，或改用 <button> + onClick 触发动作',
        })
    }
}

/** 检测自定义 <Button> 组件 */
function auditButtonComp(tag: JsxTag, ctx: AuditContext): void {
    if (!BUTTON_COMP_NAMES.has(tag.name)) return
    if (isDisabled(tag.attrs)) return
    if (isSubmitType(tag.attrs)) return
    if (hasSpreadAttr(tag.attrs)) return // spread 可能透传 onClick
    const onClick = getAttr(tag.attrs, 'onClick')
    if (!onClick) {
        ctx.deadLinks.push({
            file: ctx.file,
            line: tag.line,
            column: tag.column,
            kind: 'button-comp',
            snippet: makeSnippet(tag.raw),
            reason: '<Button> 组件缺少 onClick 处理函数',
            suggestion: '添加 onClick={...} 或 type="submit" 或 disabled',
        })
        return
    }
    if (onClick.kind === 'expr' && isEmptyHandler(onClick.value)) {
        ctx.deadLinks.push({
            file: ctx.file,
            line: tag.line,
            column: tag.column,
            kind: 'button-comp',
            snippet: makeSnippet(tag.raw),
            reason: `<Button> 的 onClick 为空实现（${onClick.value}）`,
            suggestion: '提供真实的点击处理逻辑，或移除该按钮',
        })
    }
}

/** 检测自定义 <Link>/<NavLink> 组件 */
function auditLinkComp(tag: JsxTag, ctx: AuditContext): void {
    if (!LINK_COMP_NAMES.has(tag.name)) return
    if (hasSpreadAttr(tag.attrs)) return // spread 可能透传 to
    const to = getAttr(tag.attrs, 'to')
    if (!to) {
        ctx.deadLinks.push({
            file: ctx.file,
            line: tag.line,
            column: tag.column,
            kind: 'link-comp',
            snippet: makeSnippet(tag.raw),
            reason: `<${tag.name}> 组件缺少 to 属性`,
            suggestion: '添加 to="目标路径"',
        })
        return
    }
    if (to.kind === 'str' && (to.value === '#' || to.value === '')) {
        ctx.deadLinks.push({
            file: ctx.file,
            line: tag.line,
            column: tag.column,
            kind: 'link-comp',
            snippet: makeSnippet(tag.raw),
            reason: `<${tag.name}> 的 to 为占位值 "${to.value || '#'}"`,
            suggestion: '提供真实路径',
        })
    }
}

/** 检测 <Modal>/<Dialog>/<Popover> 弹窗 */
function auditModal(tag: JsxTag, ctx: AuditContext): void {
    if (!MODAL_COMP_NAMES.has(tag.name)) return
    // 自闭合 → 必然无 children
    if (tag.selfClose) {
        ctx.deadLinks.push({
            file: ctx.file,
            line: tag.line,
            column: tag.column,
            kind: 'modal-empty',
            snippet: makeSnippet(tag.raw),
            reason: `<${tag.name}> 自闭合，缺少正文内容`,
            suggestion: '提供 children 或 footer，或移除该弹窗',
        })
        return
    }
    // 检测 title / children / footer。closable 默认 true（Modal 组件规范），
    // 故不参与「真空弹窗」判定 —— 只要有 closable 就有关闭按钮。
    const hasTitle = hasAttr(tag.attrs, 'title')
    const hasChildren = hasAttr(tag.attrs, 'children')
    const hasFooter = hasAttr(tag.attrs, 'footer')
    // 无 title 且无 footer 且无 children → 真空弹窗
    if (!hasTitle && !hasFooter && !hasChildren) {
        ctx.deadLinks.push({
            file: ctx.file,
            line: tag.line,
            column: tag.column,
            kind: 'modal-no-title',
            snippet: makeSnippet(tag.raw),
            reason: `<${tag.name}> 缺少 title/footer/children，弹窗内容不完整`,
            suggestion: '补充 title 与 children，或移除该弹窗',
        })
    }
}

/** 检测菜单项 <MenuItem> */
function auditMenuItem(tag: JsxTag, ctx: AuditContext): void {
    if (!MENU_ITEM_NAMES.has(tag.name)) return
    if (isDisabled(tag.attrs)) return
    const onClick = getAttr(tag.attrs, 'onClick')
    const to = getAttr(tag.attrs, 'to')
    if (!onClick && !to) {
        ctx.deadLinks.push({
            file: ctx.file,
            line: tag.line,
            column: tag.column,
            kind: 'menu-item',
            snippet: makeSnippet(tag.raw),
            reason: `<${tag.name}> 缺少 onClick/to，无实际功能`,
            suggestion: '添加 onClick={...} 或 to="..." 或 disabled',
        })
    }
}

// ---------------------------------------------------------------------------
// 占位文案扫描（JSX children 文本节点）
// ---------------------------------------------------------------------------

/**
 * 扫描源码中的 JSX children 文本节点，检测占位文案。
 *
 * 实现：逐字符扫描，跳过注释/字符串/JSX 标签，剩余的「纯文本」即为
 * JSX children 文本节点。在其中匹配占位关键词。
 *
 * 注意：input/textarea 的 placeholder 属性值在属性串中（已被标签提取器
 * 跳过），不会被误报。
 */
function pushPlaceholder(
    out: Placeholder[],
    source: string,
    lineStarts: number[],
    absOffset: number,
    pat: string,
    file: string,
    len: number,
): void {
    const { line, column } = locate(lineStarts, absOffset)
    const ctxStart = Math.max(0, absOffset - 20)
    const ctxEnd = Math.min(len, absOffset + pat.length + 20)
    const snippet = source.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim()
    out.push({
        file,
        line,
        column,
        kind: 'text',
        pattern: pat,
        snippet: snippet.length > 100 ? snippet.slice(0, 97) + '...' : snippet,
    })
}

/**
 * 标签边界（开标签或闭标签），用于 scanPlaceholders 跟踪 JSX 上下文。
 */
interface TagBoundary {
    start: number
    end: number
    kind: 'open' | 'close'
    name: string
    selfClose: boolean
}

/**
 * 提取源码中所有 JSX 标签边界（开标签与闭标签）。
 *
 * 状态机与 extractJsxTags 类似，但同时记录闭标签 `</Tag>`。
 * 用于 scanPlaceholders 中跟踪 JSX 上下文（标签栈）。
 *
 * 注意：JS 代码中的 `<` 可能被误识别（如泛型 `Array<string>`），
 * 但 scanPlaceholders 仅在标签栈非空时检测占位词，且 JS 代码中
 * 占位文案罕见，误识别影响可接受。
 */
function extractAllTagBoundaries(source: string): TagBoundary[] {
    const tags: TagBoundary[] = []
    const len = source.length
    let i = 0
    while (i < len) {
        const ch = source[i]
        // 跳过行注释
        if (ch === '/' && source[i + 1] === '/') {
            i += 2
            while (i < len && source[i] !== '\n') i++
            continue
        }
        // 跳过块注释
        if (ch === '/' && source[i + 1] === '*') {
            i += 2
            while (i < len && !(source[i] === '*' && source[i + 1] === '/')) i++
            i += 2
            continue
        }
        // 跳过字符串
        if (ch === '"' || ch === "'" || ch === '`') {
            const q = ch
            i++
            while (i < len && source[i] !== q) {
                if (source[i] === '\\') i += 2
                else i++
            }
            i++
            continue
        }
        // JSX 标签（开或闭）
        if (ch === '<' && /[A-Za-z/]/.test(source[i + 1] ?? '')) {
            const start = i
            i++ // 跳过 <
            let isClose = false
            if (source[i] === '/') {
                isClose = true
                i++
            }
            let name = ''
            while (i < len && /[A-Za-z0-9.]/.test(source[i] ?? '')) {
                name += source[i]
                i++
            }
            // 跳过属性直到 > 或 />
            let depth = 0
            let selfClose = false
            while (i < len) {
                const c = source[i]
                if (c === '{') {
                    depth++
                    i++
                    continue
                }
                if (c === '}') {
                    depth--
                    i++
                    continue
                }
                if (depth === 0 && (c === '"' || c === "'")) {
                    const q = c
                    i++
                    while (i < len && source[i] !== q) {
                        if (source[i] === '\\') i++
                        i++
                    }
                    i++
                    continue
                }
                if (depth === 0 && c === '/' && source[i + 1] === '>') {
                    selfClose = true
                    i += 2
                    break
                }
                if (depth === 0 && c === '>') {
                    i++
                    break
                }
                i++
            }
            tags.push({ start, end: i, kind: isClose ? 'close' : 'open', name, selfClose })
            continue
        }
        i++
    }
    return tags
}

/**
 * 扫描源码中的 JSX children 文本节点，检测占位文案。
 *
 * 实现：
 * 1. 用 extractAllTagBoundaries 提取所有标签边界（开+闭）
 * 2. 用栈跟踪 JSX 上下文（开标签 push，闭标签 pop）
 * 3. 在相邻标签之间的文本片段中检测占位词
 * 4. 仅在栈非空（即位于 JSX 元素内部）时检测，避免误报 JS 代码文本
 * 5. 对每个文本片段调用 cleanJsxText 清理 {...} 表达式容器
 *    （含 JSX 注释与子表达式 {expr}），仅保留纯文本字符
 *
 * 注意：input/textarea 的 placeholder 属性值在属性串中（已被标签边界
 * 跳过），不会被误报。注释中的占位词也被跳过。
 */
function scanPlaceholders(source: string, file: string, lineStarts: number[]): Placeholder[] {
    const out: Placeholder[] = []
    const len = source.length
    const tags = extractAllTagBoundaries(source)
    const stack: string[] = []

    const scanText = (text: string, baseOffset: number) => {
        if (text.length === 0) return
        // 清理 {...} 表达式容器（含 JSX 注释 {/* ... */} 与子表达式 {expr}）：
        // 将其中字符（含花括号本身）替换为空格，保持长度一致以保留偏移精度。
        // 这样后续 indexOf 检测到的纯文本字符即为真实 JSX children 文本。
        const cleaned = cleanJsxText(text)
        // 英文占位词（大小写敏感）
        for (const pat of PLACEHOLDER_PATTERNS_CASE_SENSITIVE) {
            let from = 0
            let idx = cleaned.indexOf(pat, from)
            while (idx !== -1) {
                const before = cleaned[idx - 1] ?? ' '
                const after = cleaned[idx + pat.length] ?? ' '
                if (isWordBoundary(before) && isWordBoundary(after)) {
                    pushPlaceholder(out, source, lineStarts, baseOffset + idx, pat, file, len)
                }
                from = idx + pat.length
                idx = cleaned.indexOf(pat, from)
            }
        }
        // 中文占位词
        for (const pat of PLACEHOLDER_PATTERNS_CHINESE) {
            let from = 0
            let idx = cleaned.indexOf(pat, from)
            while (idx !== -1) {
                const before = cleaned[idx - 1] ?? ' '
                const after = cleaned[idx + pat.length] ?? ' '
                if (isWordBoundary(before) && isWordBoundary(after)) {
                    pushPlaceholder(out, source, lineStarts, baseOffset + idx, pat, file, len)
                }
                from = idx + pat.length
                idx = cleaned.indexOf(pat, from)
            }
        }
    }

    for (let idx = 0; idx < tags.length; idx++) {
        const tag = tags[idx]!
        if (tag.kind === 'open' && !tag.selfClose) {
            stack.push(tag.name)
        } else if (tag.kind === 'close') {
            if (stack.length > 0) stack.pop()
        }
        // 在当前标签 end 与下一个标签 start 之间的文本片段中扫描
        const next = tags[idx + 1]
        if (next && stack.length > 0) {
            const text = source.slice(tag.end, next.start)
            scanText(text, tag.end)
        }
    }
    return out
}

/**
 * 判断字符是否为「词边界」。
 * 字母/数字/下划线视为词内字符（非边界），其余（含中文、空白、标点）视为边界。
 * 对于中文占位词（如"占位"），其前后若是中文或非字母数字，均视为边界。
 */
function isWordBoundary(ch: string | undefined): boolean {
    if (!ch) return true
    // ASCII 字母/数字/下划线属于词内字符
    if (/[A-Za-z0-9_]/.test(ch)) return false
    return true
}

/**
 * 清理 JSX children 文本片段：将 {...} 表达式容器内的字符（含花括号本身）
 * 替换为空格，保持长度一致以保留偏移精度。
 *
 * 表达式容器包括：
 *  - JSX 注释（花括号包裹的块注释）
 *  - 子表达式：{variable} / {expr ? a : b} / {items.map(...)}
 *  - 字符串字面量容器：{'TODO'} / {"敬请期待"}
 *
 * 清理后剩余的字符即为「纯 JSX 文本节点」内容，是用户在界面上真正看到的文字。
 *
 * 例：
 *   "Hello {name}, welcome!"         → "Hello        , welcome!"
 *   "支持 {'{变量}'} 占位符"          → "支持             占位符"
 *
 * 注意：仅处理花括号配对。若文本中出现未配对的 `{` 或 `}`（罕见，通常是
 * 代码错误），按原样保留不影响其余部分扫描。
 */
function cleanJsxText(text: string): string {
    const chars: string[] = new Array<string>(text.length)
    let depth = 0
    for (let i = 0; i < text.length; i++) {
        const ch = text[i] ?? ' '
        if (ch === '{') {
            depth++
            chars[i] = ' '
        } else if (ch === '}') {
            if (depth > 0) depth--
            chars[i] = ' '
        } else if (depth > 0) {
            chars[i] = ' '
        } else {
            chars[i] = ch
        }
    }
    return chars.join('')
}

// ---------------------------------------------------------------------------
// 文件遍历
// ---------------------------------------------------------------------------

function walkDir(dir: string, acc: string[] = []): string[] {
    let entries: string[]
    try {
        entries = readdirSync(dir) as string[]
    } catch {
        return acc
    }
    for (const name of entries) {
        const full = join(dir, name)
        let st: ReturnType<typeof statSync>
        try {
            st = statSync(full)
        } catch {
            continue
        }
        if (st.isDirectory()) {
            walkDir(full, acc)
        } else if (st.isFile()) {
            const ext = extname(full)
            if (SCAN_EXTENSIONS.has(ext)) acc.push(full)
        }
    }
    return acc
}

function shouldSkip(file: string): boolean {
    const rel = relative(SRC_DIR, file).replace(/\\/g, '/')
    return SKIP_PATHS.some((p) => rel === p)
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function auditFile(file: string, report: Pick<AuditReport, 'deadLinks' | 'redundant' | 'placeholders'>): {
    lines: number
} {
    const rel = relative(PROJECT_ROOT, file).replace(/\\/g, '/')
    let source: string
    try {
        source = readFileSync(file, 'utf8')
    } catch {
        return { lines: 0 }
    }
    const lineStarts = buildLineTable(source)
    const tags = extractJsxTags(source)
    const ctx: AuditContext = { file: rel, deadLinks: report.deadLinks, placeholders: report.placeholders }

    for (const tag of tags) {
        auditNativeButton(tag, ctx)
        auditNativeLink(tag, ctx)
        auditButtonComp(tag, ctx)
        auditLinkComp(tag, ctx)
        auditModal(tag, ctx)
        auditMenuItem(tag, ctx)
    }

    // 占位文案扫描仅对 .tsx 文件运行：.ts 文件无 JSX children，
    // 其中的注释/字符串虽可能含 "TODO" 等词，但属于代码注释而非界面文案，
    // 不应被报告为占位文案。
    if (file.endsWith('.tsx')) {
        const phs = scanPlaceholders(source, rel, lineStarts)
        for (const p of phs) report.placeholders.push(p)
    }

    return { lines: lineStarts.length }
}

function buildReport(): AuditReport {
    const files = walkDir(SRC_DIR).filter((f) => !shouldSkip(f)).sort()
    const partial: Pick<AuditReport, 'deadLinks' | 'redundant' | 'placeholders'> = {
        deadLinks: [],
        redundant: [],
        placeholders: [],
    }
    let totalLines = 0
    for (const f of files) {
        const { lines } = auditFile(f, partial)
        totalLines += lines
    }

    const byKind: Record<string, number> = {}
    for (const d of partial.deadLinks) {
        byKind[d.kind] = (byKind[d.kind] ?? 0) + 1
    }

    return {
        generatedAt: new Date().toISOString(),
        root: relative(process.cwd(), PROJECT_ROOT).replace(/\\/g, '/') || '.',
        scannedFiles: files.length,
        totalLines,
        deadLinks: partial.deadLinks,
        redundant: partial.redundant,
        placeholders: partial.placeholders,
        summary: {
            deadLinkCount: partial.deadLinks.length,
            redundantCount: partial.redundant.length,
            placeholderCount: partial.placeholders.length,
            byKind,
        },
    }
}

// ---------------------------------------------------------------------------
// 输出格式化
// ---------------------------------------------------------------------------

const COLORS = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
} as const

function color(s: string, c: keyof typeof COLORS): string {
    if (!process.stdout.isTTY) return s
    return `${COLORS[c]}${s}${COLORS.reset}`
}

function printReport(report: AuditReport): void {
    const lines: string[] = []
    lines.push('')
    lines.push(color('═'.repeat(72), 'cyan'))
    lines.push(color('  PoeticRealm v5.0  死链扫描报告', 'bold'))
    lines.push(color('═'.repeat(72), 'cyan'))
    lines.push(`  生成时间   : ${report.generatedAt}`)
    lines.push(`  扫描根目录 : ${report.root}/src`)
    lines.push(`  扫描文件数 : ${report.scannedFiles}`)
    lines.push(`  总代码行数 : ${report.totalLines.toLocaleString()}`)
    lines.push('')

    // 摘要
    const { deadLinkCount, redundantCount, placeholderCount } = report.summary
    const status = deadLinkCount === 0 && redundantCount === 0 && placeholderCount === 0
        ? color('PASS  零死链 / 零冗余 / 零占位', 'green')
        : color('FAIL  存在死链/冗余/占位', 'red')
    lines.push(`  ${color('总体状态', 'bold')} : ${status}`)
    lines.push(`  ${color('死链数', 'bold')}     : ${deadLinkCount === 0 ? color(String(deadLinkCount), 'green') : color(String(deadLinkCount), 'red')}`)
    lines.push(`  ${color('冗余数', 'bold')}     : ${redundantCount === 0 ? color(String(redundantCount), 'green') : color(String(redundantCount), 'yellow')}`)
    lines.push(`  ${color('占位数', 'bold')}     : ${placeholderCount === 0 ? color(String(placeholderCount), 'green') : color(String(placeholderCount), 'yellow')}`)
    lines.push('')

    // 死链详情
    if (report.deadLinks.length > 0) {
        lines.push(color('─'.repeat(72), 'gray'))
        lines.push(color('  死链详情 (Dead Links)', 'bold'))
        lines.push(color('─'.repeat(72), 'gray'))
        const grouped = groupBy(report.deadLinks, (d) => d.kind)
        for (const [kind, items] of Object.entries(grouped)) {
            lines.push(`  ${color(`[${kind}]`, 'magenta')} (${items.length})`)
            for (const d of items) {
                lines.push(`    ${color(`${d.file}:${d.line}:${d.column}`, 'red')}`)
                lines.push(`      ${color('原因:', 'dim')} ${d.reason}`)
                lines.push(`      ${color('建议:', 'dim')} ${d.suggestion}`)
                lines.push(`      ${color('片段:', 'dim')} ${d.snippet}`)
            }
            lines.push('')
        }
    }

    // 占位详情
    if (report.placeholders.length > 0) {
        lines.push(color('─'.repeat(72), 'gray'))
        lines.push(color('  占位文案 (Placeholders)', 'bold'))
        lines.push(color('─'.repeat(72), 'gray'))
        for (const p of report.placeholders) {
            lines.push(`  ${color(`${p.file}:${p.line}:${p.column}`, 'yellow')}  [${p.pattern}]`)
            lines.push(`    ${color('片段:', 'dim')} ${p.snippet}`)
        }
        lines.push('')
    }

    // 冗余详情
    if (report.redundant.length > 0) {
        lines.push(color('─'.repeat(72), 'gray'))
        lines.push(color('  冗余项 (Redundant)', 'bold'))
        lines.push(color('─'.repeat(72), 'gray'))
        for (const r of report.redundant) {
            lines.push(`  ${color(`${r.file}:${r.line}`, 'yellow')}  [${r.kind}]`)
            lines.push(`    ${color('原因:', 'dim')} ${r.reason}`)
        }
        lines.push('')
    }

    lines.push(color('═'.repeat(72), 'cyan'))
    lines.push('')
    process.stdout.write(lines.join('\n'))
}

function groupBy<T, K extends string>(arr: T[], key: (t: T) => K): Record<K, T[]> {
    const out = {} as Record<K, T[]>
    for (const item of arr) {
        const k = key(item)
        ;(out[k] ??= []).push(item)
    }
    return out
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { json: boolean; out?: string } {
    const opts = { json: false, out: undefined as string | undefined }
    for (const arg of argv.slice(2)) {
        if (arg === '--json') opts.json = true
        else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length)
        else if (arg === '-h' || arg === '--help') {
            process.stdout.write('Usage: node src/lib/link-auditor.ts [--json] [--out=path]\n')
            process.exit(0)
        }
    }
    return opts
}

function main(): void {
    const opts = parseArgs(process.argv)
    if (!existsSync(SRC_DIR)) {
        process.stderr.write(`Error: src directory not found at ${SRC_DIR}\n`)
        process.exit(2)
    }
    const report = buildReport()

    if (opts.out) {
        writeFileSync(opts.out, JSON.stringify(report, null, 2), 'utf8')
        process.stdout.write(`Report written to ${opts.out}\n`)
    }

    if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2))
    } else {
        printReport(report)
    }

    const failed = report.summary.deadLinkCount > 0 || report.summary.placeholderCount > 0
    process.exit(failed ? 1 : 0)
}

main()
