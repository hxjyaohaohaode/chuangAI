import { QueryProvider } from '@/components/providers/QueryProvider'
import { CommandPalette, type CommandPaletteProps } from './CommandPalette'

/** 仅在用户首次打开命令面板时加载查询运行时与搜索数据。 */
export default function QueryCommandPalette(props: CommandPaletteProps) {
    return (
        <QueryProvider>
            <CommandPalette {...props} />
        </QueryProvider>
    )
}
