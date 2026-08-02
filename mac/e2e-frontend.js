// Loaded only when mac/scripts/run-e2e.mjs builds the feature-gated test app.
// The guest plugin must initialize before the application entry module so the
// WDIO service can invoke Tauri commands through the embedded WebDriver session.
import '@wdio/tauri-plugin';
