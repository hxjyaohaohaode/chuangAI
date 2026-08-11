/**
 * UI 组件统一出口
 * 基础设计系统组件，严格遵循《界面设计规范.md》
 */

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button'
export { Input, type InputComponentProps, type InputProps, type TextareaProps } from './Input'
export { Card, type CardProps } from './Card'
export { Modal, type ModalProps, type ModalSize } from './Modal'
export { Combobox, type ComboboxOption, type ComboboxProps } from './Combobox'
export { Badge, type BadgeProps, type BadgeVariant } from './Badge'
export { AIBadge, type AIBadgeProps } from './AIBadge'
export { Table, type TableProps, type TableColumn } from './Table'
export {
    Icon,
    type IconProps,
    type IconName,
    type DeferredIconName,
    type KnownIconName,
    registerIcons,
} from './Icon'
export { type EmptyStateProps, type EmptyStateAction, type EmptyStateKey } from './EmptyState'
// VirtualList —— 自研虚拟列表组件（SubTask 25.2）
// 每项 80px 高，缓冲区上下各 5 项，节流 100ms，GPU 友好 transform 定位
export { VirtualList, type VirtualListProps, type VirtualListPropsOf } from './VirtualList'
// 注意：Markdown 不在此 barrel file 导出，避免 markdown-vendor 被首屏 modulepreload
// 各页面请直接从 '@/components/ui/Markdown' 导入，实现路由级代码分割
export { ToastContainer } from './Toast'

// 布局辅助组件
// SidebarResizer —— 侧边栏宽度可调节手柄（拖拽 + 双击预设 + 持久化）
// 配合 AppShell aside 使用，桌面端生效，移动端（<768px）自动 return null
export { SidebarResizer, type SidebarResizerProps } from './SidebarResizer'

// 微细节组件（Task 7.x）
export { Skeleton, SkeletonCircle, type SkeletonProps, type SkeletonTextProps } from './Skeleton'
export { AnimatedNumber, type AnimatedNumberProps } from './AnimatedNumber'
export {
    ErrorBoundary,
    SectionErrorBoundary,
    SectionFallback,
    type ErrorBoundaryProps,
    type SectionErrorBoundaryProps,
    type SectionFallbackProps,
} from './ErrorBoundary'
// CommandPalette 含 TanStack Query，仅由 QueryCommandPalette 懒入口直接导入；
// 禁止从本首屏 barrel re-export，否则 Rollup 会把查询运行时重新拉回静态预载链。
// TabSplitPanel —— 全局长滚动解决方案基础设施（规范第 5、6、8 章）
// 将长页面拆分为多个 Tab 面板，默认只显示第一个 Tab 内容，用户按需切换
// 配合 CommandPalette + CardSwap 实现"三合一组合方案"
// spring-soft 250ms 切换动画 + 完整键盘导航 + URL hash 同步 + localStorage 持久化
export { TabSplitPanel, type TabSplitPanelProps, type TabSplitPanelTab } from './TabSplitPanel'
export {
    SyncProgressBar,
    OfflineBanner,
    RollbackFlash,
    useOnlineStatus,
    useOptimisticUpdate,
    type SyncProgressBarProps,
    type OfflineBannerProps,
    type RollbackFlashProps,
    type OptimisticUpdateOptions,
    type OptimisticUpdateResult,
} from './SyncIndicator'

// 文字动效类组件（spec v7 Phase 1）
// VariableProximity —— 鼠标距离驱动字重变化（用普通 span 替代 motion.span，零依赖）
// 严格移植自《优质前端部件组/7_文本显示粗化.md》，6 Props 完整对齐
export { VariableProximity, type VariableProximityProps } from './VariableProximity'

/* ── 路由专用图形组件：**刻意不从本 barrel 导出** ──
 *
 * SphereGallery、PixelSnow、Radar 与 StarfieldBackground 均为项目独立的
 * React/DOM/CSS 实现，不创建 Canvas/WebGL 上下文。它们仍由所属路由按路径
 * 直接引入，以保持首屏 barrel 稳定并明确路由级所有权。
 *
 * 正确用法：
 *   import { SphereGallery } from '@/components/ui/SphereGallery'
 *   import { PixelSnow } from '@/components/ui/PixelSnow'
 *   import { Radar } from '@/components/ui/Radar'
 *
 * 新增任何依赖重型图形库的组件时，同样不要加进本文件。
 */

// 卡片/布局类组件（spec v7 Phase 3）
export { GlassCard, type GlassCardProps } from './GlassCard'
// MagicBento —— 教学闭环入口矩阵（项目独立 React/CSS 实现）
// 保留原公开 Props 与原生链接行为；无 GSAP、全局监听、随机数或运行时 DOM 注入
// 暖调光层、确定性星点与图片失败兜底均限制在卡片自身，支持 reduced-motion/forced-colors/print

// ElectricBorder —— 卡片周边特效（Canvas 噪声扰动电流描边 + 三层 glow）
// 严格移植自《优质前端部件组/8_卡片周边特效.md》，7 Props 完整对齐
// 暖调适配：紫色 #5227FF → 暖金 rgb(197, 133, 59)，background-glow opacity 0.3 → 0.18

// MagicRings —— 边框流转光韵（SVG path + stroke-dasharray 动画）
// spec v10 Task 8 重写：彻底消除长方形旋转问题，光韵严格沿容器边框流转
// 4s 默认循环，多层光韵错开 delay，ResizeObserver 自适应容器尺寸
// 暖调适配：默认 color #C5853B（accent-primary），无 WebGL 依赖

// GradualBlur —— 渐进模糊边界遮罩
// 严格移植自《优质前端部件组/13_模糊边界显示.md》，17 Props 完整对齐
// 透明度驱动的边缘渐隐 + backdrop-filter 多层叠加，支持 4 方向 / 5 曲线 / 12 预设

// TextPressure —— 变量字体鼠标距离驱动形变
// 严格移植自《优质前端部件组/2_文本压力.md》，14 Props 完整对齐
// 暖调适配：textColor #FFFFFF → text-primary，strokeColor #FF0000 → accent-primary

// PixelTransition —— 图片蒙版显示（像素过渡）
// 独立 React/CSS 状态机；像素网格按确定性顺序揭示/隐藏，
// hover 或 Enter/Space/click 显式切换，并支持 reduced-motion。
// 暖调适配：#222 → surface-tertiary，2px solid #fff → box-shadow + 圆角

// CardSwap —— 多界面内容展示卡片（3D 翻转轮播）
// 独立 React/CSS 实现；多张卡片以有限层数错落排列，自动轮换受页面可见性与视口状态约束。
// 暖调适配：黑底 → surface-elevated 玻璃态，硬边框 → box-shadow + 圆角
// 注意：CardSwap 内部的 Card 子组件不在此 barrel file 导出，
// 因 Card 名字与 ./Card 冲突。请直接从 '@/components/ui/CardSwap' 导入 Card。

// StackGallery —— 类微信图像重叠显示（卡片堆叠 + Lightbox）
// 独立 React/CSS + 原生 pointer events 实现拖拽、轮换与 lightbox；
// 自动播放受页面可见性和视口状态约束，触屏与 reduced-motion 有静态兜底。

// FallingText —— 独立 React/CSS 词级有限入场；不使用 Matter.js、Canvas 或持续物理循环。
// 点击实例保留 Enter/Space，触屏、reduced-motion 与 forced-colors 保留完整静态标题。

// 背景/数据类组件（spec v7 Phase 4）
// StarfieldBackground 按路径引入，保持背景装饰与通用 barrel 的依赖边界
// CodeStream —— 流式输出代码（highlight.js 语法高亮）
// 刻意不在此导出：它静态 import 了 highlight.js/lib/common（158KB 原始体积，
// 占入口 chunk 的 33%）。本组件目前无任何调用方；即便将来启用，也应由使用方
// 按路径直接引入，让 highlight.js 落到对应路由 chunk。
//   import { CodeStream } from '@/components/ui/CodeStream'

// 辅助导航类组件
// AnchorMiniMap —— 右侧悬浮锚点迷你地图（position: fixed 辅助导航组件，允许保留 fixed）
// 自动扫描页面内 [data-anchor] 元素生成目录，IntersectionObserver 高亮当前章节
// 滚动时高亮 + 点击平滑滚动 + hover 展开 + localStorage 持久化 + 移动端不渲染
export { AnchorMiniMap, type AnchorMiniMapProps } from './AnchorMiniMap'

/* ── 路由专用动效组件：**刻意不从本 barrel 导出** ──
 *
 * ScrollReveal / StreamText / MasonryGrid / MagicBento / PixelTransition /
 * CardSwap / StackGallery 等均为独立 React/CSS 实现。它们按路径直接引入，
 * 既避免常驻 barrel 把非首屏组件钉进入口依赖图，也保留路由级代码分割。
 */

/* TextSwitch 已重写为独立 React/CSS 组件，不再依赖 GSAP；仍按路径引入，
 * 以保持懒加载 ClassroomPage 与首屏 barrel 的依赖边界。
 *   import { TextSwitch } from '@/components/ui/TextSwitch'
 */

/* ── 仅懒加载路由使用的展示组件：**刻意不从本 barrel 导出** ──
 *
 * GlowBorder / GradualBlur / TextPressure / RadarChart / PoemImage /
 * AnimatedList / Counter / ElectricBorder / MagicRings / FallingText
 *
 * 它们没有一个出现在常驻 chrome 里，全部只服务于某个懒加载页面。
 * 但只要在本 barrel 里 re-export，模块就会被钉进入口 chunk
 * （barrel 本身处于首屏依赖图中），首屏因此白背这些组件的体积。
 *
 * 正确用法：按路径直接引入。
 *   import { GlowBorder } from '@/components/ui/GlowBorder'
 */
