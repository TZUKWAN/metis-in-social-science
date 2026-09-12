import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './AcademicTheme.css'
import App from './App.tsx'
import OnboardingOverlay from './components/OnboardingOverlay.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* 新手引导（刘总 2026-09）：首次使用且未配置模型连接时全屏弹出。 */}
    <OnboardingOverlay />
  </StrictMode>,
)
