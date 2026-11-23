// src/components/LazyPage.jsx
// A page or reader that is fetched the first time it is opened instead of
// with the rest of the app (offline decisions OF-D4).
//
//   const QuizzesPage = lazyPage(() => import('./pages/QuizzesPage.jsx'),
//                                m => m.QuizzesPage, { label: 'Loading quizzes…' });
//   <QuizzesPage ...same props as before... />
//
// While the file is on its way, a brief "Loading" shows in the page's place
// (nothing at all for the first moment, so a fast load doesn't flicker).
// Once loaded it is remembered, so later opens are instant.
//
// If the file can't be loaded (offline before the files were saved, or this
// tab is older than the latest deploy), a message with Try again and Reload
// shows instead. This is deliberately NOT React.lazy: a failed React.lazy
// load throws while drawing, and that would land in the start-up error
// screen in main.jsx, whose button clears the data saved on this device.
//
// options.overlay: for the full-screen readers. The message is drawn over
// the whole screen, like the readers themselves, and shows a Close button
// when the reader was given onClose (src/components/ChunkStatus.jsx).
//
// This file never imports a page; the caller passes the import in.

import { useState, useEffect } from 'react';
import { createChunkLoader } from '../utils/chunkLoader.js';
import { ChunkStatus } from './ChunkStatus.jsx';

export function lazyPage(load, pick, { label = 'Loading…', overlay = false } = {}) {
  const loader = createChunkLoader(load, pick);

  function LazyPage(props) {
    const [Loaded, setLoaded] = useState(() => loader.peek());
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
      if (Loaded) return undefined;
      let live = true;
      loader.load().then(
        (got) => { if (live) setLoaded(() => got); },
        (err) => {
          console.error('AVI: a page could not be loaded', err);
          if (live) setFailed(true);
        },
      );
      return () => { live = false; };
    }, [Loaded, attempt]);

    if (Loaded) return <Loaded {...props} />;
    return (
      <ChunkStatus
        failed={failed}
        label={label}
        overlay={overlay}
        onRetry={() => { setFailed(false); setAttempt(n => n + 1); }}
        onClose={props.onClose}
      />
    );
  }
  return LazyPage;
}
