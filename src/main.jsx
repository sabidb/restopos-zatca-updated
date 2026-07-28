import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { installTrialWorkspace } from './trial.js'

// A trial's storage namespace must be in place BEFORE App.jsx (and therefore
// Firebase) is evaluated, so every localStorage consumer in the app sees the
// same isolated workspace. Static imports are hoisted, so App is pulled in
// dynamically after the swap.
installTrialWorkspace()

import('./App.jsx').then(({ default: App }) => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
