import type { ReactNode } from 'react'
import './Table.css'
import { cn } from '@/lib/cn'

/**
 * Table 表格（规范 14.6 / 9.2）
 *
 * 无外边框、无列边框
 * 表头：transparent 背景 + text-secondary + 字重 600 + 底部 1px alpha 8% 分割线
 * 行：奇数 transparent / 偶数 rgba(240,235,225,0.25) / hover rgba(240,235,225,0.55)
 * 单元格 padding 10px 16px
 * 数字列右对齐 + tabular-nums
 * 支持泛型 <T> 传入 columns + data
 */

export interface TableColumn<T> {
    /** 唯一 key */
    key: string
    /** 表头标题 */
    title: ReactNode
    /** 单元格渲染函数 */
    render?: (row: T, index: number) => ReactNode
    /** 是否为数字列（右对齐 + tabular-nums） */
    numeric?: boolean
    /** 列宽（CSS 宽度） */
    width?: string
    /** 单元格对齐 */
    align?: 'left' | 'right' | 'center'
    /** 表头 className */
    headerClassName?: string
    /** 单元格 className */
    cellClassName?: string
}

export interface TableProps<T> {
    /** 列定义 */
    columns: TableColumn<T>[]
    /** 数据源 */
    data: T[]
    /** 行 key 提取器 */
    rowKey?: (row: T, index: number) => string | number
    /** 空数据占位 */
    empty?: ReactNode
    className?: string
}

export function Table<T>({
    columns,
    data,
    rowKey,
    empty = '暂无数据',
    className,
}: TableProps<T>) {
    return (
        <div className={cn('pr-table-wrapper', className)}>
            <table className="pr-table">
                <thead>
                    <tr>
                        {columns.map((col) => (
                            <th
                                key={col.key}
                                className={cn(col.numeric && 'is-numeric', col.headerClassName)}
                                style={{ width: col.width, textAlign: col.align ?? (col.numeric ? 'right' : 'left') }}
                            >
                                {col.title}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {data.length === 0 ? (
                        <tr>
                            <td
                                colSpan={columns.length}
                                style={{ textAlign: 'center', padding: 'var(--space-2xl)', color: 'rgb(var(--c-text-tertiary))' }}
                            >
                                {empty}
                            </td>
                        </tr>
                    ) : (
                        data.map((row, index) => (
                            <tr
                                key={rowKey ? rowKey(row, index) : index}
                            >
                                {columns.map((col) => (
                                    <td
                                        key={col.key}
                                        className={cn(col.numeric && 'pr-table-td--numeric', col.cellClassName)}
                                        style={{ textAlign: col.align ?? (col.numeric ? 'right' : 'left') }}
                                    >
                                        {col.render ? col.render(row, index) : String((row as Record<string, unknown>)[col.key] ?? '')}
                                    </td>
                                ))}
                            </tr>
                        ))
                    )}
                </tbody>
            </table>
        </div>
    )
}
