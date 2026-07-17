// src/pages/avi/AVIImportPage.jsx
// Import tab, Stages 9.1-9.3: paste intake and split preview (9.1), then
// lemma resolution, review gate, and commit for word mode (9.2) and
// sentence mode (9.3). Definitions are never fetched here — rows commit
// with defs only when the lemma already exists in lemmaMaster, and fill
// lazily through the normal per-row flow (D9.4). Auto-TTS is Stage 9.4.

import React, { useState, useMemo, useCallback, useRef } from 'react';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { auth } from '../../firebase.js';
import {
  uuid, normalizeLemma, cleanStagingText, getSourceSections,
  resolveLemmaWithDictionary, writeGlobalLemma, fetchDefinition,
} from '../../utils/aviUtils.js';
import { prewarmTtsAudio } from '../../utils/ttsUtils.js';
import { autoCreateWordCard, autoCreateSentenceCard } from '../../utils/cardFactory.js';
import { LemmaAutocompleteInput } from '../../components/avi/LemmaAutocompleteInput.jsx';
import { WordEditModal } from '../../components/avi/WordEditModal.jsx';
import { makeUpdateRow } from '../../utils/wordRowUpdater.js';
import {
  segmentSentences, segmentWords, chunkItems, IMPORT_LIMITS,
  buildImportPlan, buildCommitRows,
  stripSubtitleMarkup, detectUploadKind,
} from '../../utils/importEngine.js';
import { openEpub } from '../../utils/epubUtils.js';
import { ProgressBar } from '../../components/ProgressBar.jsx';

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

const MODES = [
  { id: 'sentence', label: 'Sentence Import', hint: 'Paste an excerpt, article, or dialogue. It will be split into sentences for review.' },
  { id: 'word',     label: 'Word Import',     hint: 'Paste a simple list, one term per line. Terms are cleaned and deduplicated for review.' },
];

const RESOLVE_BATCH = 20;

export function AVIImportPage({
  data, updateData, showAVIToast,
  currentSource, currentSection,
  aviSources, aviSections,
  cards, decks, updateCards, updateDecks,
  settings, dsh,
}) {
  const { C, S } = useAppTheme();
  const uid = auth.currentUser?.uid;

  // step: 'input' -> 'review' -> 'done'
  const [step,      setStep]      = useState('input');
  const [mode,      setMode]      = useState('sentence');
  const [rawText,   setRawText]   = useState('');
  const [parsed,    setParsed]    = useState(null);       // { chunk, remainder }
  const [excluded,  setExcluded]  = useState(new Set());  // sentence/word indices excluded in step 1
  const [review,    setReview]    = useState(null);       // { sentences, newTerms, knownTerms }
  const [knownOpen, setKnownOpen] = useState(false);
  const [resolving, setResolving] = useState(null);       // { done, total } | null
  const [summary,   setSummary]   = useState(null);       // commit result for 'done' step
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const defCancelRef = useRef(false);
  const [defProgress, setDefProgress] = useState(null); // { done, total, stopped } | null
  const ttsCancelRef = useRef(false);
  const [ttsProgress, setTtsProgress] = useState(null); // { done, total, stopped } | null
  const [fillUid, setFillUid] = useState(null);         // Fill-Def2 modal row uid

  // Auto-TTS is a convenience queue — navigating away cancels the
  // remainder (audio stays fetchable on demand). The Def1 queue is data
  // and deliberately survives navigation.
  React.useEffect(() => () => { ttsCancelRef.current = true; }, []);

  // ── File upload (Stages 9.5/9.6) ─────────────────────────────
  const fileInputRef = useRef(null);
  const epubRef = useRef(null);                 // { chapters, extractText }
  const [epubChapters, setEpubChapters] = useState(null); // [{ href, title }] | null
  const [epubSelected, setEpubSelected] = useState(new Set());
  const [fileBusy, setFileBusy] = useState(false);

  const needsSection = getSourceSections(aviSources, aviSections, currentSource).length > 0 && !currentSection;
  const activeMode   = MODES.find(m => m.id === mode) || MODES[0];
  const limits       = isMobile ? IMPORT_LIMITS.mobile : IMPORT_LIMITS.desktop;
  const limit        = mode === 'sentence' ? limits.sentences : limits.words;
  const noun         = mode === 'sentence' ? 'sentence' : 'term';

  const cleanFn = (line) => cleanStagingText(line, data.aviSettings?.noiseBlocks || []);

  // Row updater shared with Word Input — drives the Fill-Def2 modal.
  const updateRowFn = useMemo(() => makeUpdateRow({
    data, updateData, cards, updateCards, decks, updateDecks, aviSources,
    autoCreateWordCard, dsh,
  }), [data, updateData, cards, updateCards, decks, updateDecks, aviSources, dsh]);

  const toggleSkip = useCallback((rowUid, val) => {
    updateData(prev => ({
      ...prev,
      wordInputs: prev.wordInputs.map(w =>
        w.uid === rowUid ? { ...w, skipUpload: val } : w
      ),
    }));
  }, [updateData]);

  // ── Step 1: parse ────────────────────────────────────────────
  const handleParse = () => {
    const items = mode === 'sentence' ? segmentSentences(rawText) : segmentWords(rawText, cleanFn);
    setParsed(chunkItems(items, limit));
    setExcluded(new Set());
  };

  const handleClear = () => {
    defCancelRef.current = true;
    ttsCancelRef.current = true;
    setStep('input'); setParsed(null); setRawText(''); setExcluded(new Set());
    setReview(null); setSummary(null); setResolving(null); setKnownOpen(false);
    setDefProgress(null); setTtsProgress(null);
    epubRef.current = null;
    setEpubChapters(null); setEpubSelected(new Set());
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── File intake: .txt as-is, .srt/.vtt stripped, .epub to the
  // chapter picker. Files are read in memory only — never stored.
  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const kind = detectUploadKind(file.name);
    setFileBusy(true);
    try {
      if (kind === 'epub') {
        const buf = await file.arrayBuffer();
        const epub = await openEpub(buf);
        epubRef.current = epub;
        setEpubChapters(epub.chapters);
        setEpubSelected(new Set());
        setParsed(null); setExcluded(new Set());
      } else if (kind === 'srt' || kind === 'vtt') {
        const text = await file.text();
        setRawText(stripSubtitleMarkup(text, kind));
        epubRef.current = null; setEpubChapters(null);
      } else if (kind === 'txt' || kind === '') {
        setRawText(await file.text());
        epubRef.current = null; setEpubChapters(null);
      } else {
        if (showAVIToast) showAVIToast(`Unsupported file type .${kind} — use .txt, .srt, .vtt, or .epub`);
      }
    } catch (err) {
      console.error('Import file read failed', err);
      if (showAVIToast) showAVIToast('Could not read that file — it may be corrupted or DRM-protected');
    } finally {
      setFileBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const toggleEpubChapter = (href) => {
    setEpubSelected(prev => {
      const next = new Set(prev);
      if (next.has(href)) next.delete(href); else next.add(href);
      return next;
    });
  };

  const handleLoadChapters = async () => {
    if (!epubRef.current || epubSelected.size === 0) return;
    setFileBusy(true);
    try {
      const ordered = epubChapters.filter(c => epubSelected.has(c.href)).map(c => c.href);
      const text = await epubRef.current.extractText(ordered);
      setRawText(text);
      epubRef.current = null;
      setEpubChapters(null); setEpubSelected(new Set());
    } catch (err) {
      console.error('Chapter extraction failed', err);
      if (showAVIToast) showAVIToast('Could not extract those chapters');
    } finally {
      setFileBusy(false);
    }
  };

  const switchMode = (id) => {
    if (id === mode || step !== 'input') return;
    setMode(id); setParsed(null); setExcluded(new Set());
  };

  const toggleExclude = (idx) => {
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  // ── Step 1 -> 2: classify and resolve ────────────────────────
  const handleReview = async () => {
    if (busyRef.current || !parsed) return;
    busyRef.current = true; setBusy(true);
    try {
      const includedItems = parsed.chunk.filter((_, i) => !excluded.has(i));
      const plan = buildImportPlan(mode, includedItems, {
        wordInputs: data.wordInputs || [],
        cleanFn,
        normalizeLemma,
      });
      // Resolve lemmas through the full dictionary cascade, in batches.
      const localHeadwords = new Set();
      for (const l of (data.lemmaMaster || [])) {
        if (l.lemma) localHeadwords.add(l.lemma);
        if (l.cleanedLemma) localHeadwords.add(l.cleanedLemma);
      }
      setResolving({ done: 0, total: plan.newTerms.length });
      for (let i = 0; i < plan.newTerms.length; i += RESOLVE_BATCH) {
        const batch = plan.newTerms.slice(i, i + RESOLVE_BATCH);
        await Promise.all(batch.map(async (t) => {
          const lemma = await resolveLemmaWithDictionary(t.input, { localHeadwords }) || t.input;
          t.lemma = lemma;
          t.resolvedLemma = lemma;
        }));
        setResolving({ done: Math.min(i + RESOLVE_BATCH, plan.newTerms.length), total: plan.newTerms.length });
      }
      // Post-resolution dedupe: classification ran on surfaces, but a new
      // surface whose RESOLVED lemma matches an existing wordInput is the
      // same word (e.g. 놀라 resolving to an already-staged 놀라다) — move
      // it to the skipped-as-known list so no duplicate row or card is
      // committed. Within-chunk collisions collapse to the first term.
      const existingLemmaNorms = new Set(
        (data.wordInputs || []).filter(w => w.lemma).map(w => normalizeLemma(w.lemma))
      );
      const seenResolved = new Set();
      const dedupedNew = [];
      for (const t of plan.newTerms) {
        const nk = normalizeLemma(t.lemma) || t.lemma;
        if (existingLemmaNorms.has(nk) || seenResolved.has(nk)) {
          plan.knownTerms.push({ input: t.input, matchedLemma: t.lemma, sentenceIdxs: t.sentenceIdxs || [] });
          continue;
        }
        seenResolved.add(nk);
        dedupedNew.push(t);
      }
      plan.newTerms = dedupedNew;
      setReview({ sentences: includedItems, newTerms: plan.newTerms, knownTerms: plan.knownTerms });
      setResolving(null);
      setKnownOpen(false);
      setStep('review');
    } finally {
      busyRef.current = false; setBusy(false);
    }
  };

  // ── Review helpers ───────────────────────────────────────────
  const updateTermLemma = (idx, val) => {
    setReview(prev => {
      const newTerms = prev.newTerms.map((t, i) => i === idx ? { ...t, lemma: val } : t);
      return { ...prev, newTerms };
    });
  };
  const toggleTermIncluded = (idx) => {
    setReview(prev => {
      const newTerms = prev.newTerms.map((t, i) => i === idx ? { ...t, included: !t.included } : t);
      return { ...prev, newTerms };
    });
  };

  const includedTerms = useMemo(
    () => (review ? review.newTerms.filter(t => t.included && (t.lemma || t.input).trim()) : []),
    [review]
  );
  const plannedSentenceRows = useMemo(() => {
    if (!review || mode !== 'sentence') return 0;
    const fromNew = includedTerms.reduce((n, t) => n + new Set(t.sentenceIdxs || []).size, 0);
    const fromKnown = data.aviSettings?.importKnownSentences
      ? review.knownTerms.reduce((n, k) => n + new Set(k.sentenceIdxs || []).size, 0)
      : 0;
    return fromNew + fromKnown;
  }, [review, includedTerms, mode, data.aviSettings?.importKnownSentences]);

// ── Post-commit Def1 auto-fetch ──────────────────────────────
  // Best-effort background fill of Def1 for committed rows, one fetch per
  // unique lemma, pausing while the tab is hidden and stopping cleanly at
  // the rate limit (remaining defs fill via the normal per-row refresh).
  const fetchDefsInBackground = async (rows) => {
    const targets = rows.filter(r => !r.def1);
    if (targets.length === 0) return;
    const byLemma = new Map();
    for (const r of targets) {
      const k = normalizeLemma(r.lemma) || r.lemma;
      if (!byLemma.has(k)) byLemma.set(k, { lemma: r.lemma, uids: [] });
      byLemma.get(k).uids.push(r.uid);
    }
    const groups = [...byLemma.values()];
    defCancelRef.current = false;
    setDefProgress({ done: 0, total: groups.length, stopped: false });
    let done = 0;
    for (const g of groups) {
      if (defCancelRef.current) return;
      while (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        if (defCancelRef.current) return;
        await new Promise(res => setTimeout(res, 1500));
      }
      let def1 = '';
      try {
        const result = await fetchDefinition(g.lemma, data.aviSettings);
        if (result === '__RATE_LIMITED__') {
          setDefProgress({ done, total: groups.length, stopped: true });
          if (showAVIToast) showAVIToast('Definition fetch rate-limited — remaining defs fill via per-row refresh');
          return;
        }
        def1 = result || '';
      } catch { def1 = ''; }
      if (def1) {
        const normL = normalizeLemma(g.lemma);
        const uidSet = new Set(g.uids);
        updateData(prev => ({
          ...prev,
          wordInputs: prev.wordInputs.map(w =>
            (uidSet.has(w.uid) && !w.def1) ? { ...w, def1 } : w
          ),
          lemmaMaster: prev.lemmaMaster.map(l =>
            (normalizeLemma(l.lemma) === normL && !l.def1)
              ? { ...l, def1, lastUpdated: new Date().toISOString() }
              : l
          ),
        }));
      }
      done += 1;
      setDefProgress({ done, total: groups.length, stopped: false });
    }
  };

// ── Post-commit auto-TTS pre-warm (Stage 9.4) ────────────────
  // Generates (and GCS-caches) audio for the texts the new sentence cards
  // will need — lemma and sentence per row, deduplicated — at the D9.6
  // pacing of one request per 1.5 seconds, pausing while the tab is
  // hidden. Best-effort: failures skip silently, audio remains on-demand.
  const ttsPrewarmInBackground = async (rows) => {
    const texts = [...new Set(
      rows.flatMap(r => [r.targetWord, r.sentence]).filter(t => t && String(t).trim())
    )];
    if (texts.length === 0) return;
    ttsCancelRef.current = false;
    setTtsProgress({ done: 0, total: texts.length, stopped: false });
    let done = 0;
    for (const text of texts) {
      if (ttsCancelRef.current) { setTtsProgress({ done, total: texts.length, stopped: true }); return; }
      while (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        if (ttsCancelRef.current) { setTtsProgress({ done, total: texts.length, stopped: true }); return; }
        await new Promise(res => setTimeout(res, 1500));
      }
      await prewarmTtsAudio(text);
      done += 1;
      setTtsProgress({ done, total: texts.length, stopped: false });
      if (done < texts.length) await new Promise(res => setTimeout(res, 1500));
    }
  };

  const dismissTts = () => {
    ttsCancelRef.current = true;
    setTtsProgress(null);
  };

  // ── Step 2 -> 3: commit ──────────────────────────────────────
  const handleCommit = () => {
    if (busyRef.current || !review || includedTerms.length === 0) return;
    busyRef.current = true; setBusy(true);
    try {
      const { newWordInputs, newLemmas, newSentenceRows } = buildCommitRows({
        mode,
        terms: includedTerms,
        sentences: review.sentences,
        lemmaMaster: data.lemmaMaster || [],
        source: currentSource,
        section: currentSection,
        uuid,
        normalizeLemma,
        knownTerms: review.knownTerms || [],
        includeKnownSentences: mode === 'sentence' && !!data.aviSettings?.importKnownSentences,
      });

      updateData(prev => ({
        ...prev,
        wordInputs:     [...newWordInputs, ...prev.wordInputs],
        lemmaMaster:    [...newLemmas, ...prev.lemmaMaster],
        ...(mode === 'sentence'
          ? { sentenceInputs: [...newSentenceRows, ...prev.sentenceInputs] }
          : {}),
      }));

      // Review-edited lemmas feed the global lemma map, same as the Word
      // Input edit path (D9.4).
      for (const t of includedTerms) {
        if (t.resolvedLemma && t.lemma && t.lemma !== t.resolvedLemma) {
          writeGlobalLemma(t.input, normalizeLemma(t.lemma));
        }
      }

      // Auto-create cards only where defs already existed in lemmaMaster —
      // the same def2/cardBack conditions as live staging.
      const mergedLM = [...(data.lemmaMaster || []), ...newLemmas];
      for (const wi of newWordInputs) {
        if (wi.def2) {
          autoCreateWordCard({
            entry: wi, lemmaMaster: mergedLM,
            decks, uid, updateCards, updateDecks, aviSources, dsh,
          }).then(() => {
            updateData(prev => ({
              ...prev,
              wordInputs: prev.wordInputs.map(w =>
                w.uid === wi.uid ? { ...w, uploaded: true } : w
              ),
            }));
          }).catch(() => {});
        }
      }
      for (const row of newSentenceRows) {
        if (row.cardBack && !row.skipUpload) {
          autoCreateSentenceCard({
            entry: row, lemmaMaster: mergedLM,
            decks, uid, updateCards, updateDecks, aviSources, dsh,
          }).then(() => {
            updateData(prev => ({
              ...prev,
              sentenceInputs: prev.sentenceInputs.map(s =>
                s.uid === row.uid ? { ...s, uploaded: true } : s
              ),
            }));
          }).catch(e => console.error('Sentence card creation failed', e));
        }
      }

      if (showAVIToast) showAVIToast(`Imported ${newWordInputs.length} term${newWordInputs.length === 1 ? '' : 's'}`);
      setSummary({
        words: newWordInputs.length,
        lemmas: newLemmas.length,
        sentenceRows: newSentenceRows.length,
        skippedKnown: review.knownTerms.length,
        remainder: parsed?.remainder?.length || 0,
        committedUids: newWordInputs.map(w => w.uid),
      });
      setStep('done');
      fetchDefsInBackground(newWordInputs);
      if (
        mode === 'sentence' &&
        newSentenceRows.length > 0 &&
        settings?.ttsEnabled !== false &&
        settings?.autoTtsOnImport === true
      ) {
        ttsPrewarmInBackground(newSentenceRows);
      }
    } finally {
      busyRef.current = false; setBusy(false);
    }
  };

  // ── Continue with the held remainder ─────────────────────────
  const handleContinue = () => {
    if (!parsed || parsed.remainder.length === 0) return;
    setParsed(chunkItems(parsed.remainder, limit));
    setExcluded(new Set());
    setReview(null); setSummary(null); setKnownOpen(false);
    setStep('input');
  };

  // ── Shared bits ──────────────────────────────────────────────
  const sectionLabel = (title) => (
    <div style={{ fontFamily: SH.fd, fontSize: '14px', color: C.text }}>◈ {title}</div>
  );
  const ghostBtn = {
    padding: '7px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 500,
    border: `1px solid ${C.border}`, background: 'transparent', color: C.textM,
    cursor: 'pointer', transition: 'all 0.15s',
  };
  const primaryBtn = (disabled) => ({
    ...S.btnPrimary,
    padding: '9px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
    justifyContent: 'center', opacity: disabled ? 0.5 : 1, transition: 'opacity 0.15s',
  });
  const lemmaInputStyle = {
    width: '100%', padding: '5px 8px', borderRadius: '5px', fontSize: '13px',
    border: `1px solid ${C.border}`, background: C.bg, color: C.text,
    outline: 'none', fontFamily: SH.fk, boxSizing: 'border-box',
  };

  // ════ STEP: DONE ══════════════════════════════════════════════
  if (step === 'done' && summary) {
    const committedSet = new Set(summary.committedUids || []);
    const fillTargets  = (data.wordInputs || []).filter(
      w => committedSet.has(w.uid) && !w.def2 && !w.skipUpload
    );
    return (
      <div style={{ maxWidth: '520px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {sectionLabel('Import complete')}
        <div style={{ fontSize: '13px', color: C.text, lineHeight: 1.7 }}>
          Committed {summary.words} term{summary.words === 1 ? '' : 's'}
          {summary.lemmas > 0 && `, ${summary.lemmas} new lemma${summary.lemmas === 1 ? '' : 's'}`}
          {summary.sentenceRows > 0 && `, and ${summary.sentenceRows} sentence row${summary.sentenceRows === 1 ? '' : 's'}`}.
          {summary.skippedKnown > 0 && ` ${summary.skippedKnown} already-known term${summary.skippedKnown === 1 ? ' was' : 's were'} skipped.`}
          {' '}Definitions fill in through the normal per-row flow in Word Input and Sentences.
        </div>
        {defProgress && (
          <div style={{
            border: `1px solid ${C.border}`, borderRadius: '8px', background: C.bg,
            padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px',
          }}>
            <ProgressBar
              done={defProgress.done}
              total={defProgress.total}
              label={defProgress.stopped
                ? 'Definition fetch paused'
                : defProgress.done < defProgress.total
                  ? 'Fetching definitions'
                  : 'Definitions fetched'}
            />
            {defProgress.stopped && (
              <div style={{ fontSize: '12px', color: C.textM, lineHeight: 1.5 }}>
                Paused by the rate limit — the remaining definitions fill via per-row refresh in Word Input.
              </div>
            )}
          </div>
        )}
        {ttsProgress && (
          <div style={{
            border: `1px solid ${C.border}`, borderRadius: '8px', background: C.bg,
            padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px',
          }}>
            <ProgressBar
              done={ttsProgress.done}
              total={ttsProgress.total}
              label={ttsProgress.stopped
                ? 'Audio generation stopped'
                : ttsProgress.done < ttsProgress.total
                  ? 'Generating audio'
                  : 'Audio cached'}
            />
            {(ttsProgress.stopped || (!ttsProgress.stopped && ttsProgress.done < ttsProgress.total)) && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                <span style={{ fontSize: '12px', color: C.textM, lineHeight: 1.5 }}>
                  {ttsProgress.stopped
                    ? 'Remaining audio generates on demand.'
                    : 'Audio caches in the background — you can keep working.'}
                </span>
                {!ttsProgress.stopped && ttsProgress.done < ttsProgress.total && (
                  <button
                    onClick={dismissTts}
                    style={{
                      background: 'none', border: `1px solid ${C.border}`, borderRadius: '4px',
                      color: C.textM, fontSize: '11px', padding: '2px 8px', cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {fillTargets.length > 0 && (
            <button style={primaryBtn(false)} onClick={() => setFillUid(fillTargets[0].uid)}>
              Fill Def2 ({fillTargets.length} row{fillTargets.length === 1 ? '' : 's'})
            </button>
          )}
          {summary.remainder > 0 && (
            <button style={primaryBtn(false)} onClick={handleContinue}>
              Continue import ({summary.remainder} {noun}{summary.remainder === 1 ? '' : 's'} held)
            </button>
          )}
          <button style={ghostBtn} onClick={handleClear}>Start a new import</button>
        </div>

        {fillUid && (
          <WordEditModal
            key={fillUid}
            rows={fillTargets}
            uid={fillUid}
            onSelectRow={setFillUid}
            updateRow={updateRowFn}
            toggleSkip={toggleSkip}
            lemmaMaster={data.lemmaMaster}
            onClose={() => setFillUid(null)}
          />
        )}
      </div>
    );
  }

  // ════ STEP: REVIEW ════════════════════════════════════════════
  if (step === 'review' && review) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', height: isMobile ? 'auto' : '100%', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
          {sectionLabel('Review import')}
          <div style={{ fontSize: '12px', color: C.textM, fontFamily: SH.fm }}>
            {includedTerms.length} of {review.newTerms.length} new terms included
            {mode === 'sentence' && ` · ${plannedSentenceRows} sentence row${plannedSentenceRows === 1 ? '' : 's'} will be created`}
          </div>
        </div>

        <div style={{ fontSize: '12px', color: C.textM, lineHeight: 1.5 }}>
          Lemmas below came from the dictionary cascade. Edit any that are wrong — corrections feed the global lemma map. Nothing is written until Commit.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {review.newTerms.map((t, idx) => (
            <div key={idx} style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '7px 10px', borderRadius: '6px',
              border: `1px solid ${t.included ? C.accent : C.border}`,
              opacity: t.included ? 1 : 0.45, transition: 'all 0.15s', background: C.bg,
            }}>
              <button
                onClick={() => toggleTermIncluded(idx)}
                style={{
                  flexShrink: 0, width: '18px', height: '18px', borderRadius: '4px',
                  border: `1px solid ${t.included ? C.accent : C.border}`,
                  background: t.included ? C.accent : 'transparent',
                  cursor: 'pointer', padding: 0,
                }}
                aria-label={t.included ? 'Exclude term' : 'Include term'}
              />
              <span style={{ fontFamily: SH.fk, fontSize: '13px', color: C.textM, minWidth: isMobile ? '80px' : '130px', wordBreak: 'break-word' }}>
                {t.input}
              </span>
              <div style={{ flex: 1 }}>
                <LemmaAutocompleteInput
                  value={t.lemma}
                  onChange={val => updateTermLemma(idx, val)}
                  lemmaMaster={data.lemmaMaster || []}
                  inputStyle={lemmaInputStyle}
                  lang="ko"
                  disabled={!t.included}
                  C={C}
                />
              </div>
              {mode === 'sentence' && (
                <span style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm, flexShrink: 0 }}>
                  {new Set(t.sentenceIdxs || []).size}s
                </span>
              )}
            </div>
          ))}
          {review.newTerms.length === 0 && (
            <div style={{ fontSize: '13px', color: C.textM, padding: '10px 2px' }}>
              Everything in this chunk is already known — nothing new to import.
            </div>
          )}
        </div>

        {review.knownTerms.length > 0 && (
          <div>
            <button style={ghostBtn} onClick={() => setKnownOpen(o => !o)}>
              {knownOpen ? 'Hide' : 'Show'} {review.knownTerms.length} already-known term{review.knownTerms.length === 1 ? '' : 's'} (skipped)
            </button>
            {knownOpen && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', paddingTop: '8px' }}>
                {review.knownTerms.map((k, i) => (
                  <span key={i} style={{
                    fontSize: '12px', fontFamily: SH.fk, color: C.textM,
                    border: `1px solid ${C.border}`, borderRadius: '5px', padding: '3px 8px',
                  }}>
                    {k.input}{k.matchedLemma !== k.input ? ` → ${k.matchedLemma}` : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', paddingTop: '4px', paddingBottom: '18px' }}>
          <button
            style={primaryBtn(busy || includedTerms.length === 0)}
            disabled={busy || includedTerms.length === 0}
            onClick={handleCommit}
          >
            Commit {includedTerms.length} term{includedTerms.length === 1 ? '' : 's'}
          </button>
          <button style={ghostBtn} onClick={() => setStep('input')}>Back</button>
        </div>
      </div>
    );
  }

  // ════ STEP: INPUT (intake + split preview) ════════════════════
  return (
    <div className="avi-input-layout" style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '16px', height: isMobile ? 'auto' : '100%' }}>

      {/* ── Intake panel ───────────────────────────────────── */}
      <div className="avi-staging-panel" style={{
        width: isMobile ? '100%' : '280px', flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: '10px',
        overflowY: 'auto',
      }}>
        {sectionLabel('Import')}

        <div style={{ display: 'flex', gap: '6px' }}>
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => switchMode(m.id)}
              style={{
                flex: 1, padding: '7px 6px', borderRadius: '6px', fontSize: '12px',
                fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                border: `1px solid ${mode === m.id ? C.accent : C.border}`,
                background: mode === m.id ? C.accent : 'transparent',
                color: mode === m.id ? '#fff' : C.textM,
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div style={{ fontSize: '12px', color: C.textM, lineHeight: 1.5 }}>
          {activeMode.hint} Each run takes up to {limit} {noun}s and anything beyond that is held for a follow-up run.
        </div>

        <textarea
          style={{
            width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '13px',
            border: `1px solid ${C.border}`, background: C.bg, color: C.text,
            outline: 'none', resize: 'vertical', minHeight: '160px', lineHeight: 1.6,
            fontFamily: SH.fk, boxSizing: 'border-box',
          }}
          placeholder={mode === 'sentence' ? 'Paste text here…' : 'Paste terms here, one per line…'}
          value={rawText}
          onChange={e => setRawText(e.target.value)}
          rows={8}
        />

        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.srt,.vtt,.epub"
          onChange={handleFile}
          style={{ display: 'none' }}
        />
        <button
          style={{
            padding: '7px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 500,
            border: `1px solid ${C.border}`, background: 'transparent', color: C.textM,
            cursor: 'pointer', transition: 'all 0.15s', opacity: fileBusy ? 0.5 : 1,
          }}
          disabled={fileBusy}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
        >
          {fileBusy ? 'Reading file…' : 'Upload a file (.txt, .srt, .vtt, .epub)'}
        </button>

        {mode === 'sentence' && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '7px', fontSize: '12px', color: C.textM, cursor: 'pointer', lineHeight: 1.4 }}>
            <input
              type="checkbox"
              checked={!!data.aviSettings?.importKnownSentences}
              onChange={e => {
                const v = e.target.checked;
                updateData(prev => ({
                  ...prev,
                  aviSettings: { ...prev.aviSettings, importKnownSentences: v },
                }));
              }}
              style={{ accentColor: C.accent, cursor: 'pointer', marginTop: '1px' }}
            />
            Create sentence rows for already-known terms
          </label>
        )}

        {!currentSource && (
          <div style={{ fontSize: '11px', color: C.warning, fontWeight: 500 }}>
            ← Select a source in the top bar before importing.
          </div>
        )}
        {currentSource && needsSection && (
          <div style={{ fontSize: '11px', color: C.warning, fontWeight: 500 }}>
            ← This source has sections — pick one in the top bar before importing.
          </div>
        )}

        <button
          style={primaryBtn(!rawText.trim() || !currentSource || needsSection)}
          disabled={!rawText.trim() || !currentSource || needsSection}
          onClick={handleParse}
        >
          Preview split
        </button>

        {parsed && (
          <button style={ghostBtn} onClick={handleClear}>Clear</button>
        )}
      </div>

      {/* ── Preview panel ──────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto' }}>
        {epubChapters ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
              {sectionLabel('Choose chapters')}
              <div style={{ fontSize: '12px', color: C.textM, fontFamily: SH.fm }}>
                {epubSelected.size} of {epubChapters.length} selected
              </div>
            </div>
            <div style={{ fontSize: '12px', color: C.textM, lineHeight: 1.5 }}>
              The book is read in memory only — nothing is stored. Selected chapters load into the paste area in reading order; long chapters flow into the normal chunked runs.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {epubChapters.map((ch) => {
                const on = epubSelected.has(ch.href);
                return (
                  <div
                    key={ch.href}
                    onClick={() => toggleEpubChapter(ch.href)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '10px',
                      padding: '8px 10px', borderRadius: '6px', cursor: 'pointer',
                      border: `1px solid ${on ? C.accent : C.border}`,
                      opacity: on ? 1 : 0.7, transition: 'all 0.15s', background: C.bg,
                    }}
                  >
                    <span style={{
                      flexShrink: 0, width: '16px', height: '16px', borderRadius: '4px',
                      border: `1px solid ${on ? C.accent : C.border}`,
                      background: on ? C.accent : 'transparent',
                    }} />
                    <span style={{ fontSize: '13px', color: C.text, fontFamily: SH.fk, wordBreak: 'break-word' }}>
                      {ch.title}
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '8px', paddingBottom: '18px' }}>
              <button
                style={primaryBtn(fileBusy || epubSelected.size === 0)}
                disabled={fileBusy || epubSelected.size === 0}
                onClick={handleLoadChapters}
              >
                {fileBusy ? 'Extracting…' : `Load ${epubSelected.size} chapter${epubSelected.size === 1 ? '' : 's'}`}
              </button>
              <button style={ghostBtn} onClick={() => { epubRef.current = null; setEpubChapters(null); setEpubSelected(new Set()); }}>
                Cancel
              </button>
            </div>
          </>
        ) : !parsed ? (
          <div style={{ fontSize: '13px', color: C.textM, padding: '18px 4px', lineHeight: 1.6 }}>
            The split preview will appear here. Nothing is saved until you review and commit.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
              {sectionLabel('Split preview')}
              <div style={{ fontSize: '12px', color: C.textM, fontFamily: SH.fm }}>
                {parsed.chunk.length - excluded.size} of {parsed.chunk.length} {noun}{parsed.chunk.length === 1 ? '' : 's'} included
                {parsed.remainder.length > 0 && ` · ${parsed.remainder.length} held for the next run`}
              </div>
            </div>

            <div style={{ fontSize: '12px', color: C.textM, lineHeight: 1.5 }}>
              Tap a row to exclude it from this import. Excluded rows are skipped entirely.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {parsed.chunk.map((item, idx) => {
                const off = excluded.has(idx);
                return (
                  <div
                    key={idx}
                    onClick={() => toggleExclude(idx)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: '10px',
                      padding: '8px 10px', borderRadius: '6px', cursor: 'pointer',
                      border: `1px solid ${off ? C.border : C.accent}`,
                      opacity: off ? 0.45 : 1, transition: 'all 0.15s',
                      background: C.bg,
                    }}
                  >
                    <span style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm, minWidth: '26px', paddingTop: '2px' }}>
                      {idx + 1}
                    </span>
                    <span style={{
                      fontSize: '13px', color: C.text, fontFamily: SH.fk, lineHeight: 1.6,
                      textDecoration: off ? 'line-through' : 'none', wordBreak: 'break-word',
                    }}>
                      {item}
                    </span>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', paddingBottom: '18px', flexWrap: 'wrap' }}>
              <button
                style={primaryBtn(busy || parsed.chunk.length - excluded.size === 0)}
                disabled={busy || parsed.chunk.length - excluded.size === 0}
                onClick={handleReview}
              >
                {resolving ? 'Resolving…' : 'Review terms'}
              </button>
              {resolving && (
                <div style={{ flex: 1, minWidth: '150px', maxWidth: '280px' }}>
                  <ProgressBar done={resolving.done} total={resolving.total} label="Resolving lemmas" />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}