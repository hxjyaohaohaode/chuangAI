import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
// v7 审计修复 P0-B4：CSS @import 改为 JS import（规范 15.1 禁止 CSS @import 阻塞渲染）
// tokens.css 最先加载，提供设计 token；其余全局样式按依赖顺序加载
import './styles/tokens.css'
import './styles/micro-interactions.css'
import './styles/micro-interactions-v5.css'
import './styles/a11y.css'
import './styles/textures.css'
import './components/ui/Switch.css'
import './components/ui/HighlightJs.css'
import './index.css'

// 应用入口：HTML 模板损坏时给出可诊断错误，避免把空值交给 React 内部崩溃。
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('应用启动失败：index.html 缺少 #root 挂载节点')
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
