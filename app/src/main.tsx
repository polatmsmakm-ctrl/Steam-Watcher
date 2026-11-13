import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { session } from './session.ts';
import { useApp } from './store.ts';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Read-only handle used by the end-to-end tests to read measured statistics.
(window as unknown as Record<string, unknown>).__visionStream = {
  latest: () => useApp.getState().latest,
  remote: () => useApp.getState().remote.map((r) => ({ source: r.source, kind: r.kind, state: r.track.readyState })),
  room: () => useApp.getState().room?.info ?? null,
  samples: () => session.recording.length,
};
