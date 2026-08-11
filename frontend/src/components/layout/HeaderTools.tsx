import type { UserRole } from '@/stores/auth'
import { ThinkingModeSwitcher } from '@/components/ui/ThinkingModeSwitcher'
import { NotificationCenter } from './NotificationCenter'
import { SettingsPanel } from './SettingsPanel'

export interface HeaderToolsProps {
    role: UserRole
}

/**
 * 非首屏关键的顶栏工具集合。
 *
 * 由 App 通过 React.lazy 延迟加载，避免通知历史、模型配置和思考强度面板
 * 进入 HTML 的初始 modulepreload；固定尺寸 fallback 负责保持顶栏布局稳定。
 */
export default function HeaderTools({ role }: HeaderToolsProps) {
    return (
        <>
            {role === 'teacher' && <ThinkingModeSwitcher />}
            <NotificationCenter />
            <SettingsPanel />
        </>
    )
}
