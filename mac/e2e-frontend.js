// Loaded only when mac/scripts/run-e2e.mjs builds the feature-gated test app.
// The guest plugin must initialize before the application entry module so the
// WDIO service can invoke Tauri commands through the embedded WebDriver session.
import '@wdio/tauri-plugin';

const diagnostics = {
  errors: []
};
globalThis.__velloraE2eDiagnostics = diagnostics;

globalThis.addEventListener('error', (event) => {
  diagnostics.errors.push(
    [event.message, event.error?.stack].filter(Boolean).join('\n') || 'Unknown window error'
  );
});
globalThis.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  diagnostics.errors.push(
    [reason?.message, reason?.stack].filter(Boolean).join('\n') || String(reason)
  );
});
