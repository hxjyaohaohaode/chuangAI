import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'

/** 核心图标中，全项目只使用 regular / bold（含 active 自动 bold）的集合。 */
const CORE_REGULAR_BOLD_ONLY: Readonly<Record<string, string>> = {
  'arrow-right': 'ArrowRight',
  'arrow-square-out': 'ArrowSquareOut',
  trash: 'Trash',
  x: 'X',
  list: 'List',
  user: 'User',
  'arrows-clockwise': 'ArrowsClockwise',
  scroll: 'Scroll',
  bell: 'Bell',
  check: 'Check',
  'caret-left': 'CaretLeft',
  'caret-right': 'CaretRight',
  'caret-down': 'CaretDown',
  robot: 'Robot',
  graph: 'Graph',
  'pencil-simple-line': 'PencilSimpleLine',
  'circle-notch': 'CircleNotch',
  globe: 'Globe',
  'wifi-slash': 'WifiSlash',
  'x-circle': 'XCircle',
  sidebar: 'SidebarSimple',
  'text-aa': 'TextAa',
  notebook: 'Notebook',
  'shield-check': 'ShieldCheck',
  info: 'Info',
  brain: 'Brain',
  'book-open': 'BookOpen',
  gear: 'Gear',
  'magnifying-glass': 'MagnifyingGlass',
  'check-circle': 'CheckCircle',
  feather: 'Feather',
  'bell-slash': 'BellSlash',
  sparkle: 'Sparkle',
  'warning-circle': 'WarningCircle',
  graduation: 'GraduationCap',
}

function listTsxFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'graphify-out') continue
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...listTsxFiles(absolute))
    else if (entry.name.endsWith('.tsx')) files.push(absolute)
  }
  return files
}

/**
 * Phosphor 单个图标默认携带 regular/bold/duotone/fill/light/thin 六套路径。
 * 产品源码只使用前四种；把从未引用的 light/thin 在打包前机械删除，可在不改变
 * 任何可见状态的前提下降低首屏与业务图标 chunk。限定到官方 defs ESM 文件，避免
 * 误改应用代码；若未来开始使用这两种 weight，构建期检查会明确报错。
 */
function pruneUnusedPhosphorWeights() {
  const unusedWeights = ['light', 'thin'] as const
  return {
    name: 'prune-unused-phosphor-weights',
    enforce: 'pre' as const,
    buildStart() {
      const sourceRoot = path.resolve(__dirname, 'src')
      for (const file of listTsxFiles(sourceRoot)) {
        const source = fs.readFileSync(file, 'utf8')
        if (/weight=["'](?:light|thin)["']/.test(source)) {
          throw new Error(`${path.relative(sourceRoot, file)} 使用了已从产物裁剪的 light/thin 图标字重`)
        }
        for (const match of Array.from(source.matchAll(/<Icon\b[\s\S]*?>/g))) {
          const tag = match[0]
          const name = tag.match(/name=["']([^"']+)["']/)?.[1]
          const weight = tag.match(/weight=["']([^"']+)["']/)?.[1]
          if (name && weight && (weight === 'duotone' || weight === 'fill') && name in CORE_REGULAR_BOLD_ONLY) {
            throw new Error(
              `${path.relative(sourceRoot, file)} 的 ${name} 使用 ${weight}，但该字重已按核心图标预算裁剪`,
            )
          }
        }
      }
    },
    transform(code: string, id: string) {
      const normalizedId = id.replace(/\\/g, '/')
      if (!normalizedId.includes('@phosphor-icons/react/dist/defs/') || !normalizedId.endsWith('.es.js')) {
        return null
      }
      let transformed = code
      const fileName = path.basename(normalizedId, '.es.js')
      const weightsToRemove: readonly string[] = Object.values(CORE_REGULAR_BOLD_ONLY).includes(fileName)
        ? [...unusedWeights, 'duotone', 'fill']
        : unusedWeights
      for (const weight of weightsToRemove) {
        transformed = transformed.replace(
          new RegExp(`\\n  \\[\\n    "${weight}",[\\s\\S]*?\\n  \\],?`, 'g'),
          '',
        )
      }
      return transformed === code ? null : { code: transformed, map: null }
    },
  }
}

const devProxyTarget = process.env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:3001'
const devWsProxyTarget = devProxyTarget.replace(/^http/, 'ws')

// Vite 配置：开发服务器端口 5173，代理 /api 到后端 3001
export default defineConfig({
  plugins: [pruneUnusedPhosphorWeights(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: devProxyTarget,
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: devWsProxyTarget,
        ws: true,
        changeOrigin: true,
      },
      // 后端静态托管的用户上传与生成图片（/uploads/generated/*.png）。
      // 生图接口返回的是 `/uploads/...` 这样的**同源相对路径**，
      // 不代理的话开发态下 5173 会去找自己的 public 目录并 404。
      '/uploads': {
        target: devProxyTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    target: 'es2022',
    // ES2022 目标浏览器原生支持 modulepreload；不再注入旧浏览器 polyfill。
    modulePreload: { polyfill: false },
    // 生产产物默认不携带源码映射，避免部署时暴露完整源码与内部路径。
    // 仅在受控调试构建中显式设置 VITE_BUILD_SOURCEMAP=true。
    sourcemap: process.env.VITE_BUILD_SOURCEMAP === 'true',
    // Vite 的原始体积提示阈值不应替代实际 gzip 预算。可选 3D vendor 的
    // 原始体积约 837KB，但不进入首屏；其压缩后体积由 check-bundle-budget
    // 的独立 240KB 硬门禁约束。这里留出该已审计延迟块的原始体积空间，
    // 避免把每次正确构建都输出为“未处理警告”。
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // vendor 分包策略：将重依赖拆分为独立 chunk，降低首屏 JS 体积
        manualChunks(id) {
          // ⚠️ 顺序敏感：以下两条必须排在所有重型 vendor 规则之前。
          //
          // 背景（v5.1 首屏体积治理）：
          // Rollup 会把「被多个 chunk 共用的模块」上提到某个已有的 manual chunk 里。
          // 此前 Vite 的 preload helper 与 zustand 就被上提进了 three-vendor，
          // 于是入口 chunk 出现 `import{...}from"./three-vendor.js"` ——
          // 仅仅为了拿一个几十字节的 helper，首屏被迫预载 227KB(gzip) 的 Three.js，
          // 页面里所有 React.lazy 的努力全部作废。
          // 将轻运行时统一放入 app-runtime，Rollup 就不会借用重型 chunk 当中转站，
          // 同时减少首屏请求数与多个小 gzip 响应的重复压缩开销。
          if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) {
            return 'app-runtime'
          }
          // 轻量共享运行时（状态管理 + 类名工具），与 React 栈合并为单一首屏运行时
          if (
            id.includes('node_modules/zustand') ||
            id.includes('node_modules/clsx') ||
            id.includes('node_modules/use-sync-external-store')
          ) {
            return 'app-runtime'
          }
          // React 核心栈（react + react-dom + react-router-dom）
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/react-router-dom')) {
            return 'app-runtime'
          }
          // TanStack React Query
          if (id.includes('node_modules/@tanstack/react-query')) {
            return 'query-vendor'
          }
          // D3.js 可视化库（仅 StarMapPage 等页面使用）
          if (id.includes('node_modules/d3/') || id.includes('node_modules/d3-')) {
            return 'd3-vendor'
          }
          // Three.js 3D 库（spec v7：仅朗诵/文化语境页懒加载使用，首屏不加载）
          // 通过 React.lazy + dynamic import 确保首屏不含 Three.js（~600KB）
          // spec v10：合并 @react-three/fiber 和 @react-three/drei 到 three-vendor
          // R3F (~45KB) + drei (~120KB) 与 three 共享 WebGL 上下文，合并分包利于缓存复用
          if (
            id.includes('node_modules/three/') ||
            id.includes('node_modules/@types/three') ||
            id.includes('node_modules/@react-three/fiber') ||
            id.includes('node_modules/@react-three/drei')
          ) {
            return 'three-vendor'
          }
          // GSAP 动画库（spec v7：文字动效类组件使用，~50KB gzip 随首屏加载）
          if (id.includes('node_modules/gsap/') || id.includes('node_modules/gsap-')) {
            return 'gsap-vendor'
          }
          // Phosphor 图标库：按实际引用自动分包
          // 核心图标（Icon.tsx 引用）跟随首屏 chunk
          // 扩展图标（icons-extended.ts 引用）由 Vite 自动提取为独立 chunk，仅懒加载页面按需加载
          // 不再强制合并到单一 icons-vendor，避免 90 个图标全量进入首屏
        },
      },
    },
  },
})
