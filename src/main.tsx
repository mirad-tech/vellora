import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './styles.css';
import 'highlight.js/styles/github.css';

// Optional desktop WDIO plugin — only load inside a real Tauri webview.
void import('@wdio/tauri-plugin').catch(() => {
  // Browser-mode E2E / plain Vite does not ship the plugin bridge.
});

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found');
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
