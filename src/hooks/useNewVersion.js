// src/hooks/useNewVersion.js
// True once a newer build of AutoVocaIndex than the one running has been deployed
// (offline decisions OF-D3). Checked when you come back to the app and
// every half hour while it stays on screen, at most once in five minutes.
// App.jsx shows the "new version" banner from this; nothing reloads unless
// you tap Reload. Also asks the service worker to save this build's files
// for offline use once the app has loaded.

import { useEffect, useMemo, useState } from 'react';
import { RUNNING_BUILD, fetchDeployedBuild, createVersionWatch } from '../utils/versionCheck.js';

export function useNewVersion() {
  const [newVersion, setNewVersion] = useState(false);
  const watch = useMemo(() => createVersionWatch({
    running: RUNNING_BUILD,
    fetchDeployed: fetchDeployedBuild,
    onNew: () => setNewVersion(true),
  }), []);

  useEffect(() => {
    if (!RUNNING_BUILD) return undefined;
    const check = () => { if (document.visibilityState === 'visible') watch.check(); };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    const timer = setInterval(check, 30 * 60 * 1000);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      clearInterval(timer);
    };
  }, [watch]);

  // Offline use: once this build is running, have the service worker save
  // its scripts and styles (public/sw.js, "precache").
  useEffect(() => {
    if (!RUNNING_BUILD || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
      .then(reg => reg.active?.postMessage({ type: 'precache', version: RUNNING_BUILD }))
      .catch(() => {});
  }, []);

  return newVersion;
}
