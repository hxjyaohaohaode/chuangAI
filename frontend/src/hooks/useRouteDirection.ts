/**
 * 路由方向检测 Hook（规范 8.3）
 *
 * 通过维护导航历史栈，检测当前路由切换是「前进」还是「后退」：
 * - 前进（深度增加）：新页面从右侧滑入 40px
 * - 后退（返回）：旧页面从左侧滑出 40px，新页面不动
 *
 * 实现：维护一个 pathname 栈。
 * - 新路径不在栈中 → push（前进）
 * - 新路径在栈中 → 截断到该位置（后退）
 *
 * 采用「render 阶段同步计算」模式（React 官方 adjusting-state-during-render 模式），
 * 确保方向在首次渲染时即正确，避免 useEffect 异步设置导致的首帧方向错误。
 *
 * StrictMode 安全：ref 修改在重复调用时幂等（第二次调用时 lastPathRef 已更新，跳过）。
 */

import { useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

export type RouteDirection = 'forward' | 'backward' | 'none'

export interface UseRouteDirectionResult {
    direction: RouteDirection
    /** 当前 pathname（与 useLocation 同步） */
    pathname: string
}

export function useRouteDirection(): UseRouteDirectionResult {
    const location = useLocation()
    const stackRef = useRef<string[]>([location.pathname])
    const lastPathRef = useRef<string>(location.pathname)
    const [direction, setDirection] = useState<RouteDirection>('none')

    // render 阶段同步检测方向（React 官方 "adjusting state during render" 模式）
    // 确保路由切换首帧即携带正确方向，驱动 .pr-route[data-direction] 入场动画
    if (location.pathname !== lastPathRef.current) {
        const newPath = location.pathname
        const stack = stackRef.current
        const idx = stack.indexOf(newPath)

        if (idx !== -1) {
            // 回到栈中已有路径 → 后退（截断栈至该位置）
            stack.length = idx + 1
            setDirection('backward')
        } else {
            // 新路径 → 前进（入栈）
            stack.push(newPath)
            setDirection('forward')
        }
        lastPathRef.current = newPath
    }

    return { direction, pathname: location.pathname }
}
