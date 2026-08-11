/**
 * 3D 组件统一导出（规范第 15.1 章 CSS 架构 · 模块化）
 *
 * 导出：
 *  - Scene3D：通用 3D 场景容器
 *  - useScene3DReducedMotion：prefers-reduced-motion 检测 hook
 */

export { Scene3D } from './Scene3D'
export type { Scene3DProps } from './Scene3D'
export { useScene3DReducedMotion } from './Scene3D'
