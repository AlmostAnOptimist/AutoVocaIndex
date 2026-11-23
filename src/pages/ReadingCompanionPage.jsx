// src/pages/ReadingCompanionPage.jsx
// The reading companion (decisions RC-D1–RC-D14): a stripped-down Word / Sentence input that stays open beside
// a reader app (Samsung split screen or pop-up view on the tablet), so the
// book keeps most of the screen and nothing reloads between words.
//
// - Its own page (#reading) without the app's sidebar, topbar or tab bar
//   (RC-D2). Fluid layout: it never reads the module-level isMobile, which
//   wouldn't follow a resized pane. No portal modals or toasts: messages are
//   inline. Inputs sit at the top so the on-screen keyboard doesn't hide them.
// - Its own source and section, saved on this device; the first time it
//   starts from AVI's top bar (RC-D5). Next section offers "Mark … done?"
//   (RC-D6).
// - Word: automatic lookup after a 0.8 s pause (or Enter) with three outcomes
//   (RC-D7, wordLookup.js) and an optional def2 (RC-D8, through
//   stageWordInput).
// - Sentence: paste, pills, one-word-at-a-time confirmation (RC-D9, through
//   sentenceStaging.js — the same pipeline as Sentence Input).
// - "This session" list, mirrored to Recent's "Last session" (RC-D12/13).

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { auth } from '../firebase.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { useAVIData } from '../hooks/useAVIData.js';
import { useSentenceCardCascade } from '../hooks/useSentenceCardCascade.js';
import { usePillPointer } from '../hooks/usePillPointer.js';
import { SH, frameBevel, frameBevelFilled } from '../theme/buildStyles.js';
import { cleanStagingText, getSourceSections } from '../utils/aviUtils.js';
import { getSourceStatus, isPassiveMediaExcluded } from '../utils/contentUtils.js';
import { buildLemmaIndex, buildSurfaceMap } from '../utils/lemmaSearchEngine.js';
import { otherReadings } from '../utils/lemmaSuggest.js';
import { stageWordInput } from '../utils/wordStaging.js';
import { DEMO, DEMO_CAPS, DEMO_LIMIT_NOTE, demoCapReached } from '../demo/demoConfig.js';
import { lookupWord, lookupInDictionary, resolvedForStaging, endsMidSyllable } from '../utils/wordLookup.js';
import {
  tokenizeSentence, collectSelectedTerms, stageSelectedTerms,
  fetchTermDefinitions, commitConfirmedTerms, findPickEntry,
} from '../utils/sentenceStaging.js';
import { newSessionId, makeEntry, saveCompanionSession } from '../utils/companionSession.js';

const COMPANION_KEY = 'avi_companion_v1';
const LOOKUP_PAUSE_MS = 800;
const DEF2_REASON = 'Definition 2 updated in the reading companion';

function readSaved() {
  try { return JSON.parse(localStorage.getItem(COMPANION_KEY) || 'null') || {}; } catch { return {}; }
}
function writeSaved(v) {
  try { localStorage.setItem(COMPANION_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

// Sources words can go to: no passive media (the top bar's rule), nothing
// archived. In Progress first, then the rest, each in 가나다 order.
function companionSources(aviSources) {
  const pool = (aviSources || []).filter(s => s && s.title && !isPassiveMediaExcluded(s) && !s.archived);
  const byTitle = (a, b) => a.title.localeCompare(b.title, 'ko');
  const inProgress = pool.filter(s => getSourceStatus(s) === 'In Progress').sort(byTitle);
  const rest = pool.filter(s => getSourceStatus(s) !== 'In Progress').sort(byTitle);
  return { inProgress, rest, all: [...inProgress, ...rest] };
}

// ── Small pieces ──────────────────────────────────────────────
function SvgIcon({ d, size = 18, stroke = 'currentColor', width = 1.7, children }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d ? <path d={d} /> : children}
    </svg>
  );
}
const ICON = {
  open:   <SvgIcon><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></SvgIcon>,
  chev:   <SvgIcon d="M6 9l6 6 6-6" size={16} />,
  next:   <SvgIcon size={15}><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></SvgIcon>,
  back:   <SvgIcon d="M15 6l-6 6 6 6" />,
  check:  <SvgIcon d="M5 12.5l4.5 4.5L19 7.5" size={18} width={1.9} />,
  info:   <SvgIcon size={18}><circle cx="12" cy="12" r="8.5" /><path d="M12 8v5" /><path d="M12 16.2v.1" /></SvgIcon>,
  paste:  <SvgIcon size={15}><rect x="7" y="4" width="10" height="4" rx="1" /><path d="M7 6H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1" /></SvgIcon>,
  search: <SvgIcon size={16}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></SvgIcon>,
  close:  <SvgIcon size={20}><path d="M6 6l12 12" /><path d="M18 6L6 18" /></SvgIcon>,
};

export function ReadingCompanionPage({
  cards, decks, updateCards, updateDecks,
  aviSources, aviSections,
  wordInputs, sentenceInputs, inputsLoaded, settings,
  onAVIInputsChange, onAviSettingsChange,
  onSectionComplete, onOpenAVI, onOpenInSearch,
}) {
  const { C } = useAppTheme();
  const dsh = settings?.dayStartHour ?? 3;
  const uid = auth.currentUser?.uid;
  const { data, updateData, loading } = useAVIData({
    wordInputs, sentenceInputs, settingsData: settings, inputsLoaded,
    onInputsChange: onAVIInputsChange, onAviSettingsChange,
  });
  useSentenceCardCascade({ data, updateData, loading, cards, decks, updateCards, updateDecks, aviSources, settings });

  // ── Inline message (no toasts here) ─────────────────────────
  const [message, setMessage] = useState(null); // { text, tone }
  const notify = useCallback((text, tone = 'info') => setMessage(text ? { text, tone } : null), []);

  // ── Source and section (RC-D5) ──────────────────────────────
  const saved = useMemo(() => readSaved(), []);
  const [source, setSource]   = useState(() => saved.source ?? settings?.aviCurrentSource ?? '');
  const [section, setSection] = useState(() => saved.section ?? settings?.aviCurrentSection ?? '');
  const [mode, setMode]       = useState(() => (saved.mode === 'sentence' ? 'sentence' : 'word'));
  useEffect(() => { writeSaved({ source, section, mode }); }, [source, section, mode]);

  const sourcePool = useMemo(() => companionSources(aviSources), [aviSources]);
  const sourceDoc  = (aviSources || []).find(s => s.title === source) || null;
  // A saved source that no longer exists (renamed, archived) falls back to
  // AVI's top bar once the sources have loaded.
  useEffect(() => {
    if (!(aviSources || []).length || !source) return;
    if (!sourcePool.all.some(s => s.title === source)) {
      const top = settings?.aviCurrentSource || '';
      setSource(sourcePool.all.some(s => s.title === top) ? top : '');
      setSection(sourcePool.all.some(s => s.title === top) ? (settings?.aviCurrentSection || '') : '');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aviSources]);
  const sections = useMemo(
    () => (source ? getSourceSections(aviSources || [], aviSections || [], source) : []),
    [aviSources, aviSections, source],
  );
  const needsSection = sections.length > 0 && !section;
  const sectionIdx   = sections.findIndex(s => s.content === section);
  const nextSection  = sectionIdx >= 0 ? sections[sectionIdx + 1] || null : null;
  const destLabel    = source ? `${source}${section ? ` · §${section}` : ''}` : '';

  const [view, setView] = useState('main'); // 'main' | 'picker' | 'confirm'
  const [donePrompt, setDonePrompt] = useState(null); // { sectionId, sourceId, label }

  const goNextSection = () => {
    if (!nextSection) return;
    const prev = sections[sectionIdx];
    setSection(nextSection.content);
    setDonePrompt(prev && prev.status !== 'Done' && prev.status !== 'Skip'
      ? { sectionId: prev.id, sourceId: sourceDoc?.id || prev.resourceId || null, label: prev.content }
      : null);
  };
  const markDone = async () => {
    const p = donePrompt;
    setDonePrompt(null);
    if (!p || !onSectionComplete) return;
    try {
      await onSectionComplete(p.sectionId, p.sourceId);
      notify(`§${p.label} marked done.`, 'ok');
    } catch {
      notify(`Couldn't mark §${p.label} done. Try again from the Content Library.`, 'warn');
    }
  };

  // ── Session list (RC-D12, RC-D13) ───────────────────────────
  const [session, setSession] = useState(() => ({ sessionId: newSessionId(), startedAt: new Date().toISOString(), entries: [] }));
  const addEntries = useCallback((list) => {
    if (!list.length) return;
    setSession(prev => ({ ...prev, entries: [...list, ...prev.entries] }));
  }, []);
  const sessionStarted = useRef(false);
  useEffect(() => {
    if (!session.entries.length && !sessionStarted.current) return;
    sessionStarted.current = true;
    saveCompanionSession(uid, session).catch(e => console.error('Reading companion: saving the session failed', e));
  }, [session, uid]);

  // ── Shared pieces for the staging pipelines ─────────────────
  const stagingCtx = { data, updateData, showAVIToast: (t) => notify(t, 'warn'), cards, decks, uid, updateCards, updateDecks, aviSources, dsh };
  const index      = useMemo(() => buildLemmaIndex(data.lemmaMaster), [data.lemmaMaster]);
  const surfaceMap = useMemo(() => buildSurfaceMap(data.wordInputs, data.sentenceInputs), [data.wordInputs, data.sentenceInputs]);
  const entryById  = (id) => data.lemmaMaster.find(l => l.lemmaID === id) || null;
  const canAddHere = !!source && !needsSection && !loading;

  // ══ Word mode ══════════════════════════════════════════════
  const [wordText, setWordText]   = useState('');
  const [def2Text, setDef2Text]   = useState('');
  const def2Touched = useRef(false);
  const [lookup, setLookup]       = useState(null);  // { text, state: 'looking' } | { text, state: 'done', result }
  const [chosen, setChosen]       = useState(null);  // entry picked from Did you mean / Not this one
  const [refused, setRefused]     = useState(false); // dictionary chosen over a variant match
  const [showOthers, setShowOthers] = useState(false);
  const [wordBusy, setWordBusy]   = useState(false);
  const wordRef  = useRef(null);
  const lookupSeq = useRef(0);
  const dataRef = useRef(data); dataRef.current = data;
  const indexRef = useRef({ index, surfaceMap }); indexRef.current = { index, surfaceMap };

  const setDef2FromEntry = (entry) => { if (!def2Touched.current) setDef2Text(entry?.def2 || ''); };

  const runLookup = useCallback(async (text) => {
    const seq = ++lookupSeq.current;
    setLookup({ text, state: 'looking' });
    setChosen(null); setRefused(false); setShowOthers(false);
    let result;
    try {
      result = await lookupWord({ surface: text, data: dataRef.current, index: indexRef.current.index, surfaceMap: indexRef.current.surfaceMap });
    } catch (e) {
      console.error('Reading companion: lookup failed', e);
      result = { status: 'error' };
    }
    if (seq !== lookupSeq.current) return;
    setLookup({ text, state: 'done', result });
    // A def2 filled in from an earlier word goes; one typed by hand stays.
    if (result.status === 'match') setDef2FromEntry(result.entry);
    else if (!def2Touched.current) setDef2Text('');
    if (result.status === 'dictionary' && result.rateLimited) notify('API rate limit reached — switch to KRDict mode in Settings.', 'warn');
  }, [notify]);

  // RC-D7: look up 0.8 s after typing stops (not mid-syllable).
  useEffect(() => {
    const text = wordText.trim();
    if (!text || loading) {
      lookupSeq.current++; setLookup(null);
      if (!text && !def2Touched.current) setDef2Text('');
      return;
    }
    if (lookup && lookup.text === text) return;
    if (endsMidSyllable(text)) return;
    const t = setTimeout(() => runLookup(text), LOOKUP_PAUSE_MS);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordText, loading]);

  const result = lookup && lookup.state === 'done' && lookup.text === wordText.trim() ? lookup.result : null;
  const looking = !!lookup && lookup.state === 'looking';
  const shownEntry = chosen || (result?.status === 'match' ? result.entry : null);
  const resolved = resolvedForStaging(result, { chosen, refused });
  // Demo: words arrive through the sentence picker only, as in Word Input (D5).
  const wordReady = !DEMO && !!resolved && !wordBusy && canAddHere;

  const pickChoice = (lemmaID) => {
    const e = entryById(lemmaID);
    if (!e) return;
    setChosen(e); setRefused(false); setShowOthers(false);
    if (!def2Touched.current) setDef2Text(e.def2 || '');
  };
  const askDictionary = async (fromRefusal) => {
    if (!result || !result.cleaned) return;
    const seq = ++lookupSeq.current;
    const text = lookup.text;
    setLookup({ text, state: 'looking' });
    let r;
    try {
      r = await lookupInDictionary({ cleaned: result.cleaned, lemma: result.lemma, fromLocal: result.fromLocal, data: dataRef.current, allowVariant: !fromRefusal });
    } catch (e) {
      console.error('Reading companion: dictionary lookup failed', e);
      r = { status: 'error' };
    }
    if (seq !== lookupSeq.current) return;
    setChosen(null); setShowOthers(false); setRefused(!!fromRefusal);
    setLookup({ text, state: 'done', result: { ...r, fromLocal: result.fromLocal } });
    if (r.status === 'match') setDef2FromEntry(r.entry);
    else if (!def2Touched.current) setDef2Text('');
    if (r.rateLimited) notify('API rate limit reached — switch to KRDict mode in Settings.', 'warn');
  };

  const resetWord = () => {
    lookupSeq.current++;
    setWordText(''); setDef2Text(''); def2Touched.current = false;
    setLookup(null); setChosen(null); setRefused(false); setShowOthers(false);
  };

  const addWord = async () => {
    if (!wordReady) return;
    setWordBusy(true);
    notify(null);
    try {
      const r = await stageWordInput({
        surface: wordText, source, section,
        data, updateData, cards, decks, uid, updateCards, updateDecks, aviSources, dsh,
        showAVIToast: (t) => notify(t, 'warn'),
        resolved, def2: def2Text, def2Reason: DEF2_REASON,
        logPrefix: 'Reading companion',
      });
      if (r.status === 'duplicate') {
        addEntries([makeEntry({ kind: 'word', status: 'duplicate', word: r.row.lemma || r.row.input, rowUid: r.row.uid, source, section })]);
        resetWord();
      } else if (r.status === 'staged') {
        addEntries([makeEntry({
          kind: 'word', status: r.row.skipUpload ? 'skipped' : (r.isNewLemma ? 'new' : 'existing'),
          word: r.row.lemma, rowUid: r.row.uid, source, section, def2Saved: !!def2Text.trim() && (r.isNewLemma || r.def2Changed),
        })]);
        resetWord();
      }
    } catch (e) {
      console.error('Reading companion: adding the word failed', e);
      notify("Couldn't add that word. Try again.", 'warn');
    } finally {
      setWordBusy(false);
      wordRef.current?.focus();
    }
  };

  const onWordKey = (e) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (wordReady) addWord();
    else if (wordText.trim() && !looking) runLookup(wordText.trim());
  };
  const onWordPaste = (e) => {
    const pasted = e.clipboardData?.getData('text');
    if (!pasted) return;
    e.preventDefault();
    setWordText(cleanStagingText(pasted, data.aviSettings?.noiseBlocks || []));
  };

  // ══ Sentence mode ══════════════════════════════════════════
  const [sentText, setSentText]       = useState('');
  const [tokens, setTokens]           = useState([]);
  const [autoSelected, setAutoSelected] = useState(new Set());
  const [skippedToks, setSkippedToks] = useState(new Set()); // LM2: skipped somewhere, so not pre-selected
  const [manual, setManual]           = useState(new Set());
  const [phrase, setPhrase]           = useState(null);
  const [sentBusy, setSentBusy]       = useState(false);
  const [queue, setQueue]             = useState(null); // { terms, index, sentence }
  const [term, setTerm]               = useState(null); // the term being confirmed
  const [termFetching, setTermFetching] = useState(false);
  const termDef2Touched = useRef(false);
  const termSeq = useRef(0);
  const lemmaTimer = useRef(null);

  const setSentence = (text) => {
    setSentText(text);
    setPhrase(null);
    const t = tokenizeSentence(text, data.wordInputs);
    setTokens(t.tokens);
    setAutoSelected(t.autoSelected);
    setSkippedToks(t.skipped);
    setManual(new Set());
  };
  const onSentPaste = (e) => {
    const pasted = e.clipboardData?.getData('text');
    if (!pasted) return;
    e.preventDefault();
    const el = e.target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    setSentence(cleanStagingText(el.value.slice(0, start) + pasted + el.value.slice(end), data.aviSettings?.noiseBlocks || []));
  };
  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setSentence(cleanStagingText(text, data.aviSettings?.noiseBlocks || []));
      else notify('The clipboard is empty.', 'info');
    } catch {
      notify("Couldn't read the clipboard. Long-press the box and paste instead.", 'warn');
    }
  };

  const demoPickFull = () => DEMO && autoSelected.size + manual.size + (phrase ? 1 : 0) >= DEMO_CAPS.wordsPerSentence;
  const demoPickNote = `Demo: up to ${DEMO_CAPS.wordsPerSentence} target words per sentence.`;
  const toggleToken = (idx) => {
    if (autoSelected.has(idx)) {
      setAutoSelected(prev => { const n = new Set(prev); n.delete(idx); return n; });
    } else if (!manual.has(idx) && demoPickFull()) {
      notify(demoPickNote, 'info');
    } else {
      setManual(prev => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; });
    }
  };
  // Same press / drag / release rules as Sentence Input (RC-D11).
  const dragStart = useRef(null);
  const didDrag   = useRef(false);
  const pills = usePillPointer({
    onDown: (idx) => { dragStart.current = idx; didDrag.current = false; },
    onEnter: (idx) => { if (dragStart.current !== null && idx !== dragStart.current) didDrag.current = true; },
    onUp: (idx) => {
      const start = dragStart.current;
      dragStart.current = null;
      if (start === null || idx == null) return;
      if (!didDrag.current) toggleToken(idx);
      else if (!phrase && demoPickFull()) notify(demoPickNote, 'info');
      else {
        const lo = Math.min(start, idx), hi = Math.max(start, idx);
        const indices = [];
        for (let i = lo; i <= hi; i++) indices.push(i);
        setPhrase({ text: indices.map(i => tokens[i].token).join(' '), indices });
      }
      didDrag.current = false;
    },
  });
  const allSelected = new Set([...autoSelected, ...manual]);
  const pickCount = allSelected.size + (phrase ? 1 : 0);

  const loadTerm = async (t) => {
    const seq = ++termSeq.current;
    setTermFetching(true);
    let filled = t;
    try {
      [filled] = await fetchTermDefinitions([t], dataRef.current.lemmaMaster, dataRef.current.aviSettings);
    } catch (e) {
      console.error('Reading companion: definition lookup failed', e);
    }
    if (seq !== termSeq.current) return;
    setTerm(prev => {
      const base = prev && prev.input === t.input ? prev : t;
      return {
        ...base, lemma: filled.lemma, def1: filled.def1 || '',
        def2: termDef2Touched.current ? base.def2 : (filled.def2 || ''),
      };
    });
    setTermFetching(false);
  };
  const startTerm = (t) => {
    clearTimeout(lemmaTimer.current);
    termDef2Touched.current = false;
    setTerm({ ...t, def1: '', def2: '' });
    loadTerm(t);
  };
  // Changing the lemma looks def1 up again after a pause.
  const termRef = useRef(term); termRef.current = term;
  const editTermLemma = (lemma) => {
    setTerm(prev => ({ ...prev, lemma }));
    clearTimeout(lemmaTimer.current);
    if (!lemma.trim()) return;
    lemmaTimer.current = setTimeout(() => {
      if (termRef.current) loadTerm({ ...termRef.current, lemma });
    }, LOOKUP_PAUSE_MS);
  };
  useEffect(() => () => clearTimeout(lemmaTimer.current), []);

  const finishSentence = () => {
    setQueue(null); setTerm(null); setView('main');
    setSentence('');
  };

  const addSelected = async () => {
    if (!canAddHere || !pickCount || sentBusy) return;
    if (DEMO && demoCapReached(data.sentenceInputs, 'sentences')) { notify(DEMO_LIMIT_NOTE, 'warn'); return; }
    setSentBusy(true);
    notify(null);
    try {
      const sentence = sentText.trim();
      const terms = collectSelectedTerms(tokens.map(t => t.token), allSelected, phrase);
      const r = await stageSelectedTerms(stagingCtx, { terms, sentence, source, section });
      addEntries([
        ...r.skippedDupes.map(w => makeEntry({ kind: 'sentence', status: 'duplicate', word: w, source, section })),
        ...r.rows.map(row => makeEntry({ kind: 'sentence', status: row.skipUpload ? 'skipped' : 'existing', word: row.targetWord, rowUid: row.uid, source, section })),
      ].reverse());
      if (r.newTerms.length) {
        setQueue({ terms: r.newTerms, index: 0, sentence });
        setView('confirm');
        startTerm(r.newTerms[0]);
      } else {
        finishSentence();
      }
    } catch (e) {
      console.error('Reading companion: adding the sentence failed', e);
      notify("Couldn't add that sentence. Try again.", 'warn');
    } finally {
      setSentBusy(false);
    }
  };

  const nextTerm = () => {
    const i = queue.index + 1;
    if (i >= queue.terms.length) { finishSentence(); return; }
    setQueue(q => ({ ...q, index: i }));
    startTerm(queue.terms[i]);
  };
  const confirmTerm = () => {
    if (!term || !term.lemma.trim() || !canAddHere) return;
    const t = { ...term, lemma: term.lemma.trim(), def2: (term.def2 || '').trim() };
    const r = commitConfirmedTerms(stagingCtx, {
      terms: [t], sentence: queue.sentence, source, section,
      def2Reason: DEF2_REASON, logPrefix: 'Reading companion',
    });
    const isNew = r.newLemmas.length > 0;
    addEntries([
      ...r.skippedDupes.map(w => makeEntry({ kind: 'sentence', status: 'duplicate', word: w, source, section })),
      ...r.rows.map(row => makeEntry({
        kind: 'sentence', status: row.skipUpload ? 'skipped' : (isNew ? 'new' : 'existing'),
        word: row.targetWord, rowUid: row.uid, source, section, def2Saved: !!t.def2,
      })),
    ].reverse());
    nextTerm();
  };

  // ══ Styles ═════════════════════════════════════════════════
  const label = { fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textS };
  const field = {
    width: '100%', boxSizing: 'border-box', minHeight: '46px', padding: '0 12px',
    background: C.raised, border: `1px solid ${C.borderB}`, color: C.text,
    fontFamily: SH.fk, fontSize: '17px', outline: 'none', borderRadius: 0,
  };
  const area = { ...field, padding: '8px 10px', lineHeight: 1.45, resize: 'none', minHeight: 'auto' };
  const framed = (line = C.borderB) => ({
    border: '5px solid transparent', borderRadius: 0,
    borderImageSource: frameBevel(line), borderImageSlice: 6, borderImageWidth: '6px', borderImageRepeat: 'stretch',
    backgroundClip: 'padding-box',
  });
  const card = {
    border: '6px solid transparent', borderRadius: 0,
    borderImageSource: frameBevelFilled(C.border, C.cardBg || C.surface),
    borderImageSlice: '6 fill', borderImageWidth: '7px', borderImageRepeat: 'stretch',
    background: 'transparent', padding: '8px 8px', display: 'flex', flexDirection: 'column', gap: '10px',
  };
  const ghost = {
    ...framed(), minHeight: '44px', padding: '0 12px', background: 'transparent', color: C.text,
    fontFamily: SH.fb, fontSize: '14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
  };
  const primary = (on) => ({
    minHeight: '50px', width: '100%', padding: '0 16px', cursor: on ? 'pointer' : 'default',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    fontFamily: SH.fp, fontSize: '15px', fontWeight: 700, letterSpacing: '0.06em',
    background: on ? C.accent : 'transparent', color: on ? (C.accentText || '#ffffff') : C.textS,
    border: `1px solid ${on ? C.accent : C.border}`,
    boxShadow: on ? `inset 0 0 0 3px ${C.accent}, inset 0 0 0 4px rgba(255,255,255,0.5)` : 'none',
  });
  const chip = (on) => ({
    minHeight: '40px', padding: '0 12px', cursor: 'pointer', fontFamily: SH.fk, fontSize: '16px',
    background: on ? C.accentSoft : C.surface, color: on ? C.accent : C.text,
    border: `1px solid ${on ? C.accent : C.border}`,
  });
  const sectionTitle = { fontFamily: SH.fp, fontSize: '14px', fontWeight: 700, color: C.textS, letterSpacing: '0.04em' };

  // ══ Render ═════════════════════════════════════════════════
  const header = (
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: '44px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
        <span style={{ fontFamily: SH.fd, fontSize: '21px', color: C.accent, letterSpacing: '-0.5px' }}>AutoVocaIndex</span>
        <span style={{ fontFamily: SH.fp, fontSize: '15px', fontWeight: 700, color: C.textS }}>reading</span>
      </div>
      <button type="button" onClick={onOpenAVI} aria-label="Open full AutoVocaIndex" title="Open full AutoVocaIndex"
        style={{ width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textS }}>
        {ICON.open}
      </button>
    </header>
  );

  const messageLine = message && (
    <div role="status" style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '13px', color: message.tone === 'warn' ? C.warning : message.tone === 'ok' ? C.success : C.textS }}>
      <span style={{ flex: 1 }}>{message.text}</span>
      <button type="button" onClick={() => notify(null)} aria-label="Dismiss" style={{ color: C.textS, padding: '0 4px', minHeight: '24px' }}>{ICON.close}</button>
    </div>
  );

  const sessionList = (
    <section aria-label="This session" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
        <span style={{ ...sectionTitle, whiteSpace: 'nowrap' }}>This session · {session.entries.length}</span>
        <span aria-hidden="true" style={{ flex: 1, height: '1px', background: C.border }} />
      </div>
      {session.entries.length === 0 && (
        <div style={{ fontSize: '13px', color: C.textS, padding: '6px 2px' }}>Words and sentences you add show up here.</div>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {session.entries.map(e => (
          <li key={e.id}>
            <button type="button" onClick={() => onOpenInSearch?.(e.word)} title="Open in AVI Search"
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '12px', minHeight: '44px', padding: '0 4px', borderBottom: `1px solid ${C.border}`, textAlign: 'left', cursor: 'pointer' }}>
              <span style={{ color: e.status === 'duplicate' ? C.textS : C.accent, display: 'flex' }}>{e.status === 'duplicate' ? ICON.info : ICON.check}</span>
              <span style={{ fontFamily: SH.fk, fontSize: '16px', color: C.text, minWidth: '64px' }}>{e.word}</span>
              <span style={{ fontSize: '13px', color: C.textS }}>{e.note}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  // ── Picker view ─────────────────────────────────────────────
  if (view === 'picker') {
    return (
      <SourcePicker
        C={C} pool={sourcePool} aviSources={aviSources} aviSections={aviSections}
        source={source} section={section}
        styles={{ label, field, chip, primary, sectionTitle, framed }}
        onClose={() => setView('main')}
        onUse={(src, sec) => { setSource(src); setSection(sec); setDonePrompt(null); setView('main'); }}
        icons={ICON}
      />
    );
  }

  // ── Confirm view (one new word at a time) ───────────────────
  if (view === 'confirm' && queue && term) {
    const alts = term.isPhrase ? [] : otherReadings(term);
    const existing = findPickEntry(data.lemmaMaster, term.lemma);
    const def2Differs = !!existing?.def2 && !!term.def2 && term.def2.trim() !== existing.def2;
    return (
      <div style={{ height: '100dvh', overflowY: 'auto', background: C.bg, color: C.text, fontFamily: SH.fb }}>
        <div style={{ maxWidth: '640px', margin: '0 auto', padding: '10px 16px calc(20px + env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: '44px' }}>
            <button type="button" onClick={() => { setQueue(null); setTerm(null); setView('main'); setManual(new Set()); setPhrase(null); }}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', minHeight: '44px', color: C.text, fontSize: '14px' }}>
              {ICON.back} Back to sentence
            </button>
            <span style={sectionTitle}>New word {queue.index + 1} of {queue.terms.length}</span>
          </header>
          <p style={{ margin: 0, padding: '10px 12px', background: C.cardBg || C.surface, border: `1px solid ${C.border}`, fontFamily: SH.fk, fontSize: '15px', lineHeight: 1.6, color: C.textS }}>
            {queue.sentence}
          </p>
          {messageLine}
          <div style={card}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={label}>In the text</span>
                <span style={{ fontFamily: SH.fk, fontSize: '17px', minHeight: '44px', display: 'flex', alignItems: 'center' }}>{term.input}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label htmlFor="rc-term-lemma" style={label}>Lemma</label>
                <input id="rc-term-lemma" type="text" value={term.lemma} onChange={e => editTermLemma(e.target.value)} style={{ ...field, minHeight: '44px' }} />
              </div>
            </div>
            {alts.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '12px', color: C.textS }}>Other readings</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {alts.map(a => (
                    <button key={a} type="button" onClick={() => { setTerm(prev => ({ ...prev, lemma: a })); loadTerm({ ...term, lemma: a }); }} style={chip(false)}>{a}</button>
                  ))}
                </div>
              </div>
            )}
            <div aria-hidden="true" style={{ height: '1px', background: C.border }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={label}>Definition 1{existing ? ' · from Lemma Master' : ''}</span>
              <span style={{ whiteSpace: 'pre-wrap', color: termFetching ? C.textS : C.text }}>
                {termFetching ? 'Looking it up…' : (term.def1 || 'No definition found.')}
              </span>
              <span style={{ fontSize: '12px', color: C.textS }}>Changing the lemma looks this up again.</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="rc-term-def2" style={label}>Definition 2</label>
              <textarea id="rc-term-def2" rows={2} placeholder="Add your own definition…" value={term.def2 || ''}
                onChange={e => { termDef2Touched.current = true; setTerm(prev => ({ ...prev, def2: e.target.value })); }}
                style={area} />
              {def2Differs && (
                <span style={{ fontSize: '12px', color: C.textS }}>
                  <span style={{ fontFamily: SH.fk, color: C.text }}>{existing.lemma}</span> already has a different Definition 2. Adding uses yours for this word everywhere: Lemma Master, its rows and its cards.{' '}
                  <button type="button" onClick={() => setTerm(prev => ({ ...prev, def2: existing.def2 }))} style={{ color: C.accent, textDecoration: 'underline', fontSize: '12px' }}>Keep Lemma Master's</button>
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="button" onClick={nextTerm} style={{ ...ghost, minHeight: '50px' }}>Skip this word</button>
            <button type="button" onClick={confirmTerm} disabled={!term.lemma.trim() || termFetching || !canAddHere}
              style={{ ...primary(!!term.lemma.trim() && !termFetching && canAddHere), flex: 1, width: 'auto' }}>
              Add {term.lemma.trim() || 'word'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main view ───────────────────────────────────────────────
  const nextLabel = nextSection ? `§${nextSection.content}` : '';
  const addLabel = !source ? 'Choose a source' : needsSection ? 'Choose a section' : `Add to ${destLabel}`;

  return (
    <div style={{ height: '100dvh', overflowY: 'auto', background: C.bg, color: C.text, fontFamily: SH.fb }}>
      <div style={{ maxWidth: '640px', margin: '0 auto', padding: '10px 16px calc(20px + env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {header}

        {/* Source line (RC-D5) and next section (RC-D6) */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
          <button type="button" onClick={() => setView('picker')} aria-label={source ? `Source: ${destLabel}. Change` : 'Choose a source'}
            style={{ ...framed(), flex: 1, minWidth: 0, minHeight: '50px', padding: '0 12px', background: C.cardBg || C.surface, display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', textAlign: 'left' }}>
            <span style={{ flex: 1, minWidth: 0, fontFamily: SH.fk, fontSize: '15px', color: source ? C.text : C.textS, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {source || 'Choose a source'}
            </span>
            {section && <span style={{ fontFamily: SH.fm, fontSize: '13px', color: C.accent, flexShrink: 0, maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>§{section}</span>}
            {needsSection && <span style={{ fontSize: '12px', color: C.warning, flexShrink: 0 }}>choose a section</span>}
            <span style={{ color: C.textS, display: 'flex', flexShrink: 0 }}>{ICON.chev}</span>
          </button>
          <button type="button" onClick={goNextSection} disabled={!nextSection}
            aria-label={nextSection ? `Next section, ${nextLabel}` : 'No next section'} title={nextSection ? `Next section: ${nextLabel}` : 'No next section'}
            style={{ ...framed(), width: '60px', flexShrink: 0, minHeight: '50px', background: C.cardBg || C.surface, color: nextSection ? C.text : C.textS, opacity: nextSection ? 1 : 0.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '2px', fontFamily: SH.fm, fontSize: '12px', cursor: nextSection ? 'pointer' : 'default' }}>
            {nextLabel && nextLabel.length <= 4 ? nextLabel : null}{ICON.next}
          </button>
        </div>

        {donePrompt && (
          <div role="status" style={{ ...card, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <span style={{ flex: '1 1 160px', fontSize: '14px' }}>Mark <span style={{ fontFamily: SH.fm }}>§{donePrompt.label}</span> done?</span>
            <button type="button" onClick={markDone} style={{ ...ghost, borderImageSource: frameBevel(C.accent), color: C.accent }}>Mark done</button>
            <button type="button" onClick={() => setDonePrompt(null)} style={ghost}>Not now</button>
          </div>
        )}

        {/* Word / Sentence */}
        <div role="tablist" aria-label="Input type" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', border: `1px solid ${C.border}` }}>
          {[['word', 'Word'], ['sentence', 'Sentence']].map(([id, text], i) => (
            <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => { setMode(id); notify(null); }}
              style={{ minHeight: '44px', borderLeft: i ? `1px solid ${C.border}` : 'none', background: mode === id ? C.accentSoft : 'transparent', color: mode === id ? C.accent : C.textS, fontFamily: SH.fp, fontSize: '16px', fontWeight: 700, cursor: 'pointer' }}>
              {text}
            </button>
          ))}
        </div>

        {loading && <div style={{ fontSize: '13px', color: C.textS }}>Loading your words…</div>}
        {messageLine}

        {mode === 'word' ? (
          <>
            {DEMO && (
              <div style={{ fontSize: '13px', color: C.warning, lineHeight: 1.5 }}>
                Word adding is disabled in the demo. Use Sentence and pick target words there; new words arrive through the picker.
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="rc-word" style={label}>Word</label>
              <input id="rc-word" ref={wordRef} type="text" value={wordText} autoComplete="off" autoCorrect="off" spellCheck={false}
                onChange={e => setWordText(e.target.value)} onKeyDown={onWordKey} onPaste={onWordPaste} style={field} />
            </div>

            {looking && <div style={{ fontSize: '13px', color: C.textS }}>Looking it up…</div>}

            {result?.status === 'error' && <div style={{ fontSize: '13px', color: C.warning }}>The lookup didn't go through. Press Enter to try again.</div>}

            {/* Outcome 2: close matches only */}
            {result?.status === 'near' && !chosen && (
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ ...sectionTitle, fontSize: '16px', color: C.text }}>Did you mean</span>
                  <span style={{ fontSize: '12px', color: C.textS }}>not in Lemma Master as typed</span>
                </div>
                <ChoiceList choices={result.choices} entryById={entryById} onPick={pickChoice} C={C} />
                <Divider C={C} />
                <button type="button" onClick={() => askDictionary(false)} style={ghost}>
                  {ICON.search} Look up <span style={{ fontFamily: SH.fk }}>{result.cleaned}</span> in the dictionary
                </button>
                <span style={{ fontSize: '12px', color: C.textS }}>No dictionary call yet, because Lemma Master has close matches.</span>
              </div>
            )}

            {/* Outcome 1 (or a pick): in Lemma Master */}
            {shownEntry && (
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: SH.fk, fontSize: '19px' }}>{shownEntry.lemma}</span>
                  <span style={{ fontFamily: SH.fp, fontSize: '13px', fontWeight: 700, color: C.accent }}>in Lemma Master</span>
                </div>
                {!chosen && result.via === 'variant' && (
                  <span style={{ fontSize: '12px', color: C.textS, marginTop: '-6px' }}>
                    <span style={{ fontFamily: SH.fk }}>{result.cleaned}</span> is one of this entry's forms
                  </span>
                )}
                {chosen && (
                  <span style={{ fontSize: '12px', color: C.textS, marginTop: '-6px' }}>
                    Picked for <span style={{ fontFamily: SH.fk }}>{result?.cleaned}</span>.{' '}
                    <button type="button" onClick={() => { setChosen(null); if (!def2Touched.current) setDef2Text(result?.status === 'match' ? (result.entry.def2 || '') : ''); }}
                      style={{ color: C.accent, textDecoration: 'underline', fontSize: '12px' }}>Change</button>
                  </span>
                )}
                <Def1Block text={shownEntry.def1} label={label} C={C} />
                <Def2Field value={def2Text} onChange={v => { def2Touched.current = true; setDef2Text(v); }}
                  note={shownEntry.def2 && def2Text.trim() && def2Text.trim() !== shownEntry.def2 ? 'Changing it here changes it everywhere: Lemma Master, the word’s rows and its cards.' : null}
                  label={label} area={area} C={C} />
                {!chosen && result.status === 'match' && (
                  <>
                    <button type="button" aria-expanded={showOthers} onClick={() => setShowOthers(v => !v)}
                      style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '6px', minHeight: '40px', color: C.accent, fontSize: '13px' }}>
                      Not this one? Other matches or the dictionary {ICON.chev}
                    </button>
                    {showOthers && (
                      <>
                        {result.choices.length > 0 && <ChoiceList choices={result.choices} entryById={entryById} onPick={pickChoice} C={C} />}
                        <button type="button" onClick={() => askDictionary(true)} style={ghost}>
                          {ICON.search} Look up <span style={{ fontFamily: SH.fk }}>{result.cleaned}</span> in the dictionary
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Outcome 3: from the dictionary */}
            {result?.status === 'dictionary' && !chosen && (
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: SH.fk, fontSize: '19px' }}>{result.lemma}</span>
                  <span style={{ fontFamily: SH.fp, fontSize: '13px', fontWeight: 700, color: C.accent }}>not in Lemma Master</span>
                </div>
                <Def1Block
                  text={result.rateLimited ? '' : result.unreachable ? '' : result.def1}
                  empty={result.rateLimited ? 'The dictionary limit was reached. You can still add the word and fill Definition 1 later.' : result.unreachable ? "The dictionary couldn't be reached. You can still add the word; its Definition 1 can be refreshed later." : 'No definition found.'}
                  title="Definition 1 · from the dictionary" label={label} C={C} />
                <Def2Field value={def2Text} onChange={v => { def2Touched.current = true; setDef2Text(v); }} label={label} area={area} C={C} />
              </div>
            )}

            <button type="button" onClick={addWord} disabled={!wordReady} style={primary(wordReady)}>
              {wordBusy ? 'Adding…' : result?.status === 'near' && !chosen ? 'Choose a match or look it up' : addLabel}
            </button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label htmlFor="rc-sentence" style={label}>Sentence</label>
                <button type="button" onClick={pasteFromClipboard} style={{ ...ghost, minHeight: '38px', fontSize: '13px' }}>{ICON.paste} Paste</button>
              </div>
              <textarea id="rc-sentence" rows={2} value={sentText} onChange={e => setSentence(e.target.value)} onPaste={onSentPaste}
                placeholder="Paste a sentence…" style={area} />
            </div>

            {tokens.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '13px', color: C.textS }}>Tap the words to add. Drag across words for a phrase.</span>
                <div {...pills.containerProps} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', userSelect: 'none', ...pills.containerStyle }}>
                  {tokens.map((t, i) => {
                    const isAuto = autoSelected.has(i);
                    const isManual = manual.has(i);
                    const inPhrase = phrase?.indices.includes(i);
                    const on = isAuto || isManual;
                    const isSkipped = skippedToks.has(i) && !on && !inPhrase;
                    return (
                      <span key={i} role="button" aria-pressed={on} {...pills.pillProps(i)}
                        title={isSkipped ? 'Skipped in Word Input. Tap to pick it anyway.' : undefined}
                        style={{
                          minHeight: '40px', padding: '0 12px', display: 'inline-flex', alignItems: 'center', cursor: 'pointer',
                          fontFamily: SH.fk, fontSize: '16px', opacity: isSkipped ? 0.5 : 1,
                          background: isManual ? C.accent : (isAuto || inPhrase) ? C.accentSoft : C.surface,
                          color: isManual ? (C.accentText || '#ffffff') : (isAuto || inPhrase) ? C.accent : C.text,
                          border: `1px ${(isAuto && !isManual) || isSkipped ? 'dashed' : 'solid'} ${on || inPhrase ? C.accent : C.border}`,
                        }}>
                        {t.token}
                      </span>
                    );
                  })}
                </div>
                {phrase && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: C.textS }}>
                    <span>Phrase: <span style={{ color: C.accent, fontFamily: SH.fk }}>{phrase.text}</span></span>
                    <button type="button" onClick={() => setPhrase(null)} aria-label="Clear the phrase" style={{ color: C.textS, minHeight: '32px' }}>{ICON.close}</button>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: C.textS, flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span aria-hidden="true" style={{ width: '14px', height: '14px', background: C.accent }} />Picked</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span aria-hidden="true" style={{ width: '12px', height: '12px', border: `1px dashed ${C.accent}`, background: C.accentSoft }} />Already in Word Input</span>
                  {skippedToks.size > 0 && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span aria-hidden="true" style={{ width: '12px', height: '12px', border: `1px dashed ${C.border}`, background: C.surface, opacity: 0.5 }} />Skipped</span>
                  )}
                </div>
              </div>
            )}

            <button type="button" onClick={addSelected} disabled={!canAddHere || !pickCount || sentBusy} style={primary(canAddHere && !!pickCount && !sentBusy)}>
              {sentBusy ? 'Adding…' : !canAddHere ? addLabel : !pickCount ? 'Pick the words to add' : `Add ${pickCount} selected${section ? ` · §${section}` : ''}`}
            </button>
          </>
        )}

        {sessionList}
      </div>
    </div>
  );
}

// ── Pieces used by the views ──────────────────────────────────
function Divider({ C }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <span aria-hidden="true" style={{ flex: 1, height: '1px', background: C.border }} />
      <span style={{ fontSize: '12px', color: C.textS }}>or</span>
      <span aria-hidden="true" style={{ flex: 1, height: '1px', background: C.border }} />
    </div>
  );
}

function ChoiceList({ choices, entryById, onPick, C }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {choices.map(c => {
        const e = entryById(c.lemmaID);
        return (
          <button key={c.lemmaID} type="button" onClick={() => onPick(c.lemmaID)}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px', minHeight: '52px', padding: '8px 12px', background: C.bg, border: `1px solid ${C.borderB}`, color: C.text, textAlign: 'left', cursor: 'pointer' }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: SH.fk, fontSize: '17px' }}>{c.lemma}</span>
              <span style={{ fontSize: '12px', color: C.textS }}>{c.why}</span>
            </span>
            {e && (e.def2 || e.def1) && (
              <span style={{ fontSize: '13px', color: C.textS, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{e.def2 || e.def1}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Def1Block({ text, empty = 'No Definition 1 yet.', title = 'Definition 1', label, C }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={label}>{title}</span>
      <span style={{ whiteSpace: 'pre-wrap', color: text ? C.text : C.textS, fontSize: text ? '14px' : '13px', maxHeight: '9em', overflowY: 'auto' }}>{text || empty}</span>
    </div>
  );
}

function Def2Field({ value, onChange, note, label, area, C }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label htmlFor="rc-def2" style={label}>Definition 2</label>
      <textarea id="rc-def2" rows={2} placeholder="Add your own definition… (optional)" value={value}
        onChange={e => onChange(e.target.value)} style={{ ...area, fontFamily: SH.fb, fontSize: '16px' }} />
      {note && <span style={{ fontSize: '12px', color: C.textS }}>{note}</span>}
    </div>
  );
}

// Where words go (RC-D5): In Progress sources first, then a search over the
// rest; the chosen source's sections with their Library statuses.
function SourcePicker({ C, pool, aviSources, aviSections, source, section, styles, onClose, onUse, icons }) {
  const [pending, setPending] = useState(source);
  const [pendingSec, setPendingSec] = useState(section);
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const list = query ? pool.all.filter(s => s.title.toLowerCase().includes(query)) : pool.inProgress;
  const secs = pending ? getSourceSections(aviSources || [], aviSections || [], pending) : [];
  const needsSec = secs.length > 0 && !pendingSec;
  const choose = (title) => {
    if (title === pending) return;
    setPending(title);
    setPendingSec('');
  };
  const statusLabel = (st) => (st === 'Done' ? 'Done' : st === 'Skip' ? 'Skip' : st === 'In Progress' ? 'In Progress' : '');
  const { label, field, primary, sectionTitle } = styles;
  return (
    <div style={{ height: '100dvh', overflowY: 'auto', background: C.bg, color: C.text, fontFamily: SH.fb }}>
      <div style={{ maxWidth: '640px', margin: '0 auto', padding: '10px 16px calc(20px + env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: '44px' }}>
          <span style={{ fontFamily: SH.fd, fontSize: '19px' }}>Where words go</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textS }}>{icons.close}</button>
        </header>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label htmlFor="rc-src-search" style={label}>Find a source</label>
          <input id="rc-src-search" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search all sources…" style={{ ...field, fontFamily: SH.fb, fontSize: '16px' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={sectionTitle}>{query ? 'Sources' : 'In Progress'}</span>
          <div role="radiogroup" aria-label="Source" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {list.length === 0 && (
              <span style={{ fontSize: '13px', color: C.textS }}>{query ? 'No matching sources.' : 'No source is In Progress. Search to find one.'}</span>
            )}
            {list.map(s => {
              const on = s.title === pending;
              return (
                <button key={s.id} type="button" role="radio" aria-checked={on} onClick={() => choose(s.title)}
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: '48px', padding: '0 12px', background: on ? C.accentSoft : (C.cardBg || C.surface), border: `1px solid ${on ? C.accent : C.border}`, color: C.text, textAlign: 'left', cursor: 'pointer' }}>
                  <span style={{ flex: 1, fontFamily: SH.fk, fontSize: '15px' }}>{s.title}</span>
                  {s.series && <span style={{ fontSize: '12px', color: C.textS }}>{s.series}</span>}
                  {on && <span style={{ color: C.accent, display: 'flex' }}>{icons.check}</span>}
                </button>
              );
            })}
          </div>
        </div>
        {pending && secs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={sectionTitle}>Section</span>
            <div role="radiogroup" aria-label="Section" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: '8px' }}>
              {secs.map(s => {
                const on = s.content === pendingSec;
                const st = statusLabel(s.status);
                const finished = s.status === 'Done' || s.status === 'Skip';
                return (
                  <button key={s.id} type="button" role="radio" aria-checked={on} onClick={() => setPendingSec(s.content)}
                    style={{ minHeight: '48px', padding: '4px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1px', background: on ? C.accent : finished ? 'transparent' : (C.cardBg || C.surface), border: `1px solid ${on ? C.accent : C.border}`, color: on ? (C.accentText || '#ffffff') : finished ? C.textS : C.text, fontFamily: SH.fm, fontSize: '13px', cursor: 'pointer', overflow: 'hidden' }}>
                    <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>§{s.content}</span>
                    {st && <span style={{ fontFamily: SH.fb, fontSize: '10px' }}>{st}</span>}
                  </button>
                );
              })}
            </div>
            <span style={{ fontSize: '12px', color: C.textS }}>Statuses come from the Content Library. Passive media sources aren't listed.</span>
          </div>
        )}
        <button type="button" disabled={!pending || needsSec} onClick={() => onUse(pending, secs.length ? pendingSec : '')} style={primary(!!pending && !needsSec)}>
          {!pending ? 'Choose a source' : needsSec ? 'Choose a section' : `Use ${pending}${pendingSec && secs.length ? ` · §${pendingSec}` : ''}`}
        </button>
      </div>
    </div>
  );
}
