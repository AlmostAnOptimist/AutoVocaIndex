// src/pages/GrammarIndexPage.jsx
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { collection, getDocs, doc, updateDoc, addDoc, deleteDoc, getDoc, setDoc } from 'firebase/firestore';
import { db, auth } from '../firebase.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { Icons } from '../components/Icons.jsx';
import { crowSrc, decoBlockStyle } from '../utils/decoAssets.js';
import { generateGrammarCardAudio, playAudioUrl } from '../utils/ttsUtils.js';
import { GrammarCardPicker } from '../components/GrammarCardPicker.jsx';
import { PaginationFooter } from '../components/PaginationFooter.jsx';
import { GRAMMAR_MASTERY as MASTERY } from '../constants.js';
import { useGlobalKey } from '../hooks/useGlobalKey.js';
import { usePaginationKeys } from '../hooks/usePaginationKeys.js';
const GRAMMAR_CACHE_KEY = 'avi_grammar_entries';

const GRAMMAR_DECK_ID = 'deck_grammar';
const GRAMMAR_PAGE_SIZE = 25;
// Used now to keep the crow off mobile; the rest of the mobile pass lands in
// the next stage, but this constant needs to exist before then.
const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

// Minimum interval (days) enforced per mastery level after grading.
// Introduced has no floor — cards at that level are never in the due queue.
const MASTERY_FLOORS = { practicing: 5, confident: 20, mastered: 50 };

function stripNotionLinks(str) {
  if (!str) return str;
  return str.replace(/\s*\(https?:\/\/[^)]+\)/g, '').trim();
}

function cleanChips(str) {
  if (!str) return [];
  // Pipe is the separator for compareTo storage (commas appear in Korean grammar titles)
  return str.split('|').map(s => stripNotionLinks(s.trim())).filter(Boolean);
}

// ── Collapsible section ───────────────────────────────────────
function CollapsibleSection({ label, children, C, defaultOpen = true, action }) {
  const [open, setOpen] = useState(defaultOpen);
  // Reset when defaultOpen changes (e.g. entry switches)
  const prevDefault = useRef(defaultOpen);
  useEffect(() => {
    if (prevDefault.current !== defaultOpen) {
      setOpen(defaultOpen);
      prevDefault.current = defaultOpen;
    }
  }, [defaultOpen]);
  return (
    <div style={{ marginBottom: '18px' }}>
      <div
  onClick={() => setOpen(o => !o)}
  style={{
    display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
    marginBottom: open ? '8px' : 0,
  }}
>
        <span style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM }}>
          {label}
        </span>
        {action && (
          <span onClick={e => e.stopPropagation()} style={{ marginLeft: '8px' }}>
            {action}
          </span>
        )}
        <span style={{ fontSize: '10px', color: C.textM, marginLeft: 'auto', transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'none' }}>›</span>
      </div>
      {open && children}
    </div>
  );
}

// ── Compare-to picker modal ───────────────────────────────────
function CompareToPickerModal({ entries, currentEntry, currentCompareTo, onSave, onClose, C, S }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set(cleanChips(currentCompareTo)));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter(e =>
      e.id !== currentEntry.id &&
      (!q || e.glossaryTerm?.toLowerCase().includes(q))
    );
  }, [entries, currentEntry.id, search]);

  const toggle = (term) => {
  const next = new Set(selected);
  if (next.has(term)) next.delete(term); else next.add(term);
  setSelected(next);
  onSave([...next].join(' | '));
};

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: '16px', border: `1px solid ${C.border}`,
        width: '400px', maxWidth: '90vw', maxHeight: '70vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '18px 20px 12px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                    <span style={{ fontFamily: SH.fd, fontSize: '16px', color: C.text }}>Add comparison</span>
          <button onClick={onClose} style={{ color: C.textM, fontSize: '18px', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '12px 20px', flexShrink: 0 }}>
          <input
            autoFocus
            style={S.formInput}
            placeholder="Search patterns…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 16px' }}>
          {filtered.map(e => {
            const isSelected = selected.has(e.glossaryTerm);
            return (
              <div
                key={e.id}
                onClick={() => toggle(e.glossaryTerm)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '8px 10px', borderRadius: '8px', cursor: 'pointer',
                  background: isSelected ? C.accentSoft : 'transparent',
                  marginBottom: '2px', transition: 'background 0.15s',
                }}
                className="task-row"
              >
                <div style={{
                  width: '14px', height: '14px', borderRadius: '4px', flexShrink: 0,
                  border: isSelected ? 'none' : `1.5px solid ${C.border}`,
                  background: isSelected ? C.accent : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {isSelected && <span style={{ color: '#fff', fontSize: '9px', lineHeight: 1 }}>✓</span>}
                </div>
                <span style={{ fontFamily: SH.fk, fontSize: '13.5px', color: C.text }}>{e.glossaryTerm}</span>
                <span style={{ fontSize: '11px', color: C.textM, marginLeft: 'auto' }}>#{e.entryNumber}</span>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ fontSize: '13px', color: C.textM, fontStyle: 'italic', paddingTop: '8px' }}>No entries match.</div>
          )}
        </div>
        <div style={{ padding: '12px 20px', borderTop: `1px solid ${C.border}`, flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
          <button style={{ ...S.btnPrimary, ...S.btnMetallic }} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ── New Entry Form ────────────────────────────────────────────
function NewEntryForm({ onSave, onCancel, entryCount, allEntries, C, S }) {
  const [glossaryTerm,      setGlossaryTerm]      = useState('');
  const [compareTo,         setCompareTo]          = useState('');
  const [masteryLevel,      setMasteryLevel]       = useState('introduced');
  const [saving,            setSaving]             = useState(false);
  const [showComparePicker, setShowComparePicker]  = useState(false);

  // Dummy entry object so CompareToPickerModal can exclude self — new entry has no id yet.
  const dummyEntry = { id: '__new__', glossaryTerm };

  const handleSave = async () => {
    if (!glossaryTerm.trim()) return;
    setSaving(true);
    await onSave({ glossaryTerm: glossaryTerm.trim(), compareTo, masteryLevel, explanation: '', examples: '' });
    setSaving(false);
  };

  return (
    <div style={{
      ...(isMobile
        ? { position: 'fixed', inset: 0, zIndex: 200 }
        : { width: '460px', minWidth: '460px', maxWidth: '460px', borderLeft: `1px solid ${C.border}`, flexShrink: 0, flexGrow: 0 }),
      background: C.surface,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{ padding: '20px 20px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <span style={{ fontFamily: SH.fd, fontSize: '18px', color: C.text }}>New grammar entry</span>
        <button onClick={onCancel} style={{ color: C.textM, fontSize: '18px', lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        <div style={S.formGroup}>
          <label style={S.formLabel}>Grammar Pattern *</label>
          <input style={S.formInput} placeholder="e.g. 아/어서" value={glossaryTerm}
            onChange={e => setGlossaryTerm(e.target.value)} autoFocus />
        </div>
        <div style={S.formGroup}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
            <label style={{ ...S.formLabel, marginBottom: 0 }}>Compare to</label>
            <button
              onClick={() => setShowComparePicker(true)}
              style={{
                fontSize: '10px', padding: '2px 8px', borderRadius: '6px',
                background: 'transparent', color: C.textM,
                border: `1px solid ${C.border}`, cursor: 'pointer',
              }}
            >
              + Pick
            </button>
          </div>
          {compareTo ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }}>
              {compareTo.split('|').map(s => s.trim()).filter(Boolean).map((chip, i) => (
                <span key={i} style={{
                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                  padding: '3px 10px', borderRadius: '20px', fontSize: '12px',
                  border: `1px solid ${C.accent}66`, color: C.accent,
                  background: C.accentSoft, fontFamily: SH.fk,
                }}>
                  {chip}
                  <button
                    onClick={() => setCompareTo(compareTo.split('|').map(s => s.trim()).filter(s => s !== chip).join(' | '))}
                    style={{ color: C.accent, fontSize: '12px', lineHeight: 1, padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}
                  >×</button>
                </span>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', marginBottom: '6px' }}>None selected</div>
          )}
        </div>
        <div style={S.formGroup}>
          <label style={S.formLabel}>Mastery</label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {Object.entries(MASTERY).map(([key, val]) => {
              const active = masteryLevel === key;
              return (
                <button key={key} onClick={() => setMasteryLevel(key)} style={{
                  padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500,
                  border: `1px solid ${active ? val.color : C.border}`,
                  background: active ? `${val.color}22` : 'transparent',
                  color: active ? val.color : C.textS,
                  cursor: 'pointer', transition: 'all 0.15s',
                }}>{val.label}</button>
              );
            })}
          </div>
        </div>
        <div style={{ ...S.infoBox, marginTop: '8px' }}>
          A flashcard will be created automatically in the Grammar deck.
          Explanation and examples can be added after saving.
        </div>
      </div>

      <div style={{ padding: '14px 20px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: '8px', justifyContent: 'flex-end', flexShrink: 0 }}>
        <button style={S.btnGhost} onClick={onCancel}>Cancel</button>
        <button
          style={{ ...S.btnPrimary, ...S.btnMetallic, opacity: (!glossaryTerm.trim() || saving) ? 0.6 : 1 }}
          onClick={handleSave} disabled={!glossaryTerm.trim() || saving}
        >
          {saving ? 'Saving…' : 'Create entry'}
        </button>
      </div>

      {showComparePicker && (
        <CompareToPickerModal
          entries={allEntries}
          currentEntry={dummyEntry}
          currentCompareTo={compareTo}
          onSave={val => { setCompareTo(val); setShowComparePicker(false); }}
          onClose={() => setShowComparePicker(false)}
          C={C} S={S}
        />
      )}
    </div>
  );
}

// ── Detail panel ──────────────────────────────────────────────
function EntryDetail({
  entry, allEntries, linkedCardId, linkedCard, linkedNotes, linkedSections,
  onClose, onSave, onDelete, onRename, onNavigateToCard, onNavigateToNote, onNavigateToEntry,
  onAddQuestion, onLinkSection, onNavigateToContent, allSections, C, S,
}) {
  const [editing,       setEditing]       = useState(false);
  const [saving,        setSaving]        = useState(false);
  const [compareTo,     setCompareTo]     = useState(stripNotionLinks(entry.compareTo   || ''));
  const [explanation,   setExplanation]   = useState(entry.explanation || '');
  const [examples,      setExamples]      = useState(entry.examples    || '');
  const [examplesExpanded, setExamplesExpanded] = useState(!(linkedCard?.exampleAudio?.length > 0));  const [masteryLevel,  setMasteryLevel]  = useState(entry.masteryLevel || 'introduced');
  const [showComparePicker, setShowComparePicker] = useState(false);
  const [secSearch,     setSecSearch]     = useState('');
  const [secPickerOpen, setSecPickerOpen] = useState(false);
  const [editingTitle,  setEditingTitle]  = useState(false);
  const [titleDraft,    setTitleDraft]    = useState(entry.glossaryTerm || '');
  const [showDelete,    setShowDelete]    = useState(false);
  const titleInputRef = useRef(null);

  // ── Example sentence TTS playback ───────────────────────────
  // playingKey is null (nothing playing) or the index of the playing example line.
  const [playingKey, setPlayingKey] = useState(null);
  const cancelAudioRef = useRef(null);
  const stopAudio = useCallback(() => {
    cancelAudioRef.current?.();
    cancelAudioRef.current = null;
    setPlayingKey(null);
  }, []);
  const handlePlayExample = useCallback((idx, url) => {
    if (!url) return;
    if (playingKey === idx) { stopAudio(); return; }
    stopAudio();
    const { promise, cancel } = playAudioUrl(url);
    cancelAudioRef.current = cancel;
    setPlayingKey(idx);
    promise.then(stopAudio).catch(stopAudio);
  }, [playingKey, stopAudio]);
  // Stop playback when switching entries.
  useEffect(() => { return () => stopAudio(); }, [entry.id, stopAudio]);

  useEffect(() => { if (editingTitle && titleInputRef.current) titleInputRef.current.focus(); }, [editingTitle]);

  const commitTitle = () => {
    setEditingTitle(false);
    const val = titleDraft.trim();
    if (val && val !== entry.glossaryTerm) onRename && onRename(entry.id, val);
  };

  useEffect(() => {
    setCompareTo(stripNotionLinks(entry.compareTo || ''));
    setExplanation(entry.explanation || '');
    setExamples(entry.examples || '');
    setMasteryLevel(entry.masteryLevel || 'introduced');
    setTitleDraft(entry.glossaryTerm || '');
    setEditing(false);
    // Default to the listen view when this entry already has generated audio,
    // default to the editable textarea otherwise. This only sets the default
    // when switching entries — manual toggling afterward is left alone, so
    // audio arriving mid-edit never yanks the field out from under you.
    setExamplesExpanded(!(linkedCard?.exampleAudio?.length > 0));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.compareTo, entry.glossaryTerm]);

  const handleSave = async () => {
    setSaving(true);
    await onSave(entry.id, { compareTo, explanation, examples, masteryLevel });
    setSaving(false);
    setEditing(false);
  };

  const handleCancel = () => {
    setCompareTo(stripNotionLinks(entry.compareTo || ''));
    setExplanation(entry.explanation || '');
    setExamples(entry.examples || '');
    setMasteryLevel(entry.masteryLevel || 'introduced');
    setEditing(false);
  };

  // Save compareTo immediately from picker (no edit mode required)
  const handleCompareToSave = async (newVal) => {
    // Deduplicate chips before saving
    const deduped = [...new Set(cleanChips(newVal))].join(' | ');
    setCompareTo(deduped);
    await onSave(entry.id, { compareTo: deduped });
  };

  const mastery      = MASTERY[masteryLevel] || MASTERY.introduced;
  const compareChips = cleanChips(compareTo);
  // Lines mirror the live textarea (not the saved card) so the playback strip
  // never shows stale content while editing — a line only gets a play button
  // once its exact text matches a generated clip on the linked card.
  const exampleLines = examples.split('\n').map(s => s.trim()).filter(Boolean);
  const audioByText  = new Map((linkedCard?.exampleAudio || []).map(a => [a.text, a.url]));

  // Split linked notes into question-tagged and general
  const questionNotes = linkedNotes.filter(n => (n.tags || []).includes('question'));
  const generalNotes  = linkedNotes.filter(n => !(n.tags || []).includes('question'));

  return (
    <>
      <div style={{
        ...(isMobile
          ? { position: 'fixed', inset: 0, zIndex: 200 }
          : { width: '760px', minWidth: '760px', maxWidth: '760px', borderLeft: `1px solid ${C.border}`, flexShrink: 0, flexGrow: 0, flexBasis: '760px' }),
        background: C.surface, display: 'flex', flexDirection: 'column',
        height: '100%', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 20px 16px', borderBottom: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px',
          flexShrink: 0,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '6px' }}>
              #{entry.entryNumber}
            </div>
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={e => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={e => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') { setTitleDraft(entry.glossaryTerm); setEditingTitle(false); } }}
                style={{
                  fontFamily: SH.fk, fontSize: '22px', fontWeight: 600, color: C.text,
                  background: 'transparent', border: 'none', borderBottom: `2px solid ${C.accent}`,
                  outline: 'none', width: '100%', padding: '0 0 2px',
                }}
              />
            ) : (
              <div
                onClick={() => { setTitleDraft(entry.glossaryTerm); setEditingTitle(true); }}
                title="Click to rename"
                style={{ fontFamily: SH.fk, fontSize: '22px', fontWeight: 600, color: C.text, lineHeight: 1.2, cursor: 'text' }}
              >
                {entry.glossaryTerm}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
            {linkedCardId && onNavigateToCard && (
              <button onClick={() => onNavigateToCard(linkedCardId)}
                style={{ ...S.btnGhost, fontSize: '12px', padding: '5px 12px' }}>
                View Card
              </button>
            )}
            {!editing && (
              <button onClick={() => setEditing(true)}
                style={{ ...S.btnGhost, fontSize: '12px', padding: '5px 12px' }}>
                Edit
              </button>
            )}
            <button onClick={onClose}
              style={{ color: C.textM, fontSize: '18px', lineHeight: 1, padding: '2px', background: 'none', border: 'none', cursor: 'pointer' }}>
              ✕
            </button>
          </div>
        </div>

        {showDelete && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{ background: C.surface, borderRadius: '12px', border: `1px solid ${C.border}`, padding: '24px', maxWidth: '320px', width: '90%' }}>
              <div style={{ fontFamily: SH.fd, fontSize: '18px', color: C.text, marginBottom: '8px' }}>Delete entry?</div>
              <div style={{ fontSize: '13px', color: C.textM, marginBottom: '20px' }}>
                This will delete <strong style={{ fontFamily: SH.fk, color: C.text }}>{entry.glossaryTerm}</strong> and its linked flashcard. This cannot be undone.
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button style={S.btnGhost} onClick={() => setShowDelete(false)}>Cancel</button>
                <button style={S.btnDanger} onClick={() => onDelete && onDelete(entry.id, linkedCardId)}>Delete</button>
              </div>
            </div>
          </div>
        )}

        {/* Mastery pills — always editable */}
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
          <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '8px' }}>
            Mastery
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            {Object.entries(MASTERY).map(([key, val]) => {
              const active = masteryLevel === key;
              return (
                <button key={key} onClick={() => { setMasteryLevel(key); onSave(entry.id, { masteryLevel: key }); }}
                  style={{
                    padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500,
                    border: `1px solid ${active ? val.color : C.border}`,
                    background: active ? `${val.color}22` : 'transparent',
                    color: active ? val.color : C.textS,
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}>
                  {val.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Scrollable fields */}
        <div style={{ padding: '20px', flex: 1, overflowY: 'auto' }}>

          {/* 1. Explanation */}
          <CollapsibleSection label="Explanation / Usage Rules" C={C} defaultOpen={!!entry.explanation}>
            <textarea
              style={{ ...S.formInput, minHeight: '120px', resize: 'vertical', lineHeight: 1.6 }}
              value={explanation}
              onChange={e => setExplanation(e.target.value)}
              onBlur={e => { if (e.target.value !== (entry.explanation || '')) onSave(entry.id, { explanation: e.target.value }); }}
              placeholder="Usage rules, notes, conjugation patterns…"
            />
          </CollapsibleSection>

          {/* 2. Examples — textarea and playback are mutually exclusive once
              audio exists, so the same sentences never appear twice. */}
          <CollapsibleSection
            label="Examples"
            C={C}
            defaultOpen={!!entry.examples}
            action={audioByText.size > 0 && (
              <button
                onClick={() => setExamplesExpanded(v => !v)}
                style={{
                  fontSize: '10px', padding: '2px 8px', borderRadius: '6px',
                  background: C.accentSoft, color: C.accent,
                  border: `1px solid ${C.accent}44`, cursor: 'pointer',
                  fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px',
                }}
              >
                {examplesExpanded ? 'Hide text' : 'Edit text'}
                <span style={{ fontSize: '10px', display: 'inline-block', transition: 'transform 0.15s', transform: examplesExpanded ? 'rotate(-90deg)' : 'rotate(90deg)' }}>›</span>
              </button>
            )}
          >
            {examplesExpanded && (
              <textarea
                style={{ ...S.formInput, minHeight: '100px', resize: 'vertical', lineHeight: 1.6, fontFamily: SH.fk }}
                value={examples}
                onChange={e => setExamples(e.target.value)}
                onBlur={e => { if (e.target.value !== (entry.examples || '')) onSave(entry.id, { examples: e.target.value }); }}
                placeholder="Example sentences…"
              />
            )}
            {!examplesExpanded && exampleLines.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {exampleLines.map((line, i) => {
                  const url = audioByText.get(line);
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                      <button
                        onClick={() => handlePlayExample(i, url)}
                        disabled={!url}
                        style={{
                          flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          width: '24px', height: '24px', borderRadius: '6px', marginTop: '1px',
                          border: `1px solid ${playingKey === i ? C.accent : C.border}`,
                          background: playingKey === i ? C.accentSoft : 'transparent',
                          color: playingKey === i ? C.accent : C.textM,
                          cursor: url ? 'pointer' : 'default',
                          opacity: url ? 1 : 0.35,
                        }}
                      >
                        {playingKey === i ? Icons.speakerPlaying : Icons.speaker}
                      </button>
                      <span style={{ fontFamily: SH.fk, fontSize: '13px', color: C.textS, lineHeight: 1.6 }}>{line}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CollapsibleSection>

          {/* 3. Questions */}
          <CollapsibleSection
            label="Questions"
            C={C}
            defaultOpen={questionNotes.length > 0}
            action={
              <button
                onClick={() => onAddQuestion(entry)}
                style={{
                  fontSize: '10px', padding: '2px 8px', borderRadius: '6px',
                  background: C.accentSoft, color: C.accent,
                  border: `1px solid ${C.accent}44`, cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                + Add question
              </button>
            }
          >
            {questionNotes.length === 0 ? (
              <div style={{ fontSize: '13px', color: C.textM, fontStyle: 'italic' }}>No questions yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {questionNotes.map(note => (
                  <div key={note.id}
                    onClick={() => onNavigateToNote && onNavigateToNote(note.id)}
                    style={{
                      padding: '10px 12px', borderRadius: '8px',
                      border: `1px solid ${C.accent}33`, background: C.accentSoft,
                      cursor: onNavigateToNote ? 'pointer' : 'default', transition: 'background 0.15s',
                    }}
                    className="task-row"
                  >
                    <div style={{ fontSize: '13px', fontWeight: 500, color: C.text, marginBottom: '2px' }}>
                      {note.title || <span style={{ fontStyle: 'italic', color: C.textM }}>Untitled</span>}
                    </div>
                    {(note.bodyHtml || note.body) && (
                      <div style={{ fontSize: '12px', color: C.textM, lineHeight: 1.4 }}>
                        {(note.bodyHtml
                          ? note.bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                          : note.body.replace(/\n+/g, ' ').trim()
                        ).slice(0, 80)}…
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CollapsibleSection>

          {/* 4. Linked Notes (general — non-question) */}
          <CollapsibleSection label="Linked Notes" C={C} defaultOpen={generalNotes.length > 0}>
            {generalNotes.length === 0 ? (
              <div style={{ fontSize: '13px', color: C.textM, fontStyle: 'italic' }}>No linked notes.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {generalNotes.map(note => (
                  <div key={note.id}
                    onClick={() => onNavigateToNote && onNavigateToNote(note.id)}
                    style={{
                      padding: '10px 12px', borderRadius: '8px',
                      border: `1px solid ${C.border}`, background: C.bg,
                      cursor: onNavigateToNote ? 'pointer' : 'default', transition: 'background 0.15s',
                    }}
                    className="task-row"
                  >
                    <div style={{ fontSize: '13px', fontWeight: 500, color: C.text, marginBottom: '3px' }}>
                      {note.title || <span style={{ fontStyle: 'italic', color: C.textM }}>Untitled</span>}
                    </div>
                    {(note.bodyHtml || note.body) && (
                      <div style={{ fontSize: '12px', color: C.textM, marginBottom: '4px', lineHeight: 1.4 }}>
                        {(note.bodyHtml
                          ? note.bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                          : note.body.replace(/\n+/g, ' ').trim()
                        ).slice(0, 80)}…
                      </div>
                    )}
                    <div style={{ fontSize: '10px', color: C.textM, fontFamily: SH.fm }}>
                      {note.updatedAt ? new Date(note.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CollapsibleSection>

          {/* 5. Content Sections */}
          <CollapsibleSection
            label="Content Sections"
            C={C}
            defaultOpen={linkedSections.length > 0}
            action={
              <button
                onClick={() => setSecPickerOpen(o => !o)}
                style={{
                  fontSize: '10px', padding: '2px 8px', borderRadius: '6px',
                  background: 'transparent', color: C.textM,
                  border: `1px solid ${C.border}`, cursor: 'pointer',
                }}
              >
                + Add
              </button>
            }
          >
            {linkedSections.length === 0 && !secPickerOpen ? (
              <div style={{ fontSize: '13px', color: C.textM, fontStyle: 'italic' }}>No linked content sections.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {linkedSections.map((sec, i) => (
                  <div key={i} style={{ padding: '8px 12px', borderRadius: '8px', border: `1px solid ${C.border}`, background: C.bg, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                    <div
                      onClick={() => sec.resourceId && onNavigateToContent?.(sec.resourceId)}
                      style={{ cursor: sec.resourceId ? 'pointer' : 'default' }}>
                      <div style={{ fontSize: '13px', color: sec.resourceId ? C.accent : C.text, marginBottom: '2px' }}>{sec.content}</div>
                      {sec.resourceRaw && <div style={{ fontSize: '10px', color: C.textM }}>{sec.resourceRaw}</div>}
                    </div>
                    <button
                      onClick={() => onLinkSection && onLinkSection(sec, entry.id, false)}
                      style={{ color: C.textM, fontSize: '13px', lineHeight: 1, padding: 0, background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, marginTop: '2px' }}
                    >×</button>
                  </div>
                ))}
                {secPickerOpen && (
                  <div>
                    <input
                      autoFocus
                      style={{ ...S.formInput, fontSize: '12px', margin: 0, padding: '6px 8px' }}
                      placeholder="Search sections…"
                      value={secSearch}
                      onChange={e => setSecSearch(e.target.value)}
                    />
                    {(() => {
                      const q = secSearch.trim().toLowerCase();
                      const already = new Set(linkedSections.map(s => s.id));
                      const results = (allSections || [])
                        .filter(s => !already.has(s.id) && (!q || s.content?.toLowerCase().includes(q) || s.resourceRaw?.toLowerCase().includes(q)))
                        .slice(0, 6);
                      if (!results.length) return null;
                      return (
                        <div style={{ border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden', marginTop: '4px', background: C.raised }}>
                          {results.map(sec => (
                            <div key={sec.id}
                              onClick={() => { onLinkSection && onLinkSection(sec, entry.id, true); setSecSearch(''); setSecPickerOpen(false); }}
                              style={{ padding: '7px 10px', cursor: 'pointer', fontSize: '12px', color: C.text, borderBottom: `1px solid ${C.border}` }}
                              className="task-row"
                            >
                              <div style={{ fontWeight: 500 }}>{sec.content}</div>
                              {sec.resourceRaw && <div style={{ fontSize: '10px', color: C.textM }}>{sec.resourceRaw}</div>}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
          </CollapsibleSection>

          {/* 6. Compare to */}
          <CollapsibleSection
            label="Compare to"
            C={C}
            defaultOpen={compareChips.length > 0}
            action={
              !editing && (
                <button
                  onClick={() => setShowComparePicker(true)}
                  style={{
                    fontSize: '10px', padding: '2px 8px', borderRadius: '6px',
                    background: 'transparent', color: C.textM,
                    border: `1px solid ${C.border}`, cursor: 'pointer',
                  }}
                >
                  + Add
                </button>
              )
            }
          >
            {editing ? (
              <input style={S.formInput} value={compareTo}
                onChange={e => setCompareTo(e.target.value)}
                placeholder="Comma-separated patterns…" />
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {compareChips.length > 0 ? compareChips.map((chip, i) => {
                  const target = allEntries.find(e =>
                    e.glossaryTerm?.toLowerCase().trim() === chip.toLowerCase().trim()
                  );
                  return (
                    <span
                      key={i}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '4px',
                        padding: '3px 10px', borderRadius: '20px', fontSize: '12px',
                        border: `1px solid ${target ? C.accent + '66' : C.border}`,
                        color: target ? C.accent : C.textM,
                        background: target ? C.accentSoft : 'transparent',
                        fontFamily: SH.fk,
                      }}
                    >
                      <span
                        onClick={() => target && onNavigateToEntry(target)}
                        title={target ? `Go to ${chip}` : 'No matching entry'}
                        style={{ cursor: target ? 'pointer' : 'default' }}
                      >
                        {chip}
                      </span>
                      <button
                        onClick={() => {
                          const next = compareChips.filter((_, idx) => idx !== i).join(' | ');
                          handleCompareToSave(next);
                        }}
                        title="Remove"
                        style={{ color: target ? C.accent : C.textM, fontSize: '12px', lineHeight: 1, padding: 0, background: 'none', border: 'none', cursor: 'pointer', opacity: 0.7 }}
                      >×</button>
                    </span>
                  );
                }) : <span style={{ fontSize: '13px', color: C.textM }}>—</span>}
              </div>
            )}
          </CollapsibleSection>

          {/* Delete — bottom of panel, separated to reduce accidental clicks */}
          <div style={{ marginTop: '32px', paddingTop: '16px', borderTop: `1px solid ${C.border}` }}>
            <button
              onClick={() => setShowDelete(true)}
              style={{
                ...S.btnGhost, fontSize: '12px', padding: '6px 14px',
                color: C.danger, borderColor: `${C.danger}44`,
              }}
            >
              Delete entry
            </button>
          </div>

        </div>

        {/* Edit footer */}
        {editing && (
          <div style={{ padding: '14px 20px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: '8px', justifyContent: 'flex-end', flexShrink: 0 }}>
            <button style={S.btnGhost} onClick={handleCancel}>Cancel</button>
            <button style={{ ...S.btnPrimary, ...S.btnMetallic, opacity: saving ? 0.6 : 1 }} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {/* Compare-to picker modal */}
      {showComparePicker && (
        <CompareToPickerModal
          entries={allEntries}
          currentEntry={entry}
          currentCompareTo={compareTo}
          onSave={handleCompareToSave}
          onClose={() => setShowComparePicker(false)}
          C={C} S={S}
        />
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────
export function GrammarIndexPage({ onNavigateToFlashcard, onNavigateToNote, onNavigateToContent, defaultOpenEntryId,
  onMasteryCounts, onEntriesChange, getCardNextDueDate, onCardNextDueDateChanged, updateCards, cards }) {
  const { C, S } = useAppTheme();
  const [entries,     setEntries]     = useState([]);
  const [cardMap,     setCardMap]     = useState({});
  const [notes,       setNotes]       = useState([]);
  const [sections,    setSections]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [search,      setSearch]      = useState('');
  const [filter,      setFilter]      = useState('all');
  const [selected,    setSelected]    = useState(null);
  const [panelOpen,   setPanelOpen]   = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [selectMode,  setSelectMode]  = useState(false);
  const [grammarPage, setGrammarPage] = useState(0);
  const listScrollRef = useRef(null);

  useEffect(() => {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  (async () => {
    try {
      // ── Grammar entries: paint from cache instantly, then always refresh from Firestore ──
      try {
        const cached = localStorage.getItem(GRAMMAR_CACHE_KEY);
        if (cached) setEntries(JSON.parse(cached));
      } catch {}
      const entrySnap = await getDocs(collection(db, 'users', uid, 'grammar_entries'));
      const rows = entrySnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.entryNumber || 0) - (b.entryNumber || 0));
      setEntries(rows);
      try { localStorage.setItem(GRAMMAR_CACHE_KEY, JSON.stringify(rows)); } catch {}

      // ── Flashcards (for cardMap cross-reference) ──
      const cardSnap = await getDocs(collection(db, 'users', uid, 'flashcards'));
      const cardDocs = cardSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const map = {};
      cardDocs.forEach(d => {
        if (d.type === 'grammar' && d.linkedGrammarEntryId) map[d.linkedGrammarEntryId] = d.id;
      });
      setCardMap(map);

      // ── Notes ──
      const notesSnap = await getDocs(collection(db, 'users', uid, 'notes'));
      setNotes(notesSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      // ── Content sections ──
      const secSnap = await getDocs(collection(db, 'users', uid, 'content_sections'));
      setSections(secSnap.docs.map(d => ({ id: d.id, ...d.data() })));

    } catch (e) {
      console.error('GrammarIndex: load failed', e);
    } finally {
      setLoading(false);
    }
  })();
}, []);

// Write the current entries array back to localStorage after any mutation.
  const updateCache = useCallback((updatedEntries) => {
    try { localStorage.setItem(GRAMMAR_CACHE_KEY, JSON.stringify(updatedEntries)); } catch {}
  }, []);

  // ── Grammar corpus: rebuild whenever entries change ───────────────────────
  // Writes a compact grammar_corpus document to Firestore for grammar quiz API calls.
  // Debounced 2 seconds so rapid edits don't spam writes.
  const corpusTimerRef = useRef(null);
  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid || entries.length === 0) return;
    clearTimeout(corpusTimerRef.current);
    corpusTimerRef.current = setTimeout(async () => {
      try {
        const corpusEntries = entries.map(e => ({
          id:          e.id,
          term:        e.glossaryTerm   || '',
          level:       e.masteryLevel   || '',
          compareTo:   e.compareTo      || '',
          explanation: e.explanation    || '',
        }));
        await setDoc(doc(db, 'users', uid, 'grammar_corpus', 'index'), {
          entries:   corpusEntries,
          updatedAt: new Date().toISOString(),
        });
      } catch (e) {
        console.error('GrammarIndex: corpus rebuild failed', e);
      }
    }, 2000);
    return () => clearTimeout(corpusTimerRef.current);
  }, [entries]);

  useEffect(() => {
    if (!defaultOpenEntryId || loading) return;
    const found = entries.find(e => e.id === defaultOpenEntryId);
    if (found) {
      setSelected(found);
      setPanelOpen(true);
      // Jump the table to whichever page this entry falls on in the current
      // filtered/sorted list, so it's visible (highlighted) behind the panel.
      const idx = visible.findIndex(e => e.id === defaultOpenEntryId);
      if (idx >= 0) setGrammarPage(Math.floor(idx / GRAMMAR_PAGE_SIZE));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultOpenEntryId, entries, loading]);

  // One-time migration: close gaps in entryNumber on first load.
  // Runs silently in the background after entries are loaded.
  useEffect(() => {
    if (loading || entries.length === 0) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const sorted = [...entries].sort((a, b) => (a.entryNumber || 0) - (b.entryNumber || 0));
    const needsFix = sorted.some((e, i) => (e.entryNumber || 0) !== i + 1);
    if (!needsFix) return;
    (async () => {
      const updates = [];
      for (let i = 0; i < sorted.length; i++) {
        const correct = i + 1;
        if ((sorted[i].entryNumber || 0) !== correct) {
          updates.push({ id: sorted[i].id, entryNumber: correct });
        }
      }
      for (const u of updates) {
        try {
          await updateDoc(doc(db, 'users', uid, 'grammar_entries', u.id), { entryNumber: u.entryNumber });
        } catch (e) {
          console.error('Renumber migration failed for', u.id, e);
        }
      }
      setEntries(prev => {
        const map = Object.fromEntries(updates.map(u => [u.id, u.entryNumber]));
        return prev.map(e => map[e.id] !== undefined ? { ...e, entryNumber: map[e.id] } : e)
                   .sort((a, b) => (a.entryNumber || 0) - (b.entryNumber || 0));
      });
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // One-time migration: strip Notion URLs and remove non-matching chips from compareTo.
  // Guarded by a Firestore flag so it only ever runs once.
  useEffect(() => {
    if (loading || entries.length === 0) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    (async () => {
      // Check if migration has already run
      try {
        const flagRef = doc(db, 'users', uid, 'meta', 'grammar_cleanup');
        const flagSnap = await getDoc(flagRef);
        if (flagSnap.exists() && flagSnap.data()?.compareToCleanedV2) return;
      } catch (e) {
        console.error('compareTo migration: flag check failed', e);
        return;
      }

      // Build a set of all current valid glossaryTerms (lowercased for matching)
      const validTerms = new Map(
        entries.map(e => [e.glossaryTerm.toLowerCase().trim(), e.glossaryTerm])
      );

      // For each entry, clean and validate its compareTo chips
      const updates = [];
      for (const entry of entries) {
        const raw = entry.compareTo || '';
        if (!raw) continue;
        const chips = cleanChips(raw); // strips Notion URLs
        const cleaned = [...new Set(  // deduplicate
          chips.filter(c => validTerms.has(c.toLowerCase().trim()))
               .map(c => validTerms.get(c.toLowerCase().trim())) // normalize to current casing
        )];
        const cleanedStr = cleaned.join(' | ');
        if (cleanedStr !== raw) {
          updates.push({ id: entry.id, compareTo: cleanedStr });
        }
      }

      // Write cleaned compareTo values to Firestore
      for (const u of updates) {
        try {
          await updateDoc(doc(db, 'users', uid, 'grammar_entries', u.id), { compareTo: u.compareTo });
        } catch (e) {
          console.error('compareTo migration: update failed for', u.id, e);
        }
      }

      // Update local state
      if (updates.length > 0) {
        const updateMap = Object.fromEntries(updates.map(u => [u.id, u.compareTo]));
        setEntries(prev => prev.map(e =>
          updateMap[e.id] !== undefined ? { ...e, compareTo: updateMap[e.id] } : e
        ));
      }

      // Write the flag so this never runs again
      try {
        const flagRef = doc(db, 'users', uid, 'meta', 'grammar_cleanup');
        await setDoc(flagRef, { compareToCleanedV1: true, compareToCleanedV2: true });
      } catch (e) {
        console.error('compareTo migration: flag write failed', e);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Sync compareTo bidirectionally after saving one entry's compareTo.
  // Ensures that if A compares to B, B also compares to A.
  const syncCompareTo = useCallback(async (entryId, newCompareTo, thisTerm) => {
    const uid = auth.currentUser?.uid;
  if (!uid) return;
  if (!thisTerm) return; 
  const newChips = cleanChips(newCompareTo);

    for (const otherEntry of entries) {
      if (otherEntry.id === entryId) continue;
      const otherChips   = cleanChips(otherEntry.compareTo || '');
      const shouldLink   = newChips.some(c => c.toLowerCase().trim() === otherEntry.glossaryTerm.toLowerCase().trim());
      const alreadyLinks = otherChips.some(c => c.toLowerCase().trim() === thisTerm.toLowerCase().trim());

      if (shouldLink && !alreadyLinks) {
        const next = [...otherChips, thisTerm].join(' | ');
        await updateDoc(doc(db, 'users', uid, 'grammar_entries', otherEntry.id), { compareTo: next });
        setEntries(prev => prev.map(e => e.id === otherEntry.id ? { ...e, compareTo: next } : e));
      } else if (!shouldLink && alreadyLinks) {
        const next = otherChips.filter(c => c.toLowerCase().trim() !== thisTerm.toLowerCase().trim()).join(' | ');
        await updateDoc(doc(db, 'users', uid, 'grammar_entries', otherEntry.id), { compareTo: next });
        setEntries(prev => prev.map(e => e.id === otherEntry.id ? { ...e, compareTo: next } : e));
      }
    }
  }, [entries]);

  const handleSave = useCallback(async (id, updates) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    // Stamp a change timestamp whenever masteryLevel actually changes, so a future
    // "just reached Mastered" headline can tell a fresh promotion apart from a
    // level that's been sitting unchanged for months.
    let finalUpdates = updates;
    if ('masteryLevel' in updates) {
      const currentMastery = entries.find(e => e.id === id)?.masteryLevel || 'introduced';
      if (updates.masteryLevel !== currentMastery) {
        finalUpdates = { ...updates, masteryLevelChangedAt: new Date().toISOString() };
      }
    }
    await updateDoc(doc(db, 'users', uid, 'grammar_entries', id), finalUpdates);
    setEntries(prev => {
      const next = prev.map(e => e.id === id ? { ...e, ...finalUpdates } : e);
      updateCache(next);
      return next;
    });
    setSelected(prev => prev?.id === id ? { ...prev, ...finalUpdates } : prev);
    if ('explanation' in updates || 'examples' in updates || 'compareTo' in updates) {
      const cardId = cardMap[id];
      if (cardId) {
        // Use current entry values as fallback for fields not included in this save,
        // so a blur on one field doesn't wipe the other field's value off the card.
        const currentEntry  = entries.find(e => e.id === id) || {};
        const back        = 'compareTo'   in updates ? (updates.compareTo   ?? '') : (currentEntry.compareTo   || '');
        const explanation = 'explanation' in updates ? (updates.explanation ?? '') : (currentEntry.explanation || '');
        const examples    = 'examples'    in updates ? (updates.examples    ?? '') : (currentEntry.examples    || '');
        const newBack     = stripNotionLinks(back);
        // Explanation and examples are kept as separate fields on the card —
        // previously these were merged into one `notes` string and recovered
        // by splitting on blank lines, which broke whenever explanation itself
        // had a paragraph break.
        await updateDoc(doc(db, 'users', uid, 'flashcards', cardId), {
          back: newBack,
          explanation,
          examples,
        });
        // Keep in-memory cards in sync so the next session sees changes immediately.
        updateCards?.(prev => prev?.map(c => c.id === cardId ? { ...c, back: newBack, explanation, examples } : c) ?? prev);
        // Regenerate TTS whenever examples change (fire-and-forget). The completion
        // callback patches the in-memory card so newly generated audio is playable
        // in this same session, without waiting for the next full reload.
        if ('examples' in updates && updates.examples?.trim()) {
          generateGrammarCardAudio({
            examples: updates.examples,
            cardId,
            uid,
            onComplete: (exampleAudio) => {
              updateCards?.(prev => prev?.map(c => c.id === cardId ? { ...c, exampleAudio } : c) ?? prev);
            },
          });
        }
      }
    }
    if ('compareTo' in updates) {
      const currentTerm = entries.find(e => e.id === id)?.glossaryTerm || '';
      setTimeout(() => syncCompareTo(id, updates.compareTo, currentTerm), 0);
    }
    // When mastery level changes, adjust the linked card's nextDueDate to match the new floor.
    if ('masteryLevel' in updates && getCardNextDueDate && onCardNextDueDateChanged) {
      const cardId = cardMap[id];
      if (cardId) {
        const newMastery         = updates.masteryLevel;
        const oldMastery         = entries.find(e => e.id === id)?.masteryLevel || 'introduced';
        const currentNextDueDate = getCardNextDueDate(cardId);

        let newNextDueDate = currentNextDueDate; // default: no change

        if (!currentNextDueDate) {
          // Card has never been studied — leave nextDueDate unset, card stays in selectable index.
          newNextDueDate = null;
        } else if (newMastery === 'introduced') {
          // Demoting to Introduced: remove from due queue entirely.
          newNextDueDate = null;
        } else {
          const newFloor  = MASTERY_FLOORS[newMastery] || 5;
          const oldFloor  = MASTERY_FLOORS[oldMastery] || 0;
          const floorDate = new Date();
          floorDate.setDate(floorDate.getDate() + newFloor);
          const floorStr = floorDate.toISOString().split('T')[0];

          if (newFloor > oldFloor) {
            // Promotion: push nextDueDate out to the new floor only if it's currently sooner.
            newNextDueDate = currentNextDueDate < floorStr ? floorStr : currentNextDueDate;
          } else {
            // Demotion: always pull nextDueDate in to the new floor.
            newNextDueDate = floorStr;
          }
        }

        if (newNextDueDate !== currentNextDueDate) {
          await updateDoc(doc(db, 'users', uid, 'flashcards', cardId), { nextDueDate: newNextDueDate });
          onCardNextDueDateChanged(cardId, newNextDueDate);
        }
      }
    }
  }, [entries, cardMap, syncCompareTo, updateCache, getCardNextDueDate, onCardNextDueDateChanged, updateCards]);

  // Link/unlink a content section to a grammar entry bidirectionally.
  // add=true links, add=false unlinks.
  const handleLinkSection = useCallback(async (section, entryId, add) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const current = section.glossaryTermIds || [];
    const next = add
      ? (current.includes(entryId) ? current : [...current, entryId])
      : current.filter(id => id !== entryId);
    setSections(prev => prev.map(s => s.id === section.id ? { ...s, glossaryTermIds: next } : s));
    try {
      await updateDoc(doc(db, 'users', uid, 'content_sections', section.id), { glossaryTermIds: next });
    } catch (e) {
      console.error('Section link failed:', e);
    }
  }, []);

  const handleDelete = useCallback(async (entryId, cardId) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    // Find the entry being deleted so we know its term and number
    const deleted = entries.find(e => e.id === entryId);
    const deletedTerm   = deleted?.glossaryTerm || '';
    const deletedNumber = deleted?.entryNumber  || 0;

    try {
      await deleteDoc(doc(db, 'users', uid, 'grammar_entries', entryId));
      if (cardId) await deleteDoc(doc(db, 'users', uid, 'flashcards', cardId));
    } catch (e) {
      console.error('Delete entry failed:', e);
    }

    // Remove from local state first
    const remaining = entries.filter(e => e.id !== entryId);

    // 1. Clean up compareTo references to the deleted term
    for (const other of remaining) {
      const chips = cleanChips(other.compareTo || '');
      const hasRef = chips.some(c => c.toLowerCase().trim() === deletedTerm.toLowerCase().trim());
      if (hasRef) {
        const next = chips.filter(c => c.toLowerCase().trim() !== deletedTerm.toLowerCase().trim()).join(' | ');
        try {
          await updateDoc(doc(db, 'users', uid, 'grammar_entries', other.id), { compareTo: next });
        } catch (e) {
          console.error('compareTo cleanup failed for', other.id, e);
        }
      }
    }

    // 2. Renumber entries that had a higher entryNumber than the deleted one
    const toRenumber = remaining.filter(e => (e.entryNumber || 0) > deletedNumber);
    for (const other of toRenumber) {
      const newNum = (other.entryNumber || 0) - 1;
      try {
        await updateDoc(doc(db, 'users', uid, 'grammar_entries', other.id), { entryNumber: newNum });
      } catch (e) {
        console.error('Renumber failed for', other.id, e);
      }
    }

    // Update local state all at once
    setEntries(() => {
      const next = remaining.map(e => {
        const chips = cleanChips(e.compareTo || '');
        const hasRef = chips.some(c => c.toLowerCase().trim() === deletedTerm.toLowerCase().trim());
        const nextCompareTo = hasRef
          ? chips.filter(c => c.toLowerCase().trim() !== deletedTerm.toLowerCase().trim()).join(' | ')
          : e.compareTo;
        const nextNumber = (e.entryNumber || 0) > deletedNumber
          ? (e.entryNumber || 0) - 1
          : e.entryNumber;
        return { ...e, compareTo: nextCompareTo, entryNumber: nextNumber };
      });
      updateCache(next);
      return next;
    });
    setCardMap(prev => { const next = { ...prev }; delete next[entryId]; return next; });
    setSelected(null); setPanelOpen(false);
  }, [entries, updateCache]);

  const handleRename = useCallback(async (entryId, newTerm) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const oldTerm = entries.find(e => e.id === entryId)?.glossaryTerm || '';
    await updateDoc(doc(db, 'users', uid, 'grammar_entries', entryId), { glossaryTerm: newTerm });
    setEntries(prev => {
      const next = prev.map(e => e.id === entryId ? { ...e, glossaryTerm: newTerm } : e);
      updateCache(next);
      return next;
    });
    setSelected(prev => prev?.id === entryId ? { ...prev, glossaryTerm: newTerm } : prev);
    // Update the linked flashcard's front too
    const cardId = cardMap[entryId];
    if (cardId) {
      await updateDoc(doc(db, 'users', uid, 'flashcards', cardId), { front: newTerm });
      // Keep in-memory cards in sync so the next session sees the new title immediately.
      updateCards?.(prev => prev?.map(c => c.id === cardId ? { ...c, front: newTerm } : c) ?? prev);
    }
    // Propagate rename into all other entries' compareTo that reference the old term
    for (const other of entries) {
      if (other.id === entryId) continue;
      const chips = cleanChips(other.compareTo || '');
      const idx = chips.findIndex(c => c.toLowerCase().trim() === oldTerm.toLowerCase().trim());
      if (idx !== -1) {
        chips[idx] = newTerm;
        const next = chips.join(' | ');
        try {
          await updateDoc(doc(db, 'users', uid, 'grammar_entries', other.id), { compareTo: next });
        } catch (e) {
          console.error('compareTo rename sync failed for', other.id, e);
        }
        setEntries(prev => prev.map(e => e.id === other.id ? { ...e, compareTo: next } : e));
      }
    }
  }, [entries, cardMap, updateCache, updateCards]);

  const handleCreate = useCallback(async (fields) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const maxNum      = entries.reduce((m, e) => Math.max(m, e.entryNumber || 0), 0);
    const entryNumber = maxNum + 1;
    const entryId     = `grammar_${entryNumber}`;
    await updateDoc(doc(db, 'users', uid, 'grammar_entries', entryId), {
      ...fields, entryNumber, createdAt: new Date().toISOString(),
    }).catch(async () => {
      const { setDoc } = await import('firebase/firestore');
      await setDoc(doc(db, 'users', uid, 'grammar_entries', entryId), {
        ...fields, entryNumber, createdAt: new Date().toISOString(),
      });
    });
    const cardRef = await addDoc(collection(db, 'users', uid, 'flashcards'), {
      type: 'grammar', front: fields.glossaryTerm, back: fields.compareTo || '', notes: '',
      deckIds: [GRAMMAR_DECK_ID], linkedGrammarEntryId: entryId, linkedAVILemmaId: null,
      easeFactor: 2.5, interval: 1, repetitions: 0,
      nextDueDate: null, // Set only after the card's first review in the Grammar Deck session.
      lastGrade: null, lastReviewed: null, gapEvents: [],
      triageBucket: null, lastTriageDate: null, createdAt: new Date().toISOString(),
    });
    const newEntry = { id: entryId, ...fields, entryNumber, createdAt: new Date().toISOString() };
    setEntries(prev => {
      const next = [...prev, newEntry].sort((a, b) => (a.entryNumber || 0) - (b.entryNumber || 0));
      updateCache(next);
      return next;
    });
    setCardMap(prev => ({ ...prev, [entryId]: cardRef.id }));
    setShowNewForm(false);
    setSelected(newEntry);
    setPanelOpen(true);
  }, [entries, updateCache]);

  // Add question: create a question-tagged note linked to this grammar entry
  const handleAddQuestion = useCallback(async (entry) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const now     = new Date().toISOString();
    const payload = {
      title:            `Q: ${entry.glossaryTerm}`,
      body:             '',
      tags:             ['question'],
      linkedGrammarIds: [entry.id],
      createdAt:        now,
      updatedAt:        now,
      type:             'note',
    };
    const ref     = await addDoc(collection(db, 'users', uid, 'notes'), payload);
    const newNote = { id: ref.id, ...payload };
    setNotes(prev => [newNote, ...prev]);
    // Navigate to the note editor
    onNavigateToNote && onNavigateToNote(ref.id);
  }, [onNavigateToNote]);

  const visible = useMemo(() => {
    let list = entries;
    if (filter !== 'all') list = list.filter(e => e.masteryLevel === filter);
    if (search.trim()) {
      const q  = search.trim().toLowerCase();
      const normalize = s => s.toLowerCase().replace(/^[~\s]+/, '').replace(/[()[\]]/g, '');
      const nq = normalize(q);
      list = list
        .map(e => {
          const raw = e.glossaryTerm?.toLowerCase() || '';
          const n   = normalize(raw);
          let score = 0;
          if (n === nq || raw === q)                                            score = 4; // exact normalized
          else if (n.startsWith(nq))                                            score = 3; // prefix
          else if (n.includes(nq))                                              score = 2; // contains
          else if (e.compareTo?.toLowerCase().includes(q))                     score = 1; // compareTo match
          else                                                                  score = 0;
          return { e, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || (a.e.entryNumber || 0) - (b.e.entryNumber || 0))
        .map(x => x.e);
    }
    return list;
  }, [entries, filter, search]);

  // Reset to page 0 whenever the filtered set changes shape.
  useEffect(() => { setGrammarPage(0); }, [filter, search]);

  const grammarTotalPages  = Math.ceil(visible.length / GRAMMAR_PAGE_SIZE);
  const grammarPageClamped = Math.min(grammarPage, Math.max(0, grammarTotalPages - 1));
  const pagedVisible       = visible.slice(grammarPageClamped * GRAMMAR_PAGE_SIZE, (grammarPageClamped + 1) * GRAMMAR_PAGE_SIZE);

  const counts = useMemo(() => {
    const c = { all: entries.length, introduced: 0, practicing: 0, confident: 0, mastered: 0 };
    entries.forEach(e => { if (c[e.masteryLevel] !== undefined) c[e.masteryLevel]++; });
    return c;
  }, [entries]);

  // Lift mastery counts to App so FlashcardsPage grammar deck card can display them.
  useEffect(() => {
    if (onMasteryCounts) onMasteryCounts(counts);
  }, [counts, onMasteryCounts]);

  // Lift the full entries array to App so the Grammar Deck picker in FlashcardsPage
  // has live data even before this page has mounted in the current session.
  useEffect(() => {
    if (onEntriesChange) onEntriesChange(entries);
  }, [entries, onEntriesChange]);

  // ↑/↓ navigate entries with cross-page support; Escape closes the detail panel.
  // No-ops automatically when focus is in the search box or any inline edit input.
  useGlobalKey(e => {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') { if (panelOpen) setPanelOpen(false); else setSelected(null); return; }

    const currentIdx = pagedVisible.findIndex(en => en.id === selected?.id);

    if (e.key === 'ArrowDown') {
      if (currentIdx < pagedVisible.length - 1) {
        // Within the current page
        setSelected(pagedVisible[currentIdx + 1]);
        setShowNewForm(false);
      } else if (grammarPageClamped < grammarTotalPages - 1) {
        // Fall off the bottom — cross to next page and land on its first entry
        const nextPage = grammarPageClamped + 1;
        const firstEntry = visible[nextPage * GRAMMAR_PAGE_SIZE];
        if (firstEntry) { setGrammarPage(nextPage); setSelected(firstEntry); setShowNewForm(false); }
      }
      // else: last entry of last page — clamp (no-op)
    } else {
      if (currentIdx > 0) {
        // Within the current page
        setSelected(pagedVisible[currentIdx - 1]);
        setShowNewForm(false);
      } else if (currentIdx === 0 && grammarPageClamped > 0) {
        // Fall off the top — cross to previous page and land on its last entry
        const prevPage = grammarPageClamped - 1;
        const prevSlice = visible.slice(prevPage * GRAMMAR_PAGE_SIZE, (prevPage + 1) * GRAMMAR_PAGE_SIZE);
        const lastEntry = prevSlice[prevSlice.length - 1];
        if (lastEntry) { setGrammarPage(prevPage); setSelected(lastEntry); setShowNewForm(false); }
      } else if (currentIdx === -1) {
        // Nothing selected — ArrowUp lands on the last row of the current page
        const last = pagedVisible[pagedVisible.length - 1];
        if (last) { setSelected(last); setShowNewForm(false); }
      }
      // else: first entry of first page — clamp (no-op)
    }
  }, { enabled: pagedVisible.length > 0 });

  // ←/→ paginate the entry list; disabled while the new-entry form is open.
  // Re-anchors `selected` to the first entry of the new page on navigation.
  usePaginationKeys({
    page:       grammarPageClamped,
    totalPages: grammarTotalPages,
    setPage: (newPage) => {
      setGrammarPage(newPage);
      listScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    },
    enabled: !showNewForm && pagedVisible.length > 0,
  });

  // Scroll the selected row into view after every selection change.
  // Kept here rather than inline in the keydown handler so it always runs after
  // React has re-rendered — critical for cross-page moves where the target DOM
  // node doesn't exist yet at the moment the key fires.
  useEffect(() => {
    if (!selected) return;
    listScrollRef.current
      ?.querySelector(`[data-entry-id="${selected.id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected?.id]);

  const FILTERS = [
    { id: 'all',        label: 'All' },
    { id: 'introduced', label: 'Introduced' },
    { id: 'practicing', label: 'Practicing' },
    { id: 'confident',  label: 'Confident' },
    { id: 'mastered',   label: 'Mastered' },
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', color: C.textM, fontSize: '13px' }}>
        Loading grammar entries…
      </div>
    );
  }

  if (selectMode) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 74px)', overflow: 'hidden', margin: '-28px', padding: '28px', position: 'relative' }}>
        {/* Crow — same column width birb gets elsewhere; bottom-anchored since
            its aspect ratio is shorter than birb's, so the gap lands above it
            instead of below, keeping the bottom edges lined up. */}
        {!isMobile && (
          <div style={{
            position: 'absolute', top: 0, right: 0, bottom: 0,
            width: 'calc(100% / 3)', display: 'flex', alignItems: 'flex-end',
            pointerEvents: 'none', zIndex: 0,
          }}>
            {crowSrc
              ? <img src={crowSrc} alt="" aria-hidden="true" style={{ width: '100%', height: 'auto', display: 'block', opacity: 0.92 }} />
              : <div style={{ ...decoBlockStyle(C), width: '100%', aspectRatio: '3 / 4', opacity: 0.5 }} />}
          </div>
        )}
        <div style={{ marginBottom: '16px', flexShrink: 0, position: 'relative', zIndex: 1 }}>
          <span style={{ fontFamily: SH.fd, fontSize: '20px', color: C.text }}>Select cards to study</span>
        </div>
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative', zIndex: 1, maxWidth: '560px' }}>
          <GrammarCardPicker
            mode="inline"
            entries={entries}
            cards={cards}
            onStudySelected={(cardIds) => { setSelectMode(false); onNavigateToFlashcard && onNavigateToFlashcard(cardIds); }}
            onClose={() => setSelectMode(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: isMobile ? '100vh' : 'calc(100vh - 74px)', overflow: 'hidden', margin: '-28px', position: 'relative' }}>

      {/* Crow — reserved-space column on the right, same width birb gets
          elsewhere. The detail/new-entry panels render at zIndex 1 and cover
          this whenever one is open. */}
      {!isMobile && (
        <div style={{
          position: 'absolute', top: 0, right: 0, bottom: 0,
          width: 'calc(100% / 3)', display: 'flex', alignItems: 'flex-end',
          pointerEvents: 'none', zIndex: 0,
        }}>
          {crowSrc
            ? <img src={crowSrc} alt="" aria-hidden="true" style={{ width: '100%', height: 'auto', display: 'block', opacity: 0.92 }} />
            : <div style={{ ...decoBlockStyle(C), width: '100%', aspectRatio: '3 / 4', opacity: 0.5 }} />}
        </div>
      )}

      {/* Left: list — sits above the image */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', zIndex: 1 }}>
        <div style={{ padding: '24px 28px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
            {/* Search input with count inside */}
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                type="text" placeholder={isMobile ? 'Search' : 'Search grammar patterns…'} value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ ...S.formInput, fontSize: '13px', paddingRight: isMobile ? '12px' : '72px', marginBottom: 0 }}
              />
              {!isMobile && (
                <span style={{
                  position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                  fontFamily: SH.fm, fontSize: '11px', color: C.textM, pointerEvents: 'none',
                }}>
                  {visible.length} / {entries.length}
                </span>
              )}
            </div>
            <button style={{ ...S.btnGhost, flexShrink: 0 }} onClick={() => { setSelected(null); setPanelOpen(false); setShowNewForm(false); setSelectMode(true); }}>
              Select to study
            </button>
            <button style={{ ...S.btnPrimary, ...S.btnMetallic, flexShrink: 0 }} onClick={() => { setSelected(null); setPanelOpen(false); setShowNewForm(true); }}>
              + New entry
            </button>
          </div>

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '16px', paddingBottom: '16px', borderBottom: `1px solid ${C.border}` }}>
            {FILTERS.map(f => {
              const active = filter === f.id;
              const color  = f.id !== 'all' ? MASTERY[f.id]?.color : C.accent;
              return (
                <button key={f.id} onClick={() => setFilter(f.id)} style={{
                  padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500,
                  border: `1px solid ${active ? (color || C.accent) : C.border}`,
                  background: active ? `${color || C.accent}22` : 'transparent',
                  color: active ? (color || C.accent) : C.textS,
                  cursor: 'pointer', transition: 'all 0.15s',
                }}>
                  {f.label}
                  <span style={{ marginLeft: '5px', opacity: 0.6, fontSize: '11px' }}>{counts[f.id] ?? 0}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 28px 28px', paddingBottom: isMobile ? '88px' : '28px' }}>
          <div ref={listScrollRef} style={{ flex: 1, overflowY: 'auto' }}>
            {visible.length === 0 ? (
              <div style={S.emptyState}>No entries match your search.</div>
            ) : (
              <div style={{ border: `1px solid ${C.border}`, borderRadius: '0', overflow: 'hidden' }}>
                {pagedVisible.map((entry, idx) => {
                  const mastery      = MASTERY[entry.masteryLevel] || MASTERY.introduced;
                  const isActive     = selected?.id === entry.id;
                  const compareChips = cleanChips(entry.compareTo).slice(0, 3);
                  return (
                    <div
                      key={entry.id}
                      data-entry-id={entry.id}
                                            onClick={() => { setShowNewForm(false); setSelected(entry); setPanelOpen(true); }}
                      style={{
                        display: 'flex', flexDirection: 'column', gap: '6px', padding: '11px 16px',
                        borderBottom: idx < pagedVisible.length - 1 ? `1px solid ${C.border}` : 'none',
                        background: isActive ? C.accentSoft : 'transparent',
                        cursor: 'pointer', transition: 'background 0.15s',
                      }}
                      className="task-row"
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                        <span style={{ fontFamily: SH.fm, fontSize: '11px', color: C.textM, minWidth: '28px', flexShrink: 0 }}>
                          {entry.entryNumber}
                        </span>
                        <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: mastery.color, flexShrink: 0 }} />
                        <span style={{ fontFamily: SH.fk, fontSize: '14px', fontWeight: 500, color: C.text }}>
                          {entry.glossaryTerm}
                        </span>
                      </div>
                      {compareChips.length > 0 && (
                        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', paddingLeft: '63px' }}>
                          {compareChips.map((c, i) => (
                            <span key={i} style={{
                              padding: '2px 8px', borderRadius: '10px', fontSize: '11px',
                              border: `1px solid ${C.border}`, color: C.textM, fontFamily: SH.fk,
                            }}>{c}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {visible.length > 0 && (
            <PaginationFooter
              page={grammarPageClamped}
              totalPages={grammarTotalPages}
              count={visible.length}
              onFirst={() => { setGrammarPage(0); listScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
              onPrev={() => { setGrammarPage(grammarPageClamped - 1); listScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
              onNext={() => { setGrammarPage(grammarPageClamped + 1); listScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
              onLast={() => { setGrammarPage(grammarTotalPages - 1); listScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
              C={C}
            />
          )}
        </div>
      </div>

      {(!selected || !panelOpen) && !showNewForm && !isMobile && (
        <div style={{ width: 'calc(100% / 3)', flexShrink: 0 }} aria-hidden="true" />
      )}

      {/* Right: new entry form */}
      {showNewForm && (
        <div style={{ position: 'relative', zIndex: 1, height: '100%', overflow: 'hidden' }}>
          <NewEntryForm
            onSave={handleCreate}
            onCancel={() => setShowNewForm(false)}
            entryCount={entries.length}
            allEntries={entries}
            C={C} S={S}
          />
        </div>
      )}

      {/* Right: detail panel */}
      {selected && panelOpen && !showNewForm && (
        <div style={{ position: 'relative', zIndex: 1, height: '100%', overflow: 'hidden' }}>
          <EntryDetail
            entry={selected}
            allEntries={entries}
            linkedCardId={cardMap[selected.id] || null}
            linkedCard={cards?.find(c => c.id === cardMap[selected.id]) || null}
            linkedNotes={notes.filter(n => (n.linkedGrammarIds || []).includes(selected.id))}
            linkedSections={sections.filter(s => (s.glossaryTermIds || []).includes(selected.id))}
            allSections={sections}
            onClose={() => setPanelOpen(false)}
            onSave={handleSave}
            onDelete={handleDelete}
            onRename={handleRename}
            onLinkSection={handleLinkSection}
            onNavigateToCard={onNavigateToFlashcard}
            onNavigateToNote={onNavigateToNote}
            onNavigateToContent={onNavigateToContent}
            onNavigateToEntry={(entry) => { setSelected(entry); }}
            onAddQuestion={handleAddQuestion}
            C={C} S={S}
          />
        </div>
      )}
    </div>
  );
}
