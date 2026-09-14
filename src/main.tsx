import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './AcademicTheme.css'
import App from './App.tsx'
import OnboardingOverlay from './components/OnboardingOverlay.tsx'
import './theme/MetisGlassTokens.css'
import './SkyAgentTheme.css'

// 远程开发桥（dev-only）：浏览器里没有 contextBridge 注入的 window.metis，
// 动态加载 preload 源码（vite 把 'electron' alias 成回环 HTTP+SSE 垫片），
// 于是完整的 METIS API 在普通浏览器中原样可用；生产构建剔除该分支。
if (import.meta.env.DEV && !(window as { metis?: unknown }).metis) {
  await import('../electron/preload.js')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* 新手引导（刘总 2026-09）：首次使用且未配置模型连接时全屏弹出。 */}
    <OnboardingOverlay />
  </StrictMode>,
)
