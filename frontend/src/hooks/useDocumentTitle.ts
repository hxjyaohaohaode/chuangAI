/**
 * useDocumentTitle —— 动态设置页面标题（WCAG 2.4.2 Page Titled A 级）
 *
 * 职责：
 * 1. 挂载时将 document.title 设置为指定标题
 * 2. 卸载时恢复原标题（避免标题泄漏到不相关页面）
 * 3. 标题变化时实时更新
 *
 * a11y 意义：
 * - 屏幕阅读器用户通过标题识别当前页面（首次加载 + 路由切换时朗读）
 * - 浏览器标签页/历史记录显示有意义的标题
 * - SEO 友好
 *
 * 用法：
 *   useDocumentTitle('首页 · 诗脉·启明')
 *   // 或动态标题
 *   useDocumentTitle(`错题本 · ${studentName}`)
 */

import { useEffect, useRef } from 'react'

const BASE_TITLE = '诗脉·启明 PoeticRealm AI'

/**
 * 设置页面标题。传入完整标题字符串，自动追加基础品牌名。
 * @param title 页面标题（不含品牌名），传 undefined 时不更新
 * @param suffix 品牌后缀，默认 '诗脉·启明 PoeticRealm AI'
 */
export function useDocumentTitle(title?: string, suffix: string = BASE_TITLE): void {
    const prevTitleRef = useRef(document.title)

    useEffect(() => {
        if (!title) return

        prevTitleRef.current = document.title
        document.title = `${title} · ${suffix}`

        return () => {
            document.title = prevTitleRef.current
        }
    }, [title, suffix])
}

/**
 * 仅设置标题（不追加品牌后缀），用于需要完全自定义标题的场景。
 */
export function useRawDocumentTitle(fullTitle?: string): void {
    const prevTitleRef = useRef(document.title)

    useEffect(() => {
        if (!fullTitle) return

        prevTitleRef.current = document.title
        document.title = fullTitle

        return () => {
            document.title = prevTitleRef.current
        }
    }, [fullTitle])
}
