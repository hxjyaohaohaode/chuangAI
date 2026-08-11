import { forwardRef, useMemo } from 'react'
import type { Icon as PhosphorIcon, IconWeight } from '@phosphor-icons/react'
import {
    ArrowRight,
    ArrowSquareOut,
    Trash,
    ArrowsClockwise,
    Bell,
    BellSlash,
    BookOpen,
    Brain,
    CaretDown,
    CaretLeft,
    CaretRight,
    Check,
    CheckCircle,
    CircleNotch,
    Feather,
    Gear,
    Globe,
    GraduationCap,
    Graph,
    Info,
    List,
    MagnifyingGlass,
    Notebook,
    PencilSimpleLine,
    Robot,
    Scroll,
    ShieldCheck,
    SidebarSimple,
    Sparkle,
    TextAa,
    User,
    WarningCircle,
    WifiSlash,
    X,
    XCircle,
} from '@phosphor-icons/react'
import { cn } from '@/lib/cn'

/**
 * Phosphor 图标封装（规范第 13 章）
 *
 * 设计要点：
 * - 零 emoji：所有图形语义由 SVG 图标承载
 * - 统一 24px 网格，光学体积均衡
 * - 常态 Regular（1.5px 描边），选中态自动切换 Bold，150ms 过渡
 * - 图标颜色默认继承 currentColor，不单独设色
 * - 通过注册表按需引入，保证 tree-shaking，不污染首包体积
 *
 * 用法：
 *   <Icon name="check" />
 *   <Icon name="house" size={24} active />
 */

/**
 * 核心图标注册表 —— 仅包含**常驻 chrome** 所需图标
 *
 * 收录标准（严格）：只有在「登录页 / AppShell / 顶栏 / 侧边导航 / Toast /
 * 命令面板 / 错误边界 / 同步指示器」中出现的图标才放这里。
 * 任何只被某个懒加载路由页面使用的图标，一律放 icons-extended.ts。
 *
 * 为什么必须严格：Phosphor 每个图标要携带 6 种字重的路径数据（约 3KB 原始体积），
 * 多收录 10 个用不上的图标，首屏就白白多背 30KB。
 *
 * 反过来也要警惕：常驻组件若用了**只在** icons-extended 注册的图标，
 * 首屏渲染时该图标会静默消失并打印告警（曾出现过 trash / arrow-square-out
 * 两个通知中心与设置面板的按钮图标）。新增常驻组件图标时务必登记到本表。
 */
const REGISTRY = {
    // 以下三枚此前只登记在 icons-extended，而通知中心「清空」按钮、
    // 设置面板「外链」按钮、空状态「前往」按钮都是常驻 chrome，
    // 首屏在扩展表异步到位前会渲染成空白并打印告警。补登记到核心表。
    'arrow-right': ArrowRight,
    'arrow-square-out': ArrowSquareOut,
    trash: Trash,
    x: X,
    'warning-circle': WarningCircle,
    'magnifying-glass': MagnifyingGlass,
    list: List,
    'book-open': BookOpen,
    graduation: GraduationCap,
    gear: Gear,
    user: User,
    'arrows-clockwise': ArrowsClockwise,
    sparkle: Sparkle,
    feather: Feather,
    scroll: Scroll,
    bell: Bell,
    'bell-slash': BellSlash,
    'check-circle': CheckCircle,
    check: Check,
    'caret-left': CaretLeft,
    'caret-right': CaretRight,
    'caret-down': CaretDown,
    robot: Robot,
    graph: Graph,
    brain: Brain,
    'pencil-simple-line': PencilSimpleLine,
    'circle-notch': CircleNotch,
    globe: Globe,
    'shield-check': ShieldCheck,
    'wifi-slash': WifiSlash,
    info: Info,
    'x-circle': XCircle,
    sidebar: SidebarSimple,
    'text-aa': TextAa,
    notebook: Notebook,
} as const satisfies Record<string, PhosphorIcon>

export type IconName = keyof typeof REGISTRY

/**
 * 由懒加载页面在渲染前通过 icons-extended 注册的已知图标。
 * 它们刻意不进入核心注册表，避免非首屏路径数据污染首包。
 */
export type DeferredIconName =
    | 'lightbulb'
    | 'play'
    | 'stop'
    | 'student'
export type KnownIconName = IconName | DeferredIconName

/** 扩展图标注册表 —— 业务侧可按需追加图标 */
const extensionRegistry: Record<string, PhosphorIcon> = {}

export function registerIcons(icons: Record<string, PhosphorIcon>): void {
    Object.assign(extensionRegistry, icons)
}

function resolveIcon(name: string): PhosphorIcon | undefined {
    return (REGISTRY as Record<string, PhosphorIcon>)[name] ?? extensionRegistry[name]
}

export interface IconProps {
    /** 图标名称（kebab-case，对应注册表键） */
    name: KnownIconName | (string & Record<never, never>)
    /** 尺寸（px），默认 20 */
    size?: number | string
    /** 颜色，默认继承 currentColor */
    color?: string
    /** 描边粗细；active 为 true 时自动切换为 bold */
    weight?: IconWeight
    /** 选中/激活态 —— 自动切换 Bold 描边并 150ms 过渡 */
    active?: boolean
    /** 镜像翻转 */
    mirrored?: boolean
    className?: string
    'aria-label'?: string
    'aria-hidden'?: boolean
}

export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
    {
        name,
        size = 20,
        color,
        weight,
        active = false,
        mirrored,
        className,
        'aria-label': ariaLabel,
        'aria-hidden': ariaHidden = !ariaLabel,
    },
    ref,
) {
    const Resolved = resolveIcon(name)

    const resolvedWeight: IconWeight = useMemo(() => {
        if (weight) return weight
        return active ? 'bold' : 'regular'
    }, [weight, active])

    if (!Resolved) {
        if (import.meta.env.DEV) {
            console.warn(`[Icon] 未注册的图标名: "${name}"。请通过 registerIcons 注册。`)
        }
        return null
    }

    return (
        <Resolved
            ref={ref}
            size={size}
            color={color}
            weight={resolvedWeight}
            mirrored={mirrored}
            aria-label={ariaLabel}
            aria-hidden={ariaHidden}
            className={cn('transition-[opacity,color] duration-150 ease-out shrink-0', className)}
        />
    )
})
