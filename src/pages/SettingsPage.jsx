import { useState, useMemo } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { CATEGORIES, SOUND_OPTIONS } from '../constants.js';
import { playSound } from '../utils/soundEngine.js';
import { SH } from '../theme/buildStyles.js';
import { APPOINTMENT_TYPES } from '../constants.js';
import { useRef } from 'react';
import { backfillCardAudio } from '../utils/ttsUtils.js';

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

export function SettingsPage({ settings, onUpdate, soundProfile, setSoundProfile, quizSoundsEnabled, setQuizSoundsEnabled, cards, uid, user, syncStatus, onSignOut }) {
  const { C, S } = useAppTheme();
  const [backfill,      setBackfill]      = useState(null); // null | { running, done, total }
  const backfillAbort = useRef(null);

  const missingAudioCount = useMemo(() => {
    if (!cards) return null;
    return cards.filter(c => {
      if (c.type === 'grammar') return !c.audioUrl && !!c.notes?.split('\n\n')[1]?.trim();
      return !c.audioUrl;
    }).length;
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
      const result = { lang: [] };
      raw.forEach(t => { result.lang.push(t); });
      return result;
    }
    return { lang: [], ...raw };
  }, [settings.customApptTypes]);

  // ── Noise blocks: convert array ↔ textarea string ─────────
  const noiseRaw = useMemo(
    () => (settings.aviNoiseBlocks || []).join('\n---\n'),
    [settings.aviNoiseBlocks]
  );
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

  const removeStopword = (word) => {
    const updated = customStopwords.filter(w => w !== word).join(', ');
    onUpdate({ ...settings, aviStopwordProfile: updated });
  };

  const dictMode = settings.aviDictMode || 'krdict';
  const apiRateLimit = settings.aviApiRateLimit ?? 5;
  const lemmaSortOrder = settings.aviLemmaSortOrder || 'recent';
  const overviewStatVis = settings.aviOverviewStatVis || { words: true, sentences: true };
  const showSourceless = settings.aviShowSourcelessInOverview !== false;
  const fsrs = settings.fsrs || {};
  const onUpdateFSRS = (patch) => {
     onUpdate({ ...settings, fsrs: { ...fsrs, ...patch } });
   };

  return (
    <div className="fade-up" style={{ maxWidth: '520px' }}>

      {/* ── Account ──────────────────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>Account</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '13px', color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.email || 'Not signed in'}
            </div>
            <div style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm, marginTop: '4px' }}>
              {syncStatus === 'ok'      ? 'Synced'     :
               syncStatus === 'syncing' ? 'Syncing…'   :
               syncStatus === 'error'   ? 'Sync error' : 'Local only'}
            </div>
          </div>
          {user && (
            <button onClick={onSignOut} style={{ ...S.btnGhost, flexShrink: 0 }} className="btn-ghost">Sign out</button>
          )}
        </div>
      </div>

      {/* ── Completion Sound ──────────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>Completion Sound</div>
        <p style={{ fontSize: '13px', color: C.textS, marginBottom: '14px', lineHeight: 1.6 }}>
          Plays when you complete a task. Click any option to preview it.
        </p>
        {SOUND_OPTIONS.map(opt => (
          <div
            key={opt.id}
            onClick={() => { setSoundProfile(opt.id); if (opt.id !== 'none') playSound(opt.id); }}
            style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', marginBottom: '6px',
              border: `1.5px solid ${soundProfile === opt.id ? C.accent : C.border}`,
              background: soundProfile === opt.id ? C.accentSoft : 'transparent',
              transition: 'all 0.15s',
            }}
          >
            <div style={{
              width: '16px', height: '16px', borderRadius: '50%', flexShrink: 0,
              border: `2px solid ${soundProfile === opt.id ? C.accent : C.borderB}`,
              background: soundProfile === opt.id ? C.accent : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {soundProfile === opt.id && <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#fff' }} />}
            </div>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 500, color: C.text }}>{opt.label}</div>
              <div style={{ fontSize: '11px', color: C.textM }}>{opt.desc}</div>
            </div>
          </div>
        ))}

        {/* Quiz sounds on/off */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', marginTop: '10px' }}>
          <input
            type="checkbox"
            checked={quizSoundsEnabled !== false}
            onChange={e => setQuizSoundsEnabled(e.target.checked)}
            style={{ width: '15px', height: '15px', accentColor: C.accent, cursor: 'pointer' }}
          />
          <span style={{ fontSize: '13px', color: C.text }}>Enable quiz sounds</span>
        </label>
        <div style={{ fontSize: '11px', color: C.textM, paddingLeft: '25px', marginTop: '4px' }}>
          Covers correct/wrong feedback, completion sounds, and UI clicks during quiz sessions.
        </div>
      </div>

      {/* ── Day-Flip Time ─────────────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>Day-Flip Time</div>
        <p style={{ fontSize: '13px', color: C.textS, marginBottom: '12px', lineHeight: 1.6 }}>
          Tasks won't flip to the next day until this hour — designed for night owls.
        </p>
        <select style={S.formSelect} value={settings.dayStartHour || 3}
          onChange={e => onUpdate({ ...settings, dayStartHour: Number(e.target.value) })}>
          {[0,1,2,3,4,5,6].map(h => (
            <option key={h} value={h}>{h === 0 ? 'Midnight (12:00 AM)' : `${h}:00 AM`}</option>
          ))}
        </select>
        <p style={{ fontSize: '11px', color: C.textM, marginTop: '8px' }}>
          Currently flips at {settings.dayStartHour || 3}:00 AM
        </p>
      </div>

      {/* ── Default Task Category — hidden while only one category exists ── */}
      {CATEGORIES.length > 1 && (
        <div style={{ ...S.statCard, marginBottom: '16px' }}>
          <div style={S.statCardTitle}>Default Task Category</div>
          <select style={S.formSelect} value={settings.defaultCategory || 'lang'}
            onChange={e => onUpdate({ ...settings, defaultCategory: e.target.value })}>
            {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
      )}

      {/* ── Currency ──────────────────────────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>Currency</div>
        <p style={{ fontSize: '13px', color: C.textS, marginBottom: '14px', lineHeight: 1.6 }}>
          All amounts are stored in KRW. Enter current exchange rates for converting USD and EUR entries.
        </p>

        <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginBottom: '8px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={S.formLabel}>1 USD = ₩</label>
            <input
              type="number"
              min="1"
              step="1"
              value={settings.exchangeRates?.USD ?? 1370}
              onChange={e => onUpdate({
                ...settings,
                exchangeRates: { ...settings.exchangeRates, USD: Number(e.target.value) },
                ratesUpdated: new Date().toISOString().slice(0, 10),
              })}
              style={{ ...S.formInput, width: '120px' }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={S.formLabel}>1 EUR = ₩</label>
            <input
              type="number"
              min="1"
              step="1"
              value={settings.exchangeRates?.EUR ?? 1490}
              onChange={e => onUpdate({
                ...settings,
                exchangeRates: { ...settings.exchangeRates, EUR: Number(e.target.value) },
                ratesUpdated: new Date().toISOString().slice(0, 10),
              })}
              style={{ ...S.formInput, width: '120px' }}
            />
          </div>
        </div>

        {settings.ratesUpdated && (
          <p style={{ fontSize: '11px', color: C.textM, marginTop: '8px' }}>
            Last updated: {settings.ratesUpdated}
          </p>
        )}
      </div>

{/* ── Appointment Types ──────────────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>Appointment Types</div>
        <p style={{ fontSize: '13px', color: C.textS, marginBottom: '16px', lineHeight: 1.6 }}>
          Add custom types per category. They appear alongside the built-in list in the appointment modal.
        </p>

        {['lang'].map((cat, catIdx) => {
          const builtIn  = APPOINTMENT_TYPES[cat] || [];
          const custom   = normalizedCustomTypes[cat] || [];
          const inputVal = newApptInputs[cat] || '';
          const catColor = { lang: C.tLa }[cat] || C.textM;
          const catLabel = { lang: '한국어' }[cat];

          const addType = () => {
            const trimmed = inputVal.trim();
            if (!trimmed) return;
            if ([...builtIn, ...custom].includes(trimmed)) {
              setNewApptInputs(p => ({ ...p, [cat]: '' }));
              return;
            }
            onUpdate({
              ...settings,
              customApptTypes: { ...normalizedCustomTypes, [cat]: [...custom, trimmed] },
            });
            setNewApptInputs(p => ({ ...p, [cat]: '' }));
          };

          return (
            <div key={cat} style={{ marginBottom: catIdx < 3 ? '20px' : 0 }}>
              <div style={{
                fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: catColor, marginBottom: '8px',
              }}>
                {catLabel}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' }}>
                {builtIn.map(t => (
                  <span key={t} style={{
                    padding: '3px 9px', borderRadius: '10px', fontSize: '11px',
                    border: `1px solid ${C.border}`, color: C.textM, background: 'transparent',
                  }}>
                    {t}
                  </span>
                ))}
                {custom.map(t => (
                  <span key={t} style={{
                    display: 'inline-flex', alignItems: 'center', gap: '3px',
                    padding: '3px 6px 3px 9px', borderRadius: '10px', fontSize: '11px', fontWeight: 500,
                    border: `1px solid ${catColor}`, background: `${catColor}18`, color: catColor,
                  }}>
                    {t}
                    <button
                      onClick={() => onUpdate({
                        ...settings,
                        customApptTypes: { ...normalizedCustomTypes, [cat]: custom.filter(x => x !== t) },
                      })}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: catColor, fontSize: '13px', lineHeight: 1, padding: '0 0 1px' }}
                    >×</button>
                  </span>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder={`Add ${catLabel} type…`}
                  value={inputVal}
                  onChange={e => setNewApptInputs(p => ({ ...p, [cat]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') addType(); }}
                  style={{ ...S.formInput, flex: 1, padding: '6px 10px', fontSize: '12px' }}
                />
                <button
                  onClick={addType}
                  style={{ ...S.btnGhost, padding: '6px 12px', fontSize: '12px', flexShrink: 0 }}
                  className="btn-ghost"
                >
                  Add
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── AI Features (Grammar Quiz, Hard Mode) ──────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>AI Features</div>
        <p style={{ fontSize: '13px', color: C.textS, marginBottom: '14px', lineHeight: 1.6 }}>
          Used for Grammar Quizzes. Key is stored in your account and synced across devices.
        </p>
        <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM, marginBottom: '6px' }}>
          Anthropic API Key
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input
            type="password"
            placeholder={settings.anthropicApiKey ? '••••••••••••••••' : 'sk-ant-…'}
            value={settings.anthropicApiKey || ''}
            onChange={e => onUpdate({ ...settings, anthropicApiKey: e.target.value })}
            style={{
              flex: 1, padding: '8px 12px', borderRadius: '8px', fontSize: '13px',
              border: `1px solid ${C.border}`, background: C.bg, color: C.text,
              fontFamily: SH.fm, outline: 'none',
            }}
          />
          {settings.anthropicApiKey && (
            <button
              onClick={() => onUpdate({ ...settings, anthropicApiKey: '' })}
              style={{
                padding: '8px 12px', borderRadius: '8px', fontSize: '12px',
                border: `1px solid ${C.border}`, background: 'transparent',
                color: C.textM, cursor: 'pointer', flexShrink: 0,
              }}
            >
              Clear
            </button>
          )}
        </div>
        {settings.anthropicApiKey && (
          <p style={{ fontSize: '11px', color: C.textM, marginTop: '8px' }}>
            Key saved. Hard Mode is available in the quiz config.
          </p>
        )}
      </div>

      {/* ── Flashcard Scheduling (FSRS) ───────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>Flashcard Scheduling (FSRS)</div>
        <p style={{ fontSize: '13px', color: C.textS, marginBottom: '14px', lineHeight: 1.6 }}>
          Controls how the spaced repetition algorithm schedules your cards.
          Changes take effect on the next review.
        </p>

        {/* Desired Retention */}
        <div style={{ marginBottom: '18px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM, marginBottom: '4px' }}>
            Desired Retention
          </div>
          <p style={{ fontSize: '12px', color: C.textM, marginBottom: '10px', lineHeight: 1.5 }}>
            Target recall probability at review time. Higher = more frequent reviews. Default: 90%.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <input
              type="range"
              min="70" max="97" step="1"
              value={Math.round((fsrs.desiredRetention ?? 0.9) * 100)}
              onChange={e => onUpdateFSRS({ desiredRetention: Number(e.target.value) / 100 })}
              style={{ flex: 1, accentColor: C.accent, cursor: 'pointer' }}
            />
            <span style={{ fontFamily: SH.fm, fontSize: '14px', fontWeight: 600, color: C.text, minWidth: '40px', textAlign: 'right' }}>
              {Math.round((fsrs.desiredRetention ?? 0.9) * 100)}%
            </span>
          </div>
        </div>

        {/* Maximum Interval */}
        <div style={{ marginBottom: '18px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM, marginBottom: '4px' }}>
            Maximum Interval (days)
          </div>
          <p style={{ fontSize: '12px', color: C.textM, marginBottom: '8px', lineHeight: 1.5 }}>
            Longest allowed gap between reviews. Default: 1095 (3 years).
          </p>
          <input
            type="number"
            min="30" max="36500" step="1"
            value={fsrs.maximumInterval ?? 1095}
            onChange={e => onUpdateFSRS({ maximumInterval: Math.max(30, Number(e.target.value)) })}
            style={{ ...S.formInput, width: '120px' }}
          />
        </div>

        {/* Graduating Interval */}
        <div style={{ marginBottom: '18px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM, marginBottom: '4px' }}>
            Graduating Interval (days)
          </div>
          <p style={{ fontSize: '12px', color: C.textM, marginBottom: '8px', lineHeight: 1.5 }}>
            First interval when a new card graduates via Hard or Good. Default: 1.
          </p>
          <input
            type="number"
            min="1" max="30" step="1"
            value={fsrs.graduatingInterval ?? 1}
            onChange={e => onUpdateFSRS({ graduatingInterval: Math.max(1, Number(e.target.value)) })}
            style={{ ...S.formInput, width: '80px' }}
          />
        </div>

        {/* Easy Interval */}
        <div style={{ marginBottom: '18px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM, marginBottom: '4px' }}>
            Easy Interval (days)
          </div>
          <p style={{ fontSize: '12px', color: C.textM, marginBottom: '8px', lineHeight: 1.5 }}>
            First interval when a new card graduates via Easy. Default: 3.
          </p>
          <input
            type="number"
            min="1" max="30" step="1"
            value={fsrs.easyInterval ?? 3}
            onChange={e => onUpdateFSRS({ easyInterval: Math.max(1, Number(e.target.value)) })}
            style={{ ...S.formInput, width: '80px' }}
          />
        </div>

        {/* Again Cap */}
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM, marginBottom: '4px' }}>
            Again Cap (per session)
          </div>
          <p style={{ fontSize: '12px', color: C.textM, marginBottom: '8px', lineHeight: 1.5 }}>
            Max times a card can be re-queued after Again before carrying over to the next session. Default: 2.
          </p>
          <input
            type="number"
            min="1" max="10" step="1"
            value={fsrs.againCap ?? 2}
            onChange={e => onUpdateFSRS({ againCap: Math.max(1, Number(e.target.value)) })}
            style={{ ...S.formInput, width: '80px' }}
          />
        </div>
      </div>

      {/* ── Pronunciation Audio ───────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>Pronunciation Audio</div>
        <p style={{ fontSize: '13px', color: C.textS, marginBottom: '14px', lineHeight: 1.6 }}>
          Korean TTS audio for flashcard review. A speaker button appears on cards that have audio generated.
        </p>

        {/* Enable / disable */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', marginBottom: '16px' }}>
          <input
            type="checkbox"
            checked={settings.ttsEnabled !== false}
            onChange={e => onUpdate({ ...settings, ttsEnabled: e.target.checked })}
            style={{ width: '15px', height: '15px', accentColor: C.accent, cursor: 'pointer' }}
          />
          <span style={{ fontSize: '13px', color: C.text }}>Enable pronunciation audio</span>
        </label>

        {/* Auto-TTS on import (Stage 9.4) */}
        <label style={{
          display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px',
          cursor: settings.ttsEnabled !== false ? 'pointer' : 'default',
          opacity: settings.ttsEnabled !== false ? 1 : 0.5,
        }}>
          <input
            type="checkbox"
            checked={settings.ttsEnabled !== false && settings.autoTtsOnImport === true}
            disabled={settings.ttsEnabled === false}
            onChange={e => onUpdate({ ...settings, autoTtsOnImport: e.target.checked })}
            style={{ width: '15px', height: '15px', accentColor: C.accent, cursor: settings.ttsEnabled !== false ? 'pointer' : 'default' }}
          />
          <span style={{ fontSize: '13px', color: C.text }}>Generate audio automatically after imports</span>
        </label>
        <div style={{ fontSize: '11px', color: C.textM, marginBottom: '16px', paddingLeft: '25px' }}>
          {settings.ttsEnabled === false
            ? 'Enable pronunciation audio above to use auto-generation on import.'
            : 'After a sentence-mode import commits, audio for the new sentences is generated in the background so cards play instantly later.'}
        </div>

        {/* Speed */}
        <div style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <label style={{ ...S.formLabel, marginBottom: 0 }}>Playback speed</label>
            <span style={{ fontSize: '13px', fontWeight: 600, color: C.accent }}>
              ×{(settings.ttsSpeed ?? 0.9).toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min="0.5" max="1.2" step="0.05"
            value={settings.ttsSpeed ?? 0.9}
            onChange={e => onUpdate({ ...settings, ttsSpeed: Number(e.target.value) })}
            style={{ width: '100%', accentColor: C.accent }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: C.textM, marginTop: '2px' }}>
            <span>0.50 (slow)</span>
            <span>1.20 (fast)</span>
          </div>
        </div>

        {/* Backfill */}
        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: '14px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: C.textM, marginBottom: '8px', letterSpacing: '0.04em' }}>
            Generate missing audio
          </div>
          {backfill?.running ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ fontSize: '13px', color: C.text }}>
                Generating... {backfill.done} / {backfill.total}
              </div>
              <button onClick={handleBackfill} style={{ ...S.btnGhost, padding: '5px 12px', fontSize: '12px' }}>
                Stop
              </button>
            </div>
          ) : backfill && !backfill.running ? (
            <div style={{ fontSize: '13px', color: C.textM }}>
              Done — {backfill.done} card{backfill.done !== 1 ? 's' : ''} processed.
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <button
                onClick={handleBackfill}
                disabled={!cards || !uid || missingAudioCount === 0}
                style={{
                  ...S.btnGhost, padding: '6px 14px', fontSize: '12px',
                  opacity: (!cards || !uid || missingAudioCount === 0) ? 0.4 : 1,
                }}
              >
                Generate for all cards
              </button>
              {missingAudioCount !== null && (
                <span style={{ fontSize: '12px', color: C.textM }}>
                  {missingAudioCount === 0 ? 'All cards have audio.' : `${missingAudioCount} card${missingAudioCount !== 1 ? 's' : ''} missing audio`}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ════════════════════════════════════════════════════
          AVI Settings
      ════════════════════════════════════════════════════ */}

      {/* ── Dictionary Mode ───────────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>AVI — Dictionary Mode</div>
        <p style={{ fontSize: '13px', color: C.textS, marginBottom: '14px', lineHeight: 1.6 }}>
          Used when fetching Definition 1 for new word and lemma entries.
          API keys are configured as Netlify environment variables and are not user-editable.
        </p>
        {DICT_MODES.map(opt => (
          <div
            key={opt.id}
            onClick={() => onUpdate({ ...settings, aviDictMode: opt.id })}
            style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', marginBottom: '6px',
              border: `1.5px solid ${dictMode === opt.id ? C.accent : C.border}`,
              background: dictMode === opt.id ? C.accentSoft : 'transparent',
              transition: 'all 0.15s',
            }}
          >
            <div style={{
              width: '16px', height: '16px', borderRadius: '50%', flexShrink: 0,
              border: `2px solid ${dictMode === opt.id ? C.accent : C.borderB}`,
              background: dictMode === opt.id ? C.accent : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {dictMode === opt.id && <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#fff' }} />}
            </div>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 500, color: C.text }}>{opt.label}</div>
              <div style={{ fontSize: '11px', color: C.textM }}>{opt.desc}</div>
            </div>
          </div>
        ))}
        {dictMode === 'api' && (
          <div style={{ marginTop: '12px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM, marginBottom: '6px' }}>
              Claude API Rate Limit (calls / minute)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="number" min="1" max="60"
                value={apiRateLimit}
                onChange={e => onUpdate({ ...settings, aviApiRateLimit: Math.max(1, Number(e.target.value)) })}
                style={{
                  width: '72px', padding: '6px 10px', borderRadius: '8px', fontSize: '13px',
                  border: `1px solid ${C.border}`, background: C.bg, color: C.text,
                  fontFamily: SH.fm, outline: 'none',
                }}
              />
              <span style={{ fontSize: '12px', color: C.textM }}>calls per minute</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Lemma Sort Order ──────────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>AVI — Lemma Sort Order</div>
        <p style={{ fontSize: '13px', color: C.textS, marginBottom: '12px', lineHeight: 1.6 }}>
          Default sort order for the Lemma Master list.
        </p>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[
            { id: 'recent', label: '↓ Recent first' },
            { id: 'alpha',  label: 'A → Z' },
          ].map(opt => (
            <button
              key={opt.id}
              onClick={() => onUpdate({ ...settings, aviLemmaSortOrder: opt.id })}
              style={{
                padding: '7px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 500,
                border: `1.5px solid ${lemmaSortOrder === opt.id ? C.accent : C.border}`,
                background: lemmaSortOrder === opt.id ? C.accentSoft : 'transparent',
                color: lemmaSortOrder === opt.id ? C.accent : C.textS,
                cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Overview Display ──────────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>AVI — Overview Display</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {[
            { key: 'words',     label: 'Show word count' },
            { key: 'sentences', label: 'Show sentence count' },
          ].map(({ key, label }) => (
            <label
              key={key}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={overviewStatVis[key] !== false}
                onChange={e => onUpdate({
                  ...settings,
                  aviOverviewStatVis: { ...overviewStatVis, [key]: e.target.checked },
                })}
                style={{ width: '15px', height: '15px', accentColor: C.accent, cursor: 'pointer' }}
              />
              <span style={{ fontSize: '13px', color: C.text }}>{label}</span>
            </label>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showSourceless}
              onChange={e => onUpdate({ ...settings, aviShowSourcelessInOverview: e.target.checked })}
              style={{ width: '15px', height: '15px', accentColor: C.accent, cursor: 'pointer' }}
            />
            <span style={{ fontSize: '13px', color: C.text }}>Show entries with no source assigned</span>
          </label>
        </div>
      </div>

      {/* ── Stopword Profile ──────────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>AVI — Stopword Profile</div>
        <p style={{ fontSize: '13px', color: C.textS, marginBottom: '12px', lineHeight: 1.6 }}>
          Additional words to ignore when matching by meaning in Search.
          These are added on top of the built-in list below.
        </p>

        {/* Custom stopword pills */}
        {customStopwords.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' }}>
            {customStopwords.map((word, i) => (
              <span key={i} style={{
                display: 'inline-flex', alignItems: 'center', gap: '4px',
                fontSize: '11px', fontFamily: SH.fm,
                background: C.surface, border: `1px solid ${C.border}`,
                borderRadius: '12px', padding: '2px 8px 2px 10px', color: C.textM,
              }}>
                {word}
                <button
                  onClick={() => removeStopword(word)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: C.textM, fontSize: '13px', lineHeight: 1,
                    padding: '0 0 1px', marginLeft: '1px',
                  }}
                >×</button>
              </span>
            ))}
          </div>
        )}

        <textarea
          rows={3}
          placeholder="One word per line, or comma-separated"
          value={settings.aviStopwordProfile || ''}
          onChange={e => onUpdate({ ...settings, aviStopwordProfile: e.target.value })}
          style={{
            ...S.formInput,
            width: '100%', resize: 'vertical', fontFamily: SH.fm,
            fontSize: '12px', lineHeight: 1.6,
          }}
        />

        <div style={{
          fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: C.textM,
          marginTop: '12px', marginBottom: '6px',
        }}>
          Built-in Stopwords (always active)
        </div>
        <div style={{
          fontSize: '11px', color: C.textM, fontFamily: SH.fm,
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: '6px', padding: '8px 10px',
          lineHeight: 1.8, wordBreak: 'break-all',
        }}>
          {BUILT_IN_STOPWORDS.join(' · ')}
        </div>
      </div>

      {/* ── E-book Noise Patterns ─────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>AVI — E-book Noise Patterns</div>
        <p style={{ fontSize: '13px', color: C.textS, marginBottom: '8px', lineHeight: 1.6 }}>
          Text stripped from pasted content before processing. Separate distinct patterns
          with a line containing only{' '}
          <code style={{ fontFamily: SH.fm, fontSize: '12px', background: C.surface, padding: '1px 5px', borderRadius: '3px' }}>
            ---
          </code>.
          Patterns can span multiple lines — useful for e-reader watermarks.
        </p>

        <div style={{
          fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: C.textM, marginBottom: '4px',
        }}>
          Built-in patterns (always active)
        </div>
        <div style={{
          fontSize: '11px', color: C.textM, fontFamily: SH.fm,
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: '6px', padding: '6px 10px',
          lineHeight: 1.8, marginBottom: '10px',
        }}>
          교보e?Book에서?… · 자세히 보기 :… · https://… / www.… · auth_token=…
        </div>

        <textarea
          rows={5}
          placeholder={'First noise block (may be multi-line)\n---\nSecond noise block'}
          value={noiseText}
          onChange={e => saveNoiseBlocks(e.target.value)}
          style={{
            ...S.formInput,
            width: '100%', minHeight: '100px', resize: 'vertical',
            fontFamily: SH.fm, fontSize: '12px', lineHeight: 1.6,
          }}
        />
        <p style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>
          {(settings.aviNoiseBlocks || []).length} custom pattern{(settings.aviNoiseBlocks || []).length !== 1 ? 's' : ''} active
        </p>
      </div>

    {/* ── Content Library ──────────────────────────────── */}
      <div style={{ ...S.statCard, marginBottom: '16px' }}>
        <div style={S.statCardTitle}>Content Library</div>
        <div style={{ marginBottom: '4px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM, marginBottom: '4px' }}>Days Until Adrift</div>
          <p style={{ fontSize: '12px', color: C.textM, marginBottom: '8px', lineHeight: 1.5 }}>
            Sources with no activity for this many days appear in the Adrift column on the Overview tab.
          </p>
          <input
            type="number" min="1" max="365" step="1"
            value={settings.adriftDays ?? 14}
            onChange={e => onUpdate({ ...settings, adriftDays: Math.max(1, Number(e.target.value)) })}
            style={{ ...S.formInput, width: '80px' }}
          />
        </div>
      </div>

    </div>

  );
}
