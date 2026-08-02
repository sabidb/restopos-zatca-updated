import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { installTrialWorkspace } from './trial.js'
import { applyBizTheme } from './lib/theme.js'
import { bizTheme } from './businessTypes/index.js'

// A trial's storage namespace must be in place BEFORE App.jsx (and therefore
// Firebase) is evaluated, so every localStorage consumer in the app sees the
// same isolated workspace. Static imports are hoisted, so App is pulled in
// dynamically after the swap.
installTrialWorkspace()

// Paint the shared palette in the active business type's colours before the
// app renders. Reads the saved license (now in the correct trial namespace),
// so a pharmacy boots teal, a salon purple, etc. Colour-only; no layout/logic.
// A type change takes effect on the next load, which the type switch triggers.
applyBizTheme(bizTheme())

import('./App.jsx').then(({ default: App }) => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
