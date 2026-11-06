import { i18nReady } from '@/lib/i18n.ts'
import { migrateLegacyStorage } from '@/lib/legacy-storage.ts'
import '@/lib/toast-safety.ts'
import ErrorBoundary from '@/components/common/error-boundary.tsx'
import { registerSW } from 'virtual:pwa-register'

registerSW({ immediate: true })

// Browser state written under the old brand is copied to the new names before
// anything reads it: i18n has no storage reads at module scope, and PosStore /
// jotai only load through the dynamic app import below.
await migrateLegacyStorage()

await i18nReady

const { default: App } = await import('./app.tsx')
import ReactDOM from 'react-dom/client'

// StrictMode double-mounts effects and can tear down the Surreal WS while React
// state still reports connected (especially with the auth gateway relay).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
