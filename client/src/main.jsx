import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import AuthGate from './components/AuthGate';

// AuthGate wraps App rather than App wrapping AuthGate internally: App itself does not
// mount (so its own effects, like fetching /api/settings for the sidebar name, don't
// fire and fail with 401) until a valid session exists and the one-time setup guide has
// run. See client/src/components/AuthGate.jsx.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>
);

// Production only: register the PWA service worker so the app can be installed
// and keep a cached shell for offline UI. API calls are never cached by the SW.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
