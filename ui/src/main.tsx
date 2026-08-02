import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Applied synchronously, before the first render -- this app is a
// stage-side remote/mirror of the native (always-dark) desktop app, so it
// always forces dark rather than following system preference. Doing this
// here (not in a useEffect in App) matters: React fires child effects
// before parent effects on mount, so a component that reads HeroUI's
// theme-driven CSS custom properties in its own effect (e.g. the Light
// tab's 3D stage, resolving --background/--default for its grid colors)
// could otherwise run before the "dark" class landed and permanently
// capture the light theme's near-white values.
document.documentElement.classList.add('dark')
document.documentElement.setAttribute('data-theme', 'dark')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
