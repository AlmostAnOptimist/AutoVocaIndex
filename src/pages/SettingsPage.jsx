// src/pages/SettingsPage.jsx
// ST1: one tab per page, grouped by sidebar section (settingsLayout.js). A
// setting more than one page uses appears on each of those tabs; every copy
// edits the same value. Each setting's control is defined once below, by id,
// and rendered wherever the layout lists it (and in settings search).

import { useState, useMemo, useRef, useEffect } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { CATEGORIES, SOUND_OPTIONS, THEME_DEFS, APPOINTMENT_TYPES } from '../constants.js';
import { playSound } from '../utils/soundEngine.js';
import { SH } from '../theme/buildStyles.js';
import { backfillCardAudio, cardNeedsAudio } from '../utils/ttsUtils.js';
import { DEMO } from '../demo/demoConfig.js';
import { isSubmitEnter } from '../utils/keyUtils.js';
import { getLogicalDateStr } from '../utils/dateUtils.js';
import {
  SETTINGS_TABS, DEFAULT_SETTINGS_TAB, sectionOfTab, searchSettings,
} from '../utils/settingsLayout.js';
import {
  SettingsHeader, SettingsTabBar, PanelHead, PanelEnd, SettingsGroup, SettingRow, SubLabel, chipStyle, isMobile,
} from '../components/settings/SettingsKit.jsx';

// ── Built-in stopwords (always active in AVI Search) ─────────
const BUILT_IN_STOPWORDS = [
  'a','about','am','an','and','are','as','at','be','been','being','but','by',
  'come','did','do','does','done','etc','for','from','had','has','have','he',
  'her','him','his','i','if','in','into','is','it','its','make','me','my','of',
  'on','or','our','over','people','person','sb','she','someone','something',
  'sth','than','that','the','their','them','then','these','they','thing','this',
  'those','to','under','up','was','we','were','with','you','your',
].sort();

// ── Dictionary mode options ───────────────────────────────────
const DICT_MODES = [
  { id: 'krdict',    label: 'KRDict (En)',  desc: 'Korean–English dictionary via the official KRDict API' },
  { id: 'krdict-ko', label: 'KRDict (Ko)',  desc: 'Korean–Korean dictionary via the official KRDict API' },
  { id: 'krdict-bi', label: 'KRDict (Bi)',  desc: 'Fetches both English and Korean definitions combined' },
  { id: 'api',       label: 'Claude API',   desc: 'AI-generated definitions via Anthropic Claude' },
];

// ── Tab memory (device-only convenience) ─────────────────────
const TAB_KEY = 'avi_settings_tab';
const readSavedTab = () => {
  try { const t = localStorage.getItem(TAB_KEY); return SETTINGS_TABS[t] ? t : DEFAULT_SETTINGS_TAB; }
  catch { return DEFAULT_SETTINGS_TAB; }
};
const FIRST_TAB = { general: 'general', agenda: 'agenda', language: 'content' };

export function SettingsPage({ settings, onUpdate, soundProfile, setSoundProfile, quizSoundsEnabled, setQuizSoundsEnabled, cards, uid, user, syncStatus, onSignOut, onOpenTheme }) {
  const { C, S, theme } = useAppTheme();
  const [backfill,      setBackfill]      = useState(null); // null | { running, done, total }
  const backfillAbort = useRef(null);

  // N7: the backfill's own rule, so the count matches what it will generate.
  const missingAudioCount = useMemo(() => {
    if (!cards) return null;
    return cards.filter(cardNeedsAudio).length;
  }, [cards]);

  const handleBackfill = async () => {
    if (backfill?.running) {
      backfillAbort.current?.abort();
      return;
    }
    if (!cards || !uid) return;
    const controller = new AbortController();
    backfillAbort.current = controller;
    setBackfill({ running: true, done: 0, total: 0 });
    await backfillCardAudio({
      cards, uid,
      onProgress: (done, total) => setBackfill({ running: true, done, total }),
      signal: controller.signal,
    });
    setBackfill(prev => prev ? { ...prev, running: false } : null);
  };
  const [newApptInputs, setNewApptInputs] = useState({ lang: '' });

  const normalizedCustomTypes = useMemo(() => {
    const raw = settings.customApptTypes;
    if (!raw) return { lang: [] };
    if (Array.isArray(raw)) {
      // Migrate flat array: everything defaults to lang
      return { lang: [...raw] };
    }
    return { lang: [], ...raw };
  }, [settings.customApptTypes]);

  // ── Noise blocks: convert array ↔ textarea string ─────────
  const [noiseText, setNoiseText] = useState(() =>
    (settings.aviNoiseBlocks || []).join('\n---\n')
  );

  const saveNoiseBlocks = (raw) => {
    setNoiseText(raw);
    const blocks = raw.split(/\n---\n/).map(b => b.trim()).filter(Boolean);
    onUpdate({ ...settings, aviNoiseBlocks: blocks });
  };

  // ── Custom stopwords: parse from stored string ────────────
  const customStopwords = useMemo(
    () => (settings.aviStopwordProfile || '').split(/[\n,]+/).map(w => w.trim()).filter(Boolean),
    [settings.aviStopwordProfile]
  );
  const [showBuiltInStops, setShowBuiltInStops] = useState(false);

  const removeStopword = (word) => {
    const updated = customStopwords.filter(w => w !== word).join(', ');
    onUpdate({ ...settings, aviStopwordProfile: updated });
  };

  const dictMode = DEMO ? 'krdict' : (settings.aviDictMode || 'krdict');
  const apiRateLimit = settings.aviApiRateLimit ?? 5;
  const lemmaSortOrder = settings.aviLemmaSortOrder || 'recent';
  const overviewStatVis = settings.aviOverviewStatVis || { words: true, sentences: true };
  const showSourceless = settings.aviShowSourcelessInOverview !== false;
  const fsrs = settings.fsrs || {};
  const onUpdateFSRS = (patch) => {
     onUpdate({ ...settings, fsrs: { ...fsrs, ...patch } });
   };

  // ── Tabs, search, jumps between copies of a shared setting ───
  const [tab, setTabState] = useState(readSavedTab);
  const lastTab = useRef({ ...FIRST_TAB, [sectionOfTab(tab)]: tab });
  const [query, setQuery] = useState('');
  const [jump, setJump] = useState(null);        // { id, n }
  const [flashId, setFlashId] = useState(null);
  const setTab = (t) => {
    setTabState(t);
    lastTab.current[sectionOfTab(t)] = t;
    try { localStorage.setItem(TAB_KEY, t); } catch { /* storage unavailable: the tab just isn't remembered */ }
  };
  const onSection = (sec) => { setQuery(''); setTab(lastTab.current[sec] || FIRST_TAB[sec]); };
  const onTab = (t) => { setQuery(''); setTab(t); };
  const onJump = (t, id) => { setQuery(''); setTab(t); setJump(j => ({ id, n: (j?.n || 0) + 1 })); };
  useEffect(() => {
    if (!jump) return;
    const el = document.getElementById(`setting-${jump.id}`);
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    setFlashId(jump.id);
    const t = setTimeout(() => setFlashId(null), 1700);
    return () => clearTimeout(t);
  }, [jump]);

  // ── Shared control pieces ─────────────────────────────────────
  const checkbox = { width: '16px', height: '16px', accentColor: C.accent, cursor: 'pointer', margin: 0 };
  const checkRow = { display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontSize: '13px', color: C.text };
  const numInput = (w = '84px') => ({ ...S.formInput, width: w, fontFamily: SH.fm });
  const selectInline = { ...S.formSelect, width: 'auto', maxWidth: '100%', paddingRight: '30px' };
  const smallInput = { ...S.formInput, flex: 1, minWidth: 0, padding: '6px 10px', fontSize: '12px' };
  const smallBtn = { ...S.btnGhost, padding: '6px 12px', fontSize: '12px', flexShrink: 0 };
  const removeX = (color) => ({ background: 'none', border: 'none', cursor: 'pointer', color, fontSize: '13px', lineHeight: 1, padding: '0 0 1px 2px' });
  const addLine = (value, setValue, onAdd, placeholder) => (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
      <input type="text" placeholder={placeholder} value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (isSubmitEnter(e)) onAdd(); }} style={smallInput} />
      <button onClick={onAdd} style={smallBtn} className="btn-ghost">Add</button>
    </div>
  );
  const rangeRow = (input, shown) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '240px', maxWidth: '100%' }}>
      {input}
      <span style={{ fontFamily: SH.fm, fontSize: '14px', fontWeight: 600, color: C.accent, minWidth: '46px', textAlign: 'right' }}>{shown}</span>
    </div>
  );
  const ttsOn = settings.ttsEnabled !== false;

  // ── One control per setting id ────────────────────────────────
  // Each returns { ctl, block?, note? }; note = { text, error? }.
  const controls = {
    account: () => ({
      ctl: (
        <>
          <div style={{ minWidth: 0, textAlign: isMobile ? 'left' : 'right' }}>
            <div style={{ fontSize: '13px', color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email || 'Not signed in'}</div>
            <div style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm, marginTop: '2px' }}>
              {syncStatus === 'ok' ? 'Synced' : syncStatus === 'syncing' ? 'Syncing…' : syncStatus === 'error' ? 'Sync error' : 'Local only'}
            </div>
          </div>
          {user && <button onClick={onSignOut} style={{ ...S.btnGhost, flexShrink: 0 }} className="btn-ghost">Sign out</button>}
        </>
      ),
    }),

    dayFlip: () => {
      const h = settings.dayStartHour ?? 3;
      return {
        ctl: (
          <select aria-label="Day-flip time" style={selectInline} value={h} onChange={e => onUpdate({ ...settings, dayStartHour: Number(e.target.value) })}>
            {[0,1,2,3,4,5,6].map(x => <option key={x} value={x}>{x === 0 ? 'Midnight (12:00 AM)' : `${x}:00 AM`}</option>)}
          </select>
        ),
        note: { text: `Currently flips at ${h === 0 ? 'midnight' : `${h}:00 AM`}` },
      };
    },

    theme: () => {
      const def = THEME_DEFS.find(t => t.id === theme);
      return {
        ctl: (
          <>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: C.text }}>
              {def && (
                <span aria-hidden="true" style={{ display: 'inline-flex', flexWrap: 'wrap', width: '18px', height: '18px', borderRadius: '3px', overflow: 'hidden' }}>
                  {def.sw.map((sw, i) => <span key={i} style={{ width: '50%', height: '50%', background: sw }} />)}
                </span>
              )}
              {def?.name || theme}
            </span>
            {onOpenTheme && <button onClick={onOpenTheme} style={{ ...S.btnGhost, flexShrink: 0 }} className="btn-ghost">Change theme</button>}
          </>
        ),
      };
    },

    defaultCat: () => ({
      ctl: (
        <select aria-label="Default task category" style={selectInline} value={settings.defaultCategory || 'lang'} onChange={e => onUpdate({ ...settings, defaultCategory: e.target.value })}>
          {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      ),
    }),

    sound: () => ({
      ctl: (
        <div role="radiogroup" aria-label="Completion sound" style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
          {SOUND_OPTIONS.map(opt => (
            <button
              key={opt.id} type="button" role="radio" aria-checked={soundProfile === opt.id} title={opt.desc}
              onClick={() => { setSoundProfile(opt.id); if (opt.id !== 'none') playSound(opt.id); }}
              style={chipStyle(S, C, soundProfile === opt.id)}
            >{opt.label}</button>
          ))}
        </div>
      ),
      note: { text: SOUND_OPTIONS.find(o => o.id === soundProfile)?.desc || '' },
    }),

    reviewCap: () => ({
      ctl: <input type="number" aria-label="Daily review cap" min="10" max="500" step="5" value={settings.srsSpikeCap ?? 80} onChange={e => onUpdate({ ...settings, srsSpikeCap: Math.max(10, Number(e.target.value)) })} style={numInput()} />,
    }),

    apptTypes: () => ({
      block: true,
      ctl: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {['lang'].map(cat => {
            const builtIn  = APPOINTMENT_TYPES[cat] || [];
            const custom   = normalizedCustomTypes[cat] || [];
            const inputVal = newApptInputs[cat] || '';
            const catColor = { lang: C.tLa }[cat] || C.textM;
            const catLabel = { lang: '한국어' }[cat];
            const addType = () => {
              const trimmed = inputVal.trim();
              if (!trimmed) return;
              if ([...builtIn, ...custom].includes(trimmed)) { setNewApptInputs(p => ({ ...p, [cat]: '' })); return; }
              onUpdate({ ...settings, customApptTypes: { ...normalizedCustomTypes, [cat]: [...custom, trimmed] } });
              setNewApptInputs(p => ({ ...p, [cat]: '' }));
            };
            return (
              <div key={cat}>
                <SubLabel color={catColor}>{catLabel}</SubLabel>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                  {builtIn.map(t => <span key={t} style={{ ...chipStyle(S, C, false), cursor: 'default', color: C.textM }}>{t}</span>)}
                  {custom.map(t => (
                    <span key={t} style={{ ...chipStyle(S, C, true, catColor), cursor: 'default', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                      {t}
                      <button
                        aria-label={`Remove ${t}`}
                        onClick={() => onUpdate({ ...settings, customApptTypes: { ...normalizedCustomTypes, [cat]: custom.filter(x => x !== t) } })}
                        style={removeX(catColor)}
                      >×</button>
                    </span>
                  ))}
                </div>
                {addLine(inputVal, v => setNewApptInputs(p => ({ ...p, [cat]: v })), addType, `Add ${catLabel} type…`)}
              </div>
            );
          })}
        </div>
      ),
    }),

    adrift: () => ({
      ctl: <input type="number" aria-label="Days until Adrift" min="1" max="365" step="1" value={settings.adriftDays ?? 14} onChange={e => onUpdate({ ...settings, adriftDays: Math.max(1, Number(e.target.value)) })} style={numInput()} />,
    }),

    retention: () => {
      const pct = Math.round((fsrs.desiredRetention ?? 0.9) * 100);
      return {
        ctl: rangeRow(
          <input type="range" aria-label="Desired retention" min="70" max="97" step="1" value={pct} onChange={e => onUpdateFSRS({ desiredRetention: Number(e.target.value) / 100 })} style={{ flex: 1, minWidth: 0, accentColor: C.accent, cursor: 'pointer' }} />,
          `${pct}%`,
        ),
      };
    },
    maxInterval: () => ({
      ctl: <input type="number" aria-label="Maximum interval in days" min="30" max="36500" step="1" value={fsrs.maximumInterval ?? 1095} onChange={e => onUpdateFSRS({ maximumInterval: Math.max(30, Number(e.target.value)) })} style={numInput('110px')} />,
    }),
    gradInterval: () => ({
      ctl: <input type="number" aria-label="Graduating interval in days" min="1" max="30" step="1" value={fsrs.graduatingInterval ?? 1} onChange={e => onUpdateFSRS({ graduatingInterval: Math.max(1, Number(e.target.value)) })} style={numInput()} />,
    }),
    easyInterval: () => ({
      ctl: <input type="number" aria-label="Easy interval in days" min="1" max="30" step="1" value={fsrs.easyInterval ?? 3} onChange={e => onUpdateFSRS({ easyInterval: Math.max(1, Number(e.target.value)) })} style={numInput()} />,
    }),
    againCap: () => ({
      ctl: <input type="number" aria-label="Again cap per session" min="1" max="10" step="1" value={fsrs.againCap ?? 2} onChange={e => onUpdateFSRS({ againCap: Math.max(1, Number(e.target.value)) })} style={numInput()} />,
    }),

    tts: () => ({
      ctl: (
        <label style={checkRow}>
          <input type="checkbox" checked={ttsOn} onChange={e => onUpdate({ ...settings, ttsEnabled: e.target.checked })} style={checkbox} />
          On
        </label>
      ),
    }),
    ttsSpeed: () => ({
      ctl: rangeRow(
        <input type="range" aria-label="Playback speed" min="0.5" max="1.2" step="0.05" value={settings.ttsSpeed ?? 0.9} onChange={e => onUpdate({ ...settings, ttsSpeed: Number(e.target.value) })} style={{ flex: 1, minWidth: 0, accentColor: C.accent, cursor: 'pointer' }} />,
        `×${(settings.ttsSpeed ?? 0.9).toFixed(2)}`,
      ),
      note: { text: '0.50 is slow, 1.20 is fast.' },
    }),
    autoTts: () => ({
      ctl: (
        <label style={{ ...checkRow, cursor: ttsOn ? 'pointer' : 'default', opacity: ttsOn ? 1 : 0.5 }}>
          <input type="checkbox" checked={ttsOn && settings.autoTtsOnImport === true} disabled={!ttsOn} onChange={e => onUpdate({ ...settings, autoTtsOnImport: e.target.checked })} style={{ ...checkbox, cursor: ttsOn ? 'pointer' : 'default' }} />
          On
        </label>
      ),
      note: ttsOn ? null : { text: 'Turn on pronunciation audio to use this.' },
    }),
    backfill: () => {
      if (backfill?.running) {
        return {
          ctl: (
            <>
              <span style={{ fontSize: '13px', color: C.text }}>Generating… {backfill.done} / {backfill.total}</span>
              <button onClick={handleBackfill} style={smallBtn} className="btn-ghost">Stop</button>
            </>
          ),
        };
      }
      if (backfill && !backfill.running) {
        return { ctl: <span style={{ fontSize: '13px', color: C.textM }}>Done: {backfill.done} card{backfill.done !== 1 ? 's' : ''} processed.</span> };
      }
      const off = !cards || !uid || missingAudioCount === 0;
      return {
        ctl: <button onClick={handleBackfill} disabled={off} style={{ ...smallBtn, opacity: off ? 0.4 : 1 }} className="btn-ghost">Generate for all cards</button>,
        note: missingAudioCount !== null
          ? { text: missingAudioCount === 0 ? 'All cards have audio.' : `${missingAudioCount} card${missingAudioCount !== 1 ? 's' : ''} missing audio` }
          : null,
      };
    },

    quizSounds: () => ({
      ctl: (
        <label style={checkRow}>
          <input type="checkbox" checked={quizSoundsEnabled !== false} onChange={e => setQuizSoundsEnabled(e.target.checked)} style={checkbox} />
          On
        </label>
      ),
    }),

    dictMode: () => ({
      block: true,
      ctl: (
        <div role="radiogroup" aria-label="Dictionary mode" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {DEMO && (
            <div style={{ fontSize: '12px', color: C.textM, marginBottom: '6px', lineHeight: 1.5 }}>
              Dictionary mode is locked to KRDict (En) in the demo.
            </div>
          )}
          {DICT_MODES.map(opt => (
            <label key={opt.id} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: '10px', alignItems: 'start', padding: '6px 0', cursor: DEMO ? 'default' : 'pointer', opacity: DEMO && opt.id !== 'krdict' ? 0.45 : 1 }}>
              <input type="radio" name="settings-dict-mode" checked={dictMode === opt.id} disabled={DEMO} onChange={() => { if (!DEMO) onUpdate({ ...settings, aviDictMode: opt.id }); }} style={{ ...checkbox, marginTop: '2px', cursor: DEMO ? 'default' : 'pointer' }} />
              <span>
                <span style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: C.text }}>{opt.label}</span>
                <span style={{ display: 'block', fontSize: '11.5px', color: C.textS }}>{opt.desc}</span>
              </span>
            </label>
          ))}
          {dictMode === 'api' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '8px', fontSize: '12.5px', color: C.text }}>
              Claude API rate limit
              <input type="number" min="1" max="60" value={apiRateLimit} onChange={e => onUpdate({ ...settings, aviApiRateLimit: Math.max(1, Number(e.target.value)) })} style={numInput('72px')} />
              <span style={{ color: C.textM }}>calls per minute</span>
            </label>
          )}
        </div>
      ),
    }),

    lemmaSort: () => ({
      ctl: (
        <div role="radiogroup" aria-label="Lemma Master order" style={{ display: 'flex', gap: '5px' }}>
          {[{ id: 'recent', label: 'Recent first' }, { id: 'alpha', label: 'A to Z' }].map(opt => (
            <button key={opt.id} type="button" role="radio" aria-checked={lemmaSortOrder === opt.id} onClick={() => onUpdate({ ...settings, aviLemmaSortOrder: opt.id })} style={chipStyle(S, C, lemmaSortOrder === opt.id)}>
              {opt.label}
            </button>
          ))}
        </div>
      ),
    }),

    overviewDisplay: () => ({
      ctl: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[{ key: 'words', label: 'Word count' }, { key: 'sentences', label: 'Sentence count' }].map(({ key, label }) => (
            <label key={key} style={checkRow}>
              <input type="checkbox" checked={overviewStatVis[key] !== false} onChange={e => onUpdate({ ...settings, aviOverviewStatVis: { ...overviewStatVis, [key]: e.target.checked } })} style={checkbox} />
              {label}
            </label>
          ))}
          <label style={checkRow}>
            <input type="checkbox" checked={showSourceless} onChange={e => onUpdate({ ...settings, aviShowSourcelessInOverview: e.target.checked })} style={checkbox} />
            Entries with no source
          </label>
        </div>
      ),
    }),

    noise: () => ({
      block: true,
      ctl: (
        <div>
          <SubLabel>Built in, always on</SubLabel>
          <div style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm, background: C.surface, border: `1px solid ${C.border}`, borderRadius: '2px', padding: '6px 10px', lineHeight: 1.8, marginBottom: '10px' }}>
            교보e?Book에서?… · 자세히 보기 :… · https://… / www.… · auth_token=…
          </div>
          <textarea
            rows={5} aria-label="Custom noise patterns"
            placeholder={'First noise block (may be multi-line)\n---\nSecond noise block'}
            value={noiseText} onChange={e => saveNoiseBlocks(e.target.value)}
            style={{ ...S.formInput, width: '100%', minHeight: '100px', resize: 'vertical', fontFamily: SH.fm, fontSize: '12px', lineHeight: 1.6 }}
          />
          <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>
            {(settings.aviNoiseBlocks || []).length} custom pattern{(settings.aviNoiseBlocks || []).length !== 1 ? 's' : ''} active
          </div>
        </div>
      ),
    }),

    stopwords: () => ({
      block: true,
      ctl: (
        <div>
          {customStopwords.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' }}>
              {customStopwords.map((word, i) => (
                <span key={i} style={{ ...chipStyle(S, C, false), cursor: 'default', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                  {word}
                  <button aria-label={`Remove ${word}`} onClick={() => removeStopword(word)} style={removeX(C.textM)}>×</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            rows={3} aria-label="Custom stopwords"
            placeholder="One word per line, or comma-separated"
            value={settings.aviStopwordProfile || ''}
            onChange={e => onUpdate({ ...settings, aviStopwordProfile: e.target.value })}
            style={{ ...S.formInput, width: '100%', resize: 'vertical', fontFamily: SH.fm, fontSize: '12px', lineHeight: 1.6 }}
          />
          <button onClick={() => setShowBuiltInStops(v => !v)} aria-expanded={showBuiltInStops} style={{ ...smallBtn, marginTop: '8px' }} className="btn-ghost">
            {showBuiltInStops ? 'Hide' : 'Show'} built-in list ({BUILT_IN_STOPWORDS.length})
          </button>
          {showBuiltInStops && (
            <div style={{ marginTop: '8px', fontSize: '11px', color: C.textM, fontFamily: SH.fm, background: C.surface, border: `1px solid ${C.border}`, borderRadius: '2px', padding: '8px 10px', lineHeight: 1.8, wordBreak: 'break-word' }}>
              {BUILT_IN_STOPWORDS.join(' · ')}
            </div>
          )}
        </div>
      ),
    }),

    currency: () => ({
      ctl: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: isMobile ? 'flex-start' : 'flex-end' }}>
          {[['USD', 1370], ['EUR', 1490]].map(([cur, fallback]) => (
            <label key={cur} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: C.text }}>
              1 {cur} = ₩
              <input
                type="number" min="1" step="1"
                value={settings.exchangeRates?.[cur] ?? fallback}
                onChange={e => onUpdate({
                  ...settings,
                  exchangeRates: { ...settings.exchangeRates, [cur]: Number(e.target.value) },
                  ratesUpdated: getLogicalDateStr(settings.dayStartHour ?? 3), // T3: was the UTC date
                })}
                style={numInput('110px')}
              />
            </label>
          ))}
        </div>
      ),
      note: settings.ratesUpdated ? { text: `Last updated: ${settings.ratesUpdated}` } : null,
    }),
  };

  const renderRow = (id, here) => {
    const c = controls[id]?.();
    if (!c) return null;
    return (
      <SettingRow key={id} id={id} here={here} block={c.block} note={c.note} flash={flashId === id} onJump={onJump}>
        {c.ctl}
      </SettingRow>
    );
  };

  const hits = query.trim() ? searchSettings(query) : null;

  return (
    <div className="fade-up" style={{ maxWidth: '760px' }}>
      <style>{`
        @keyframes settingsFlash { from { background: ${C.accentSoft}; } to { background: transparent; } }
        .settings-flash { animation: settingsFlash 1.6s ease-out; }
        @media (prefers-reduced-motion: reduce) { .settings-flash { animation: none; outline: 2px solid ${C.accent}; } }
      `}</style>

      <SettingsHeader query={query} onQuery={setQuery} />
      <SettingsTabBar tab={tab} onSection={onSection} onTab={onTab} searching={!!hits} />

      {hits ? (
        <div style={{ paddingTop: '22px' }}>
          {hits.length > 0 ? (
            <>
              <div style={{ fontFamily: SH.fm, fontSize: '12px', color: C.textS, marginBottom: '6px' }}>
                {hits.length} setting{hits.length === 1 ? '' : 's'} match “{query.trim()}”
              </div>
              <div style={{ borderTop: `1px solid ${C.border}` }}>
                {hits.map(id => renderRow(id, null))}
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: C.textS, fontSize: '13.5px', padding: '24px 0 0' }}>
              No setting matches “{query.trim()}”. Try a page name, or a word like audio, review or definition.
            </div>
          )}
        </div>
      ) : (
        <div key={tab}>
          <PanelHead tab={tab} />
          {SETTINGS_TABS[tab].groups.map(([title, ids]) => (
            <SettingsGroup key={title} title={title}>
              {ids.map(id => renderRow(id, tab))}
            </SettingsGroup>
          ))}
          <PanelEnd />
        </div>
      )}

    </div>
  );
}
