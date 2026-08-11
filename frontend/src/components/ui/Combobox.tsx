/**
 * Combobox 自研下拉组件（规范 14.5 / 14.2 / 7.x）
 *
 * 设计目标：替换原生 `<select>`，提供：
 * - 单选 / 多选两种模式（mode: 'single' | 'multi'）
 * - 实时过滤（不区分大小写包含匹配）
 * - 完整键盘导航（↑↓ Enter Esc Space Backspace）
 * - 玻璃态下拉面板（surface-elevated + backdrop-blur 20px）
 * - 多选 chips 标签组（带 × 删除按钮）
 * - 无障碍：aria-combobox / aria-expanded / aria-activedescendant / role=listbox
 *
 * 设计依据：
 * - 透明度驱动暖调色板（规范第 2 章）
 * - 无边框优先策略（规范第 4 章）
 * - 即时反馈三态：hover / active / focus-visible（规范 7.1 / 7.2）
 * - 入场 250ms spring-soft / 离场 200ms ease-in（规范 6.3）
 *
 * 用法：
 *   <Combobox
 *     mode="single"
 *     options={opts}
 *     value={val}
 *     onChange={setVal}
 *   />
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { cn } from '@/lib/cn'
import './Combobox.css'

/* ============================================================
 * 类型定义
 * ============================================================ */

export interface ComboboxOption {
    /** 选项值（唯一标识） */
    value: string
    /** 显示标签 */
    label: string
    /** 所属分组（可选，按分组聚合展示） */
    group?: string
    /** 禁用态 */
    disabled?: boolean
}

export interface ComboboxProps {
    /** 选项列表 */
    options: readonly ComboboxOption[]
    /** 受控值：单选为 string，多选为 string[] */
    value: string | string[]
    /** 值变更回调 */
    onChange: (value: string | string[]) => void
    /** 模式：单选 / 多选，默认 single */
    mode?: 'single' | 'multi'
    /** 占位提示文案 */
    placeholder?: string
    /** 是否可搜索（关闭时输入框只读），默认 true */
    searchable?: boolean
    /** 整体禁用 */
    disabled?: boolean
    /** 自定义类名 */
    className?: string
    /** 输入框 id（用于 label 关联） */
    id?: string
    /** aria-label 文案 */
    ariaLabel?: string
}

/* ============================================================
 * 组件
 * ============================================================ */

export function Combobox({
    options,
    value,
    onChange,
    mode = 'single',
    placeholder = '请选择…',
    searchable = true,
    disabled = false,
    className,
    id,
    ariaLabel,
}: ComboboxProps) {
    const isMulti = mode === 'multi'

    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [activeIndex, setActiveIndex] = useState(-1)

    const containerRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const listboxRef = useRef<HTMLDivElement>(null)

    const reactId = useId()
    const comboboxId = id ?? reactId
    const listboxId = `${comboboxId}-listbox`

    /* ------------------------------------------------------------
     * 受控值处理
     * ---------------------------------------------------------- */

    const selectedValues: string[] = useMemo(() => {
        if (Array.isArray(value)) return value
        return value ? [value] : []
    }, [value])

    const isSelected = useCallback(
        (val: string) => selectedValues.includes(val),
        [selectedValues],
    )

    // 单选模式下的已选 label（用于关闭态显示）
    const selectedLabel = useMemo(() => {
        if (isMulti) return ''
        if (selectedValues.length === 0) return ''
        const v = selectedValues[0]
        return options.find((o) => o.value === v)?.label ?? ''
    }, [isMulti, selectedValues, options])

    /* ------------------------------------------------------------
     * 过滤与分组
     * ---------------------------------------------------------- */

    // 实时过滤：不区分大小写包含匹配
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return options
        return options.filter((opt) => opt.label.toLowerCase().includes(q))
    }, [options, query])

    // 按分组聚合（无 group 的归到默认分组）
    const grouped = useMemo(() => {
        const map = new Map<string, ComboboxOption[]>()
        for (const opt of filtered) {
            const g = opt.group ?? ''
            const arr = map.get(g) ?? []
            arr.push(opt)
            map.set(g, arr)
        }
        return Array.from(map.entries())
    }, [filtered])

    // 扁平化索引（用于 activeIndex 与键盘导航）
    const flatList = filtered

    /* ------------------------------------------------------------
     * 选中/取消选中
     * ---------------------------------------------------------- */

    const selectOption = useCallback(
        (opt: ComboboxOption) => {
            if (opt.disabled) return
            if (isMulti) {
                const next = isSelected(opt.value)
                    ? selectedValues.filter((v) => v !== opt.value)
                    : [...selectedValues, opt.value]
                onChange(next)
                // 多选保持打开，但清空搜索词以便继续选择
                setQuery('')
                setActiveIndex(-1)
            } else {
                onChange(opt.value)
                setOpen(false)
                setQuery('')
            }
        },
        [isMulti, isSelected, selectedValues, onChange],
    )

    const removeChip = useCallback(
        (val: string) => {
            if (!isMulti) return
            onChange(selectedValues.filter((v) => v !== val))
        },
        [isMulti, selectedValues, onChange],
    )

    /* ------------------------------------------------------------
     * 打开 / 关闭
     * ---------------------------------------------------------- */

    const openDropdown = useCallback(() => {
        if (disabled) return
        setOpen(true)
        setActiveIndex(flatList.length > 0 ? 0 : -1)
    }, [disabled, flatList.length])

    const closeDropdown = useCallback(() => {
        setOpen(false)
        setQuery('')
        setActiveIndex(-1)
    }, [])

    // 点击外部关闭（mousedown 优先于 click，避免与触发器点击冲突）
    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                closeDropdown()
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open, closeDropdown])

    // activeIndex 越界保护
    useEffect(() => {
        if (activeIndex >= flatList.length) {
            setActiveIndex(flatList.length === 0 ? -1 : 0)
        }
    }, [flatList.length, activeIndex])

    // 滚动 active 项进入可视区
    useEffect(() => {
        if (!open || activeIndex < 0 || !listboxRef.current) return
        const el = listboxRef.current.querySelector<HTMLElement>(
            `[data-option-idx="${activeIndex}"]`,
        )
        el?.scrollIntoView({ block: 'nearest' })
    }, [activeIndex, open])

    /* ------------------------------------------------------------
     * 键盘导航（规范 7.x / 8.x）
     * ---------------------------------------------------------- */

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (disabled) return

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault()
                    if (!open) {
                        openDropdown()
                    } else if (flatList.length > 0) {
                        setActiveIndex((i) => Math.min(i + 1, flatList.length - 1))
                    }
                    break
                case 'ArrowUp':
                    e.preventDefault()
                    if (!open) {
                        openDropdown()
                    } else if (flatList.length > 0) {
                        setActiveIndex((i) => Math.max(i - 1, 0))
                    }
                    break
                case 'Home':
                    e.preventDefault()
                    if (!open) {
                        openDropdown()
                    } else if (flatList.length > 0) {
                        setActiveIndex(0)
                    }
                    break
                case 'End':
                    e.preventDefault()
                    if (!open) {
                        openDropdown()
                    } else if (flatList.length > 0) {
                        setActiveIndex(flatList.length - 1)
                    }
                    break
                case 'Enter':
                    if (open && activeIndex >= 0) {
                        e.preventDefault()
                        const opt = flatList[activeIndex]
                        if (opt) selectOption(opt)
                    }
                    break
                case 'Escape':
                    if (open) {
                        e.preventDefault()
                        closeDropdown()
                    }
                    break
                case ' ':
                    // 多选模式下，输入框为空时空格键用于确认高亮项
                    if (isMulti && open && activeIndex >= 0 && query === '') {
                        e.preventDefault()
                        const opt = flatList[activeIndex]
                        if (opt) selectOption(opt)
                    }
                    break
                case 'Backspace':
                    // 多选模式下，输入框为空时删除最后一个 chip
                    if (isMulti && query === '' && selectedValues.length > 0) {
                        e.preventDefault()
                        onChange(selectedValues.slice(0, -1))
                    }
                    break
            }
        },
        [
            disabled,
            open,
            openDropdown,
            closeDropdown,
            flatList,
            activeIndex,
            selectOption,
            isMulti,
            query,
            selectedValues,
            onChange,
        ],
    )

    /* ------------------------------------------------------------
     * 输入框事件
     * ---------------------------------------------------------- */

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!searchable) return
        setQuery(e.target.value)
        if (!open) setOpen(true)
        setActiveIndex(flatList.length > 0 ? 0 : -1)
    }

    const handleTriggerClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (disabled) return
        // 输入框自身的 focus 已负责打开下拉框。若同一次鼠标点击继续在父级
        // trigger 中执行“打开/关闭”切换，React 刷新后会把刚打开的菜单立即
        // 关闭，导致鼠标无法选择班级、题目等选项。输入点击只保证打开；箭头
        // 与输入框外的触发区仍保留正常切换行为。
        if (event.target === inputRef.current) {
            if (!open) openDropdown()
            return
        }
        if (open) {
            closeDropdown()
        } else {
            openDropdown()
            // 异步聚焦，确保在状态更新后
            window.requestAnimationFrame(() => inputRef.current?.focus())
        }
    }

    const handleInputFocus = () => {
        if (!disabled && !open) openDropdown()
    }

    /* ------------------------------------------------------------
     * 渲染辅助
     * ---------------------------------------------------------- */

    // 计算 aria-activedescendant
    const activeOptionId =
        open && activeIndex >= 0 && flatList[activeIndex]
            ? `${comboboxId}-option-${activeIndex}`
            : undefined

    // 输入框显示值
    const inputValue = isMulti
        ? query
        : searchable
            ? open
                ? query
                : selectedLabel
            : selectedLabel

    // 占位符：多选已有 chip 时不显示
    const effectivePlaceholder =
        isMulti && selectedValues.length > 0 ? '' : placeholder

    // 扁平化索引计数器（按分组渲染时同步）
    let flatCounter = -1

    return (
        <div
            ref={containerRef}
            className={cn(
                'pr-combobox',
                `pr-combobox--${mode}`,
                open && 'is-open',
                disabled && 'is-disabled',
                className,
            )}
        >
            {/* 触发器（输入框 + chips + 箭头） */}
            <div
                className="pr-combobox-trigger"
                onClick={handleTriggerClick}
                data-disabled={disabled || undefined}
            >
                {/* 多选 chips 标签组 */}
                {isMulti && selectedValues.length > 0 && (
                    <div className="pr-combobox-chips" aria-hidden={false}>
                        {selectedValues.map((val) => {
                            const opt = options.find((o) => o.value === val)
                            if (!opt) return null
                            return (
                                <span key={val} className="pr-combobox-chip">
                                    <span className="pr-combobox-chip-label">{opt.label}</span>
                                    <button
                                        type="button"
                                        className="pr-combobox-chip-remove"
                                        aria-label={`移除 ${opt.label}`}
                                        disabled={disabled}
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            removeChip(val)
                                        }}
                                    >
                                        <Icon name="x" size={11} />
                                    </button>
                                </span>
                            )
                        })}
                    </div>
                )}

                {/* 输入框 */}
                <input
                    ref={inputRef}
                    id={comboboxId}
                    type="text"
                    className="pr-combobox-input"
                    placeholder={effectivePlaceholder}
                    value={inputValue}
                    onChange={handleInputChange}
                    onKeyDown={onKeyDown}
                    onFocus={handleInputFocus}
                    disabled={disabled}
                    readOnly={!searchable}
                    autoComplete="off"
                    spellCheck={false}
                    role="combobox"
                    aria-expanded={open}
                    aria-controls={listboxId}
                    aria-autocomplete="list"
                    aria-activedescendant={activeOptionId}
                    aria-label={ariaLabel}
                    aria-haspopup="listbox"
                />

                {/* 下拉箭头图标 */}
                <Icon
                    name="caret-down"
                    size={16}
                    className={cn('pr-combobox-arrow', open && 'is-open')}
                    aria-hidden
                />
            </div>

            {/* 下拉面板 */}
            {open && (
                <div
                    ref={listboxRef}
                    id={listboxId}
                    className="pr-combobox-listbox"
                    role="listbox"
                    aria-multiselectable={isMulti || undefined}
                >
                    {filtered.length === 0 ? (
                        <div className="pr-combobox-empty" role="status">
                            <Icon name="magnifying-glass" size={16} aria-hidden />
                            <span>{query ? '无结果' : '暂无选项'}</span>
                        </div>
                    ) : (
                        grouped.map(([group, items]) => (
                            <div
                                key={group || '__default_group__'}
                                className="pr-combobox-group"
                                role="group"
                                aria-label={group || undefined}
                            >
                                {group && (
                                    <div className="pr-combobox-group-label">{group}</div>
                                )}
                                {items.map((opt) => {
                                    flatCounter += 1
                                    const idx = flatCounter
                                    const isActive = idx === activeIndex
                                    const isSelectedOpt = isSelected(opt.value)
                                    return (
                                        <div
                                            key={opt.value}
                                            id={`${comboboxId}-option-${idx}`}
                                            data-option-idx={idx}
                                            role="option"
                                            aria-selected={isSelectedOpt}
                                            aria-disabled={opt.disabled || undefined}
                                            className={cn(
                                                'pr-combobox-option',
                                                isActive && 'is-active',
                                                isSelectedOpt && 'is-selected',
                                                opt.disabled && 'is-disabled',
                                            )}
                                            onClick={() => selectOption(opt)}
                                            onMouseEnter={() => setActiveIndex(idx)}
                                        >
                                            <span className="pr-combobox-option-label">
                                                {opt.label}
                                            </span>
                                            {isSelectedOpt && (
                                                <Icon
                                                    name="check"
                                                    size={14}
                                                    className="pr-combobox-option-check"
                                                    aria-hidden
                                                />
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    )
}
