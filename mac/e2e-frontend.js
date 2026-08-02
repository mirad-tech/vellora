// Loaded only when mac/scripts/run-e2e.mjs builds the feature-gated test app.
// The guest plugin must initialize before the application entry module so the
// WDIO service can invoke Tauri commands through the embedded WebDriver session.
import '@wdio/tauri-plugin';

const diagnostics = {
  errors: [],
  initialDocument: null
};
globalThis.__velloraE2eDiagnostics = diagnostics;

globalThis.addEventListener('error', (event) => {
  diagnostics.errors.push(event.error?.stack || event.message || 'Unknown window error');
});
globalThis.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  diagnostics.errors.push(reason?.stack || reason?.message || String(reason));
});

const tauriInternals = globalThis.__TAURI_INTERNALS__;
const originalInvoke = tauriInternals?.invoke;
if (typeof originalInvoke === 'function') {
  tauriInternals.invoke = async (...args) => {
    const [command] = args;
    try {
      const result = await originalInvoke.apply(tauriInternals, args);
      if (command === 'get_initial_document') diagnostics.initialDocument = result;
      return result;
    } catch (error) {
      if (command === 'get_initial_document') {
        diagnostics.initialDocument = { thrown: error?.message || String(error) };
      }
      throw error;
    }
  };
}
