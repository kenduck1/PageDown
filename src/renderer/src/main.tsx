import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { installGlobalErrorHandlers } from './lib/global-errors'

// Installed before the first render so a failure during startup is reported
// too, not just one that happens after the app is up.
installGlobalErrorHandlers()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outside <App/>, so a crash in ANY screen -- including App's own body --
        is caught. A boundary rendered inside App could not catch App itself. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
