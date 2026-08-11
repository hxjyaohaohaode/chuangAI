import type { Config } from 'tailwindcss'

// Tailwind 配置 - 设计令牌由 tokens.css 注入，content 扫描 src 目录
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // 设计令牌引用 - 由 src/styles/tokens.css 提供具体值
      colors: {
        'surface-primary': 'rgb(var(--c-surface-primary) / <alpha-value>)',
        'surface-secondary': 'rgb(var(--c-surface-secondary) / <alpha-value>)',
        'surface-tertiary': 'rgb(var(--c-surface-tertiary) / <alpha-value>)',
        'text-primary': 'rgb(var(--c-text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--c-text-secondary) / <alpha-value>)',
        'text-tertiary': 'rgb(var(--c-text-tertiary) / <alpha-value>)',
        'text-inverse': 'rgb(var(--c-text-inverse) / <alpha-value>)',
        'accent-primary': 'rgb(var(--c-accent-primary) / <alpha-value>)',
        'accent-primary-hover': 'rgb(var(--c-accent-primary-hover) / <alpha-value>)',
        'accent-success': 'rgb(var(--c-accent-success) / <alpha-value>)',
        'accent-warning': 'rgb(var(--c-accent-warning) / <alpha-value>)',
        'accent-error': 'rgb(var(--c-accent-error) / <alpha-value>)',
        'accent-info': 'rgb(var(--c-accent-info) / <alpha-value>)',
        // v5.1 诗词题材分类色（千问 Color10/20/100 启发）
        // 每种题材支持 <alpha-value> 任意透明度，固定 10/20/40 档通过 CSS 变量 var(--genre-{name}-10) 使用
        'genre-landscape': 'rgb(var(--c-genre-landscape) / <alpha-value>)',
        'genre-pastoral': 'rgb(var(--c-genre-pastoral) / <alpha-value>)',
        'genre-frontier': 'rgb(var(--c-genre-frontier) / <alpha-value>)',
        'genre-imagery': 'rgb(var(--c-genre-imagery) / <alpha-value>)',
        'genre-farewell': 'rgb(var(--c-genre-farewell) / <alpha-value>)',
        'genre-nostalgia': 'rgb(var(--c-genre-nostalgia) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans SC', '-apple-system', 'SF Pro Text', 'system-ui', 'sans-serif'],
        display: ['Inter Display', 'Inter', 'Noto Sans SC', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '8px',
        lg: '12px',
        xl: '16px',
      },
    },
  },
  plugins: [],
} satisfies Config
