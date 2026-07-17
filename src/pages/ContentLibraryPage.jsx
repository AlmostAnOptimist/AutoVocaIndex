// src/pages/ContentLibraryPage.jsx
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { collection, getDocs, getDoc, setDoc, doc, updateDoc, addDoc, deleteDoc, writeBatch, arrayRemove, query, where } from 'firebase/firestore';
import { db, auth } from '../firebase.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { Icons } from '../components/Icons.jsx';
import { DatePicker } from '../components/DatePicker.jsx';
import { playSound } from '../utils/soundEngine.js';
import { toDateStr, getLogicalToday, getLogicalDateStr } from '../utils/dateUtils.js';
import { fmtApptDate, fmtTime } from '../components/AppointmentModal.jsx';
import { NotesPage } from './NotesPage.jsx';
import { ContentLibraryGazette } from '../components/ContentLibraryGazette.jsx';
import { decoDividerSrc, decoBlockStyle } from '../utils/decoAssets.js';
import { useGlobalKey } from '../hooks/useGlobalKey.js';
import { TYPES, TYPE_FAMILY_MAP, typeColor, getSourceStatus, isPassiveMediaExcluded } from '../utils/contentUtils.js';

// ── Family grouping (D1) ──────────────────────────────────────
const FAMILY_ORDER    = ['grammar', 'reading', 'listening', 'reference'];
const FAMILY_LABELS   = { grammar: 'Grammar', reading: 'Reading', listening: 'Listening', reference: 'Reference' };
// Per-type tags shown inside grouped reading/listening families
const TYPE_SHORT_LABELS = {
  'Reading: Bilingual':   'Bilingual',
  'Reading: Korean Only': 'KO only',
  'Dubbed':               'Dubbed',
  'Subbed':               'Subbed',
  'Native':               'Native',
};
// Filter chips: reading/listening condensed to one family chip each
const FILTER_CHIPS = [
  { id: 'all',               label: 'All' },
  { id: 'family:grammar',    label: 'Grammar' },
  { id: 'family:reading',    label: 'Reading' },
  { id: 'family:listening',  label: 'Listening' },
  { id: 'Reference',         label: 'Reference' },
];
const FAMILY_CHIP_COLORS = { grammar: '#F5C842', reading: '#D96B6B', listening: '#2ABFBF' };
function chipColor(id, C) {
  if (id === 'all') return C.accent;
  if (id.startsWith('family:')) return FAMILY_CHIP_COLORS[id.slice(7)] || '#888';
  return typeColor(id);
}
function matchesTypeFilter(source, filter) {
  if (filter === 'all') return true;
  if (filter.startsWith('family:')) return TYPE_FAMILY_MAP[source.type] === filter.slice(7);
  return source.type === filter;
}
function familyOf(source) { return TYPE_FAMILY_MAP[source.type] || 'reference'; }
function familySortIndex(source) {
  const i = FAMILY_ORDER.indexOf(familyOf(source));
  return i === -1 ? FAMILY_ORDER.length : i;
}

export const CONTENT_SUBTYPES = {
  'Grammar':              ['Textbook', 'Website', 'App', 'Other'],
  'Grammar: Practice':    ['Workbook', 'Worksheet', 'Other'],
  'Reading: Bilingual':   ['Novel', 'Script', 'Short Story', 'Webtoon', 'Article', 'Textbook', 'Game', 'Other'],
  'Reading: Korean Only': ['Novel', 'Script', 'Short Story', 'Webtoon', 'Article', 'Textbook', 'Game', 'Other'],
  'Dubbed':               ['Drama', 'Movie', 'YouTube', 'Variety Show', 'Documentary', 'Animation', 'Other'],
  'Subbed':               ['Drama', 'Movie', 'YouTube', 'Variety Show', 'Documentary', 'Animation', 'Other'],
  'Native':               ['Drama', 'Movie', 'YouTube', 'Variety Show', 'Documentary', 'Animation', 'Podcast', 'Lecture', 'Other'],
  'Reference':            ['Word List', 'Website', 'Other'],
};
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'Unsure', 'Native'];
const STUDY_INTENTS = [
  { value: 'grammar', label: 'Study' },
  { value: 'mining',  label: 'Vocab mining'  },
  { value: 'casual',  label: 'Casual input'  },
];
const CL_TAB_KEY             = 'avi_cl_tab';
const SECTIONS_MIGRATION_KEY = 'sectionsContentMigrated';

// Truncate source title to 13 chars for task titles
export function sectionTaskTitle(sourceTitle, sectionContent) {
  const cap       = 13;
  const truncated = (sourceTitle || '').length <= cap
    ? (sourceTitle || '')
    : (sourceTitle || '').slice(0, cap).trimEnd();
  return truncated ? `${truncated} ${sectionContent}` : String(sectionContent);
}

// Shared status → colour helper
const STATUS_COLOR_KEYS = {
  'Done': 'success', 'In Progress': 'warning', 'In progress': 'warning',
  'Scheduled': 'accent', 'Not started': 'textM', 'Skip': 'textM',
};
function statusColor(status, C) {
  const key = STATUS_COLOR_KEYS[status];
  if (!key) return C.textM;
  return C[key] || (key === 'success' ? '#5ba05b' : key === 'warning' ? '#e0a030' : C.textM);
}

// ── Progress bar ───────────────────────────────────────────────
function ProgressBar({ done, total, skipped, realTotal, color, soundProfile }) {
  const { C } = useAppTheme();
  const prevDone = useRef(done);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  useEffect(() => {
    if (done > prevDone.current && done === total && total > 0 && soundProfile) playSound('complete', soundProfile);
    prevDone.current = done;
  }, [done, total, soundProfile]);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
        <span style={{ fontSize: '11px', fontFamily: SH.fm, color: C.textM }}>
          {done} / {total}{skipped > 0 && <span style={{ opacity: 0.55 }}> (+{skipped} skipped)</span>}
        </span>
        <span style={{ fontSize: '11px', fontFamily: SH.fm, color: C.textM }}>{pct}%</span>
      </div>
      {/* (j) 0% renders the type dot; any progress grows the bar from the same origin */}
      <div style={{ height: '7px', display: 'flex', alignItems: 'center' }}>
        {pct === 0 ? (
          <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: color || C.accent, flexShrink: 0 }} />
        ) : (
          <div style={{ flex: 1, height: '4px', background: C.bg, borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: color || C.accent, borderRadius: '2px', transition: 'width 0.3s ease' }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Editable title ─────────────────────────────────────────────
function EditableTitle({ value, url, onSave, style }) {
  const { C, S } = useAppTheme();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(value);
  const [draftUrl,   setDraftUrl]   = useState(url || '');
  const inputRef = useRef(null);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);
  useEffect(() => { setDraftTitle(value); }, [value]);
  useEffect(() => { setDraftUrl(url || ''); }, [url]);
  const open  = e => { e.stopPropagation(); setDraftTitle(value); setDraftUrl(url || ''); setEditing(true); };
  const close = e => { e.stopPropagation(); setEditing(false); };
  const save  = e => {
    e.stopPropagation();
    if (draftTitle.trim()) onSave(draftTitle.trim(), draftUrl.trim());
    setEditing(false);
  };
  if (editing) {
    return (
      <div onClick={e => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1 }}>
        <input ref={inputRef} value={draftTitle} onChange={e => setDraftTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(e); if (e.key === 'Escape') close(e); }}
          style={{ fontSize: style?.fontSize || '13px', fontWeight: style?.fontWeight, padding: '2px 6px', borderRadius: '6px', border: `1px solid ${C.accent}`, background: C.bg, color: C.text, outline: 'none', width: '100%' }} placeholder="Title…" />
        <input value={draftUrl} onChange={e => setDraftUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(e); if (e.key === 'Escape') close(e); }}
          style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.bg, color: C.textM, outline: 'none', width: '100%' }} placeholder="URL (optional)…" />
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onMouseDown={save} style={{ ...S.btnPrimary, fontSize: '11px', padding: '2px 10px', borderRadius: '6px' }}>Save</button>
          <button onMouseDown={close} style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    );
  }
  const titleEl = url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
      style={{ ...style, color: style?.color || C.accent, textDecoration: 'none' }}>{value}</a>
  ) : <span style={style}>{value}</span>;
  return (
    <span style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', flex: 1, minWidth: 0 }}>
      {titleEl}
      <span onClick={open} title="Edit title / URL"
        style={{ fontSize: '10px', color: C.textM, cursor: 'pointer', opacity: 0, flexShrink: 0, lineHeight: 1, transition: 'opacity 0.15s' }}
        className="edit-pencil">✎</span>
    </span>
  );
}

// ── Section detail panel ───────────────────────────────────────
// isSourceLevel=true → section-less source: corrections are auto-linked (no search),
//   notes are linked to the source itself, no delete button.
// isSourceLevel=false (default) → regular section: per-section linking.
function SectionDetailPanel({ sec, grammarEntries, allNotes, correctionSessions, isSourceLevel,
  onSectionFieldSave, onNavigateToGrammar, onNavigateToNote, onNavigateToCorrection,
  onToggleNoteLink, onDeleteSection, C, S }) {

  const [note,          setNote]          = useState(sec.sectionNote || '');
  const [noteSearch,    setNoteSearch]    = useState('');
  const [corrSearch,    setCorrSearch]    = useState('');
  const [gramSearch,    setGramSearch]    = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [noteSearchFocused, setNoteSearchFocused] = useState(false);

  useEffect(() => { setNote(sec.sectionNote || ''); }, [sec.id]);

  const linkedNoteIds     = sec.linkedNoteIds          || [];
  const linkedGramIds     = sec.glossaryTermIds         || [];
  const linkedCorrNoteIds = sec.linkedCorrectionNoteIds || [];
  const sourceId          = sec.resourceId ?? sec.id;

  // Corrections for this item: auto-linked for source-level, explicit for sections
  const displayedCorrs = isSourceLevel
    ? (correctionSessions || []).filter(c => c.sourceId === sourceId)
    : linkedCorrNoteIds.map(id => (correctionSessions || []).find(c => c.id === id)).filter(Boolean);

  const corrSearchPool = isSourceLevel
    ? []
    : (correctionSessions || []).filter(c => c.sourceId === sourceId);

  // Generic toggle for grammar and correction note links (NOT notes — those use onToggleNoteLink)
  const toggleLink = (field, id) => {
    const current = sec[field] || [];
    const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id];
    onSectionFieldSave(sec, { [field]: next });
  };

  const filteredNotes = useMemo(() => {
    const q = noteSearch.trim().toLowerCase();
    const pool = allNotes || [];
    if (!q) return noteSearchFocused ? pool.slice(0, 8) : [];
    return pool.filter(n => n.title?.toLowerCase().includes(q) || n.tags?.some(t => t.toLowerCase().includes(q))).slice(0, 8);
  }, [noteSearch, noteSearchFocused, allNotes]);

  const filteredCorr = useMemo(() => {
    if (isSourceLevel) return [];
    const q = corrSearch.trim().toLowerCase();
    if (!q) return [];
    return corrSearchPool.filter(c =>
      c.title?.toLowerCase().includes(q) || c.sourceLabel?.toLowerCase().includes(q)
    ).slice(0, 5);
  }, [corrSearch, corrSearchPool, isSourceLevel]);

  const filteredGram = useMemo(() => {
    const q = gramSearch.trim().toLowerCase();
    if (!q) return [];
    const normalize = s => s.toLowerCase().replace(/^[~\s]+/, '').replace(/[()[\]]/g, '');
    const nq = normalize(q);
    return (grammarEntries || [])
      .map(e => { const n = normalize(e.glossaryTerm || ''); const score = n === nq ? 3 : n.startsWith(nq) ? 2 : n.includes(nq) ? 1 : 0; return { e, score }; })
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.e).slice(0, 5);
  }, [gramSearch, grammarEntries]);

  const labelStyle = { fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '6px', display: 'block' };
  const chipBase   = { display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', cursor: 'pointer' };
  const corrLabel  = c => c.title || c.sourceLabel || 'Correction';

  return (
    <div onClick={e => e.stopPropagation()} style={{ padding: '10px 16px 14px 42px', borderTop: `1px solid ${C.border}`, background: `${C.accent}06`, display: 'flex', flexDirection: 'column', gap: '12px' }}>

      {/* Comments */}
      <div>
        <label style={labelStyle}>Comments</label>
        <textarea value={note} onChange={e => setNote(e.target.value)}
          onBlur={() => { if (note !== (sec.sectionNote || '')) onSectionFieldSave(sec, { sectionNote: note }); }}
          placeholder="Reflections on this section…"
          style={{ ...S.formInput, fontSize: '12px', minHeight: '56px', resize: 'vertical', lineHeight: 1.5, margin: 0 }} />
      </div>

      {/* Grammar */}
      <div>
        <label style={labelStyle}>Grammar</label>
        {linkedGramIds.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '6px' }}>
            {linkedGramIds.map(id => {
              const entry = (grammarEntries || []).find(e => e.id === id);
              if (!entry) return null;
              return (
                <span key={id} style={{ ...chipBase, border: `1px solid ${C.accent}55`, color: C.accent, background: C.accentSoft, fontFamily: SH.fk }}>
                  <span onClick={() => onNavigateToGrammar?.(id)} style={{ cursor: 'pointer' }}>{entry.glossaryTerm}</span>
                  <button onClick={() => toggleLink('glossaryTermIds', id)} style={{ color: C.accent, fontSize: '11px', lineHeight: 1, padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
                </span>
              );
            })}
          </div>
        )}
        <input style={{ ...S.formInput, fontSize: '12px', margin: 0, padding: '4px 8px' }} placeholder="Search grammar patterns…"
          value={gramSearch} onChange={e => setGramSearch(e.target.value)} />
        {filteredGram.length > 0 && (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden', marginTop: '3px', background: C.raised }}>
            {filteredGram.map(entry => (
              <div key={entry.id} onClick={() => { toggleLink('glossaryTermIds', entry.id); setGramSearch(''); }}
                style={{ padding: '6px 10px', cursor: 'pointer', fontSize: '12px', color: linkedGramIds.includes(entry.id) ? C.accent : C.text, background: linkedGramIds.includes(entry.id) ? C.accentSoft : 'transparent', fontFamily: SH.fk, borderBottom: `1px solid ${C.border}` }}
                className="task-row">
                {entry.glossaryTerm}
                {linkedGramIds.includes(entry.id) && <span style={{ marginLeft: '8px', fontSize: '10px', color: C.accent }}>linked</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Notes */}
      <div>
        <label style={labelStyle}>Notes</label>
        {linkedNoteIds.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '6px' }}>
            {linkedNoteIds.map(id => {
              const n = (allNotes || []).find(x => x.id === id);
              if (!n) return null;
              return (
                <span key={id} style={{ ...chipBase, border: `1px solid ${C.border}`, color: C.text, background: C.bg }}>
                  <span onClick={() => onNavigateToNote?.(id)} style={{ cursor: 'pointer' }}>{n.title || 'Untitled'}</span>
                  <button onClick={() => onToggleNoteLink?.(sec, id)} style={{ color: C.textM, fontSize: '11px', lineHeight: 1, padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
                </span>
              );
            })}
          </div>
        )}
        <input style={{ ...S.formInput, fontSize: '12px', margin: 0, padding: '4px 8px' }} placeholder="Search notes…"
          value={noteSearch} onChange={e => setNoteSearch(e.target.value)}
          onFocus={() => setNoteSearchFocused(true)} onBlur={() => setTimeout(() => setNoteSearchFocused(false), 150)} />
        {filteredNotes.length > 0 && (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden', marginTop: '3px', background: C.raised }}>
            {filteredNotes.map(n => (
              <div key={n.id} onClick={() => { onToggleNoteLink?.(sec, n.id); setNoteSearch(''); }}
                style={{ padding: '6px 10px', cursor: 'pointer', fontSize: '12px', color: linkedNoteIds.includes(n.id) ? C.accent : C.text, background: linkedNoteIds.includes(n.id) ? C.accentSoft : 'transparent', borderBottom: `1px solid ${C.border}` }}
                className="task-row">
                {n.title || <span style={{ fontStyle: 'italic', color: C.textM }}>Untitled</span>}
                {linkedNoteIds.includes(n.id) && <span style={{ marginLeft: '8px', fontSize: '10px', color: C.accent }}>linked</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Corrections — auto-linked for source-level; explicit for sections */}
      <div>
        <label style={labelStyle}>Corrections</label>
        {displayedCorrs.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '6px' }}>
            {displayedCorrs.map(c => (
              <span key={c.id} style={{ ...chipBase, border: `1px solid ${C.border}`, color: C.text, background: C.bg }}>
                <span onClick={() => onNavigateToCorrection?.(c.id)} style={{ cursor: 'pointer' }}>{corrLabel(c)}</span>
                {!isSourceLevel && (
                  <button onClick={() => toggleLink('linkedCorrectionNoteIds', c.id)} style={{ color: C.textM, fontSize: '11px', lineHeight: 1, padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
                )}
              </span>
            ))}
          </div>
        )}
        {!isSourceLevel && (
          <>
            <input style={{ ...S.formInput, fontSize: '12px', margin: 0, padding: '4px 8px' }} placeholder="Search corrections…"
              value={corrSearch} onChange={e => setCorrSearch(e.target.value)} />
            {filteredCorr.length > 0 && (
              <div style={{ border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden', marginTop: '3px', background: C.raised }}>
                {filteredCorr.map(c => (
                  <div key={c.id} onClick={() => { toggleLink('linkedCorrectionNoteIds', c.id); setCorrSearch(''); }}
                    style={{ padding: '6px 10px', cursor: 'pointer', fontSize: '12px', color: linkedCorrNoteIds.includes(c.id) ? C.accent : C.text, background: linkedCorrNoteIds.includes(c.id) ? C.accentSoft : 'transparent', borderBottom: `1px solid ${C.border}` }}
                    className="task-row">
                    {corrLabel(c)}
                    {linkedCorrNoteIds.includes(c.id) && <span style={{ marginLeft: '8px', fontSize: '10px', color: C.accent }}>linked</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Delete section — hidden at source level */}
      {onDeleteSection && (
        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
          {!confirmDelete ? (
            <button onClick={() => setConfirmDelete(true)}
              style={{ fontSize: '11px', padding: '2px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer', opacity: 0.65 }}>
              Delete section
            </button>
          ) : (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', color: C.textM }}>Delete this section?</span>
              <button onClick={() => onDeleteSection(sec.id)}
                style={{ fontSize: '11px', padding: '2px 10px', borderRadius: '6px', background: '#c0392b', color: '#fff', border: 'none', cursor: 'pointer' }}>Yes</button>
              <button onClick={() => setConfirmDelete(false)}
                style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}>No</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Inline select chip ─────────────────────────────────────────
function InlineSelectChip({ value, options, onSave, label, C }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <select autoFocus defaultValue={value || ''} onClick={e => e.stopPropagation()}
        onChange={e => { onSave(e.target.value); setEditing(false); }}
        onBlur={() => setEditing(false)}
        style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '10px', border: `1px solid ${C.accent}`, background: C.surface, color: C.text, cursor: 'pointer', outline: 'none' }}>
        <option value="">— none —</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <span onClick={e => { e.stopPropagation(); setEditing(true); }}
      style={{
        fontSize: '11px', padding: '2px 9px', borderRadius: '10px', cursor: 'pointer',
        border: value ? `1px solid ${C.accent}55` : `1px solid ${C.border}`,
        color: value ? C.accent : C.textM, background: value ? C.accentSoft : 'transparent',
      }}>
      {value || `+ ${label}`}
    </span>
  );
}

// ── Section list ───────────────────────────────────────────────
function SectionList({ sections, sourceId, sourceTitle, grammarEntries, allNotes, correctionSessions,
  aviWordSectionCounts, aviSentSectionCounts,
  onNavigateToGrammar, onNavigateToNote, onNavigateToCorrection,
  onSectionToggle, onSectionTitleSave, onSchedule, onCycleStatus,
  onSectionFieldSave, onSectionOrderSave, onDeleteSection, onToggleNoteLink,
  onAddNoteFromSection, onAddCorrectionFromSection,
  highlightSectionId, onHighlightClear }) {

  const { C, S } = useAppTheme();
  const [expandedSec,      setExpandedSec]      = useState(null);
  const [confirmingDelete, setConfirmingDelete]  = useState(new Set());
  const [dragIdx,          setDragIdx]           = useState(null);
  const [overIdx,          setOverIdx]           = useState(null);
  const [localOrder,       setLocalOrder]        = useState(null);
  const wasDraggingRef = useRef(false);
  const highlightRef   = useRef(null);

  useEffect(() => { setLocalOrder(null); }, [sections]);

  useEffect(() => {
    if (!highlightSectionId) return;
    setExpandedSec(highlightSectionId);
    if (highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [highlightSectionId]);

  const orderedSections = localOrder
    ? localOrder.map(id => sections.find(s => s.id === id)).filter(Boolean)
    : sections;

  const handleDragStart = (e, idx) => { wasDraggingRef.current = false; setDragIdx(idx); e.dataTransfer.effectAllowed = 'move'; };
  const handleDragOver  = (e, idx) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    if (idx === overIdx) return;
    setOverIdx(idx);
    const ids = orderedSections.map(s => s.id);
    const moved = ids.splice(dragIdx, 1)[0]; ids.splice(idx, 0, moved);
    setLocalOrder(ids); setDragIdx(idx);
  };
  const handleDrop    = e => { e.preventDefault(); if (localOrder) onSectionOrderSave(sourceId, localOrder); setDragIdx(null); setOverIdx(null); };
  const handleDragEnd = ()  => { wasDraggingRef.current = true; setDragIdx(null); setOverIdx(null); setTimeout(() => { wasDraggingRef.current = false; }, 80); };

  if (!sections.length) return <div style={{ padding: '16px', fontSize: '12px', color: C.textM, fontStyle: 'italic', textAlign: 'center' }}>No sections.</div>;

  return (
    <div>
      {orderedSections.map((sec, idx) => {
        const isDone     = sec.status === 'Done';
        const isSkipped  = sec.status === 'Skip';
        const sCol       = statusColor(sec.status, C);
        const isExpanded = expandedSec === sec.id;
        const isDragging = dragIdx === idx;
        const confirming = confirmingDelete.has(sec.id);
        const secAviKey   = `${sourceTitle}|${sec.content}`;
        const secW        = aviWordSectionCounts?.[secAviKey] || 0;
        const secS        = aviSentSectionCounts?.[secAviKey] || 0;
        const secAviTotal = secW + secS;

        return (
          <div key={sec.id} draggable
            ref={sec.id === highlightSectionId ? highlightRef : null}
            onDragStart={e => handleDragStart(e, idx)} onDragOver={e => handleDragOver(e, idx)}
            onDrop={handleDrop} onDragEnd={handleDragEnd}
            style={{ borderBottom: `1px solid ${C.border}`, opacity: isDragging ? 0.4 : 1, background: isDragging ? C.accentSoft : 'transparent', borderLeft: sec.id === highlightSectionId ? `3px solid ${C.accent}` : undefined }}
            className="section-row">

            <div style={{
              display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px 8px 8px',
              position: 'relative',
              background: isExpanded ? `${C.accent}07` : isDone ? `${C.accent}05` : isSkipped ? `${C.textM}04` : 'transparent',
              opacity: isSkipped ? 0.55 : 1,
            }}>
              {/* Drag handle */}
              <div onClick={e => e.stopPropagation()} style={{ cursor: 'grab', color: C.textM, fontSize: '11px', flexShrink: 0, opacity: 0.3, userSelect: 'none' }} title="Drag to reorder">⠿</div>

              {/* ◀ ● ▶ */}
              <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                <button onClick={() => onCycleStatus(sec.id, 'backward')} title="Previous status"
                  style={{ width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: 'pointer', color: C.textM, padding: 0, opacity: 0.55 }}>{Icons.chevronLeft}</button>
                <div onClick={() => onSectionToggle(sec)} title={isDone ? 'Undo done' : 'Mark done'}
                  style={{ width: '17px', height: '17px', borderRadius: '50%', flexShrink: 0, cursor: 'pointer',
                    border: isDone ? 'none' : `1.5px solid ${sCol}`,
                    background: isDone ? C.accent : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s' }}>
                  {isDone && <span style={{ color: '#fff', fontSize: '9px', lineHeight: 1 }}>✓</span>}
                </div>
                <button onClick={() => onCycleStatus(sec.id, 'forward')} title="Next status"
                  style={{ width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: 'pointer', color: C.textM, padding: 0, opacity: 0.55 }}>{Icons.chevronRight}</button>
              </div>

              {/* Title — clicking expands */}
              <div onClick={() => { if (!wasDraggingRef.current) { setExpandedSec(isExpanded ? null : sec.id); if (sec.id !== highlightSectionId) onHighlightClear?.(); } }}
                style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
                <EditableTitle value={sec.content} url={sec.url || ''}
                  onSave={(title, url) => onSectionTitleSave(sec, title, url)}
                  style={{ fontSize: '13px', color: isDone || isSkipped ? C.textM : C.text,
                    textDecoration: isDone || isSkipped ? 'line-through' : 'none',
                    opacity: isDone || isSkipped ? 0.65 : 1, lineHeight: 1.4,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} />
              </div>

              {/* AVI counts — absolutely centered in row */}
              {secAviTotal > 0 && (
                <span style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', fontSize: '10px', color: C.textM, opacity: 0.65, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
                  {`{${secW}}w · {${secS}}s`}
                </span>
              )}
              {/* Status text */}
              {sec.status && sec.status !== 'Not started' && (
                <span style={{ fontSize: '10px', color: sCol, flexShrink: 0, opacity: 0.85 }}>{sec.status}</span>
              )}

              {/* Right-side buttons */}
              <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
                <button onClick={() => onSchedule(sec)} title={sec.linkedTaskId ? 'Reschedule' : 'Schedule'}
                  style={{ width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: sec.status === 'Scheduled' ? C.accentSoft : 'transparent',
                    border: `1px solid ${sec.status === 'Scheduled' ? C.accent + '77' : C.border}`,
                    borderRadius: '5px', cursor: 'pointer', color: sec.status === 'Scheduled' ? C.accent : C.textM, fontSize: '11px' }}>
                  {Icons.cal}
                </button>
                <button onClick={() => onAddNoteFromSection?.(sourceId, sec.id)} title="New note for this section"
                  style={{ width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'transparent', border: `1px solid ${C.border}`,
                    borderRadius: '5px', cursor: 'pointer', color: C.textM, fontSize: '9px', fontWeight: 600 }}>N</button>
                <button onClick={() => onAddCorrectionFromSection?.(sourceId, sec.id)} title="New correction for this section"
                  style={{ width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'transparent', border: `1px solid ${C.border}`,
                    borderRadius: '5px', cursor: 'pointer', color: C.textM, fontSize: '9px', fontWeight: 600 }}>C</button>
                {!confirming ? (
                  <button onClick={() => setConfirmingDelete(prev => new Set([...prev, sec.id]))} title="Delete section"
                    style={{ width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'transparent', border: `1px solid ${C.border}`, borderRadius: '5px', cursor: 'pointer', color: C.textM, fontSize: '10px', fontWeight: 600 }}>×</button>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                    <span style={{ fontSize: '10px', color: C.textM }}>Del?</span>
                    <button onClick={() => { setConfirmingDelete(prev => { const n = new Set(prev); n.delete(sec.id); return n; }); onDeleteSection(sec.id); }}
                      style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '4px', background: '#c0392b', color: '#fff', border: 'none', cursor: 'pointer' }}>Y</button>
                    <button onClick={() => setConfirmingDelete(prev => { const n = new Set(prev); n.delete(sec.id); return n; })}
                      style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '4px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}>N</button>
                  </div>
                )}
                <button onClick={() => { if (!wasDraggingRef.current) { setExpandedSec(isExpanded ? null : sec.id); if (sec.id !== highlightSectionId) onHighlightClear?.(); } }}
                  title={isExpanded ? 'Collapse' : 'Expand'}
                  style={{ width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: isExpanded ? C.accentSoft : 'transparent',
                    border: `1px solid ${isExpanded ? C.accent + '66' : C.border}`,
                    borderRadius: '5px', cursor: 'pointer', color: isExpanded ? C.accent : C.textM, fontSize: '10px' }}>
                  {isExpanded ? '▾' : '▸'}
                </button>
              </div>
            </div>

            {isExpanded && (
              <SectionDetailPanel
                sec={sec} grammarEntries={grammarEntries} allNotes={allNotes}
                correctionSessions={correctionSessions} isSourceLevel={false}
                onSectionFieldSave={onSectionFieldSave}
                onNavigateToGrammar={onNavigateToGrammar} onNavigateToNote={onNavigateToNote}
                onNavigateToCorrection={onNavigateToCorrection}
                onToggleNoteLink={onToggleNoteLink}
                onDeleteSection={onDeleteSection} C={C} S={S}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Schedule section modal ─────────────────────────────────────
function ScheduleSectionModal({ section, sourceTitle, tasks, onSave, onClose, C, S, dsh = 3 }) {
  const existingTask = tasks?.find(t => t.linkedSectionId === section.id && !t.completed);
  const [date, setDate] = useState(existingTask?.date || toDateStr(getLogicalToday(dsh)));
  const displayTitle = sectionTaskTitle(sourceTitle, section.content);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: '14px', border: `1px solid ${C.border}`, width: '320px', maxWidth: '92vw', padding: '22px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: SH.fd, fontSize: '16px', color: C.text }}>{existingTask ? 'Reschedule' : 'Schedule'}</span>
          <button onClick={onClose} style={{ color: C.textM, background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ fontSize: '13px', color: C.text, fontWeight: 500 }}>{displayTitle}</div>
        <DatePicker value={date} onChange={setDate} placeholder="Select date…" dsh={dsh} />
        {existingTask && (
          <div style={{ fontSize: '11px', color: C.textM, background: C.accentSoft, padding: '6px 10px', borderRadius: '8px' }}>
            Currently scheduled: {existingTask.date}
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ ...S.btnGhost, fontSize: '12px' }}>Cancel</button>
          <button onClick={() => date && onSave(section, date)} disabled={!date} style={{ ...S.btnPrimary, ...S.btnMetallic, fontSize: '12px', opacity: date ? 1 : 0.6 }}>
            {existingTask ? 'Reschedule' : 'Schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Editable origin ────────────────────────────────────────────
function EditableOrigin({ value, onSave, placeholder, C }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);
  const inputRef = useRef(null);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);
  const commit = e => { e.stopPropagation(); setEditing(false); if (draft.trim() !== value) onSave(draft.trim()); };
  const cancel = e => { e.stopPropagation(); setDraft(value); setEditing(false); };
  if (editing) {
    return (
      <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
        <input ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commit(e); if (e.key === 'Escape') cancel(e); }} onBlur={commit}
          style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '6px', width: '120px', border: `1px solid ${C.accent}`, background: C.bg, color: C.textM, outline: 'none' }}
          placeholder={placeholder || 'Origin…'} />
      </div>
    );
  }
  return (
    <span onClick={e => { e.stopPropagation(); setDraft(value); setEditing(true); }} title="Click to edit"
      style={{ fontSize: '11px', color: C.textM, flexShrink: 0, cursor: 'text', borderBottom: `1px dashed ${C.border}`, minWidth: '24px', display: 'inline-block' }}>
      {value || <span style={{ opacity: 0.4 }}>{placeholder ? placeholder.replace(/[…]+$/, '').trim().toLowerCase() : 'origin'}</span>}
    </span>
  );
}

// ── Editable order number (supports decimals for series) ───────
function EditableOrderNum({ value, onSave, C }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value != null ? String(value) : '');
  const ref = useRef(null);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);
  const commit = () => { const n = parseFloat(draft); onSave(isNaN(n) ? null : n); setEditing(false); };
  if (editing) {
    return (
      <input ref={ref} type="number" min="0.25" step="0.25" value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value != null ? String(value) : ''); setEditing(false); } }}
        onBlur={commit} onClick={e => e.stopPropagation()}
        style={{ fontSize: '11px', width: '60px', padding: '2px 6px', borderRadius: '6px', border: `1px solid ${C.accent}`, background: C.bg, color: C.textM, outline: 'none' }} />
    );
  }
  return (
    <span onClick={e => { e.stopPropagation(); setDraft(value != null ? String(value) : ''); setEditing(true); }}
      title="Click to set series order"
      style={{ fontSize: '11px', color: C.textM, cursor: 'text', borderBottom: `1px dashed ${C.border}`, minWidth: '20px', display: 'inline-block', textAlign: 'center' }}>
      {value != null ? value : <span style={{ opacity: 0.4 }}>?</span>}
    </span>
  );
}

// ── Source row (compact, selectable) ──────────────────────────
function SourceRow({ source, sections, isSelected, onSelect, wordCount = 0, sentCount = 0 }) {
  const { C } = useAppTheme();
  const col            = typeColor(source.type);
  const activeSections = sections.filter(s => s.status !== 'Skip');
  const doneSections   = activeSections.filter(s => s.status === 'Done').length;
  const skipped        = sections.filter(s => s.status === 'Skip').length;

  // Section-less: derive progress from sourceStatus
  const srcStatus   = getSourceStatus(source);
  const effDone     = sections.length === 0 ? (srcStatus === 'Done' ? 1 : 0) : doneSections;
  const effTotal    = sections.length === 0 ? 1 : activeSections.length;
  const effSkipped  = sections.length === 0 ? (srcStatus === 'Skip' ? 1 : 0) : skipped;
  const effRealTotal = sections.length === 0 ? 1 : sections.length;

  const levelLabel = source.levelMin
    ? (source.levelMax && source.levelMax !== source.levelMin
        ? `${source.levelMin}–${source.levelMax}` : source.levelMin)
    : null;

  // Crow icon colour: C.warning for grammar-practice links, C.text for companion
  const hasPSLink   = !!(source.linkedGrammarSourceId) || (source.linkedPracticeSourceIds?.length > 0);
  const hasCLink    = !!(source.linkedCompanionIds?.length);
  const crowColor   = hasPSLink ? C.warning : hasCLink ? C.text : null;

  return (
    <div onClick={onSelect} style={{
      padding: '10px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border}`,
      borderLeft: `3px solid ${isSelected ? C.accent : 'transparent'}`,
      background: isSelected ? C.accentSoft : 'transparent',
      transition: 'background 0.12s, border-color 0.12s',
    }}>
      {/* Line 1: title + miner hat + crow + AVI count */}
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, overflow: 'hidden', marginBottom: '5px' }}>
        <span style={{ fontSize: '13px', fontWeight: isSelected ? 500 : 400, color: C.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>
          {source.title}
        </span>
        {source.studyIntent === 'mining' && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0, marginLeft: '4px', opacity: 0.7 }}>
            <path d="M2.6 10.6 C2.6 5.8 4.6 2.6 8 2.6 C11.4 2.6 13.4 5.8 13.4 10.6 Z M8 7.0 A1.8 1.8 0 0 0 8 10.6 A1.8 1.8 0 0 0 8 7.0 Z M5.15 3.0 L5.95 6.5 L5.05 6.5 L4.35 3.8 Z M10.85 3.0 L11.65 3.8 L10.95 6.5 L10.05 6.5 Z"/>
            <path d="M6.4 1.6 L9.6 1.6 C10.2 1.6 10.65 2.1 10.55 2.65 L9.8 6.6 L6.2 6.6 L5.45 2.65 C5.35 2.1 5.8 1.6 6.4 1.6 Z"/>
            <path d="M2 10.4 L14 10.4 C14.5 10.4 14.9 10.8 14.9 11.3 L14.9 12.3 C14.9 12.8 14.5 13.2 14 13.2 L2 13.2 C1.5 13.2 1.1 12.8 1.1 12.3 L1.1 11.3 C1.1 10.8 1.5 10.4 2 10.4 Z"/>
          </svg>
        )}
        {crowColor && (
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0, marginLeft: '3px' }}>
            <path fill={crowColor} d="M0.8 0.9 C3.5 1.6 6.2 2.7 8.3 3.9 C10.7 4.0 12.4 5.6 13.0 7.9 C13.4 10.0 13.3 12.2 13.6 14.6 L4.2 14.6 C4.7 12.5 5.1 10.6 5.7 9.0 C5.9 8.4 6.3 7.7 6.8 7.1 C4.8 5.1 2.6 3.0 0.8 0.9 Z M9.6 4.4 A1.2 1.2 0 0 0 9.6 6.8 A1.2 1.2 0 0 0 9.6 4.4 Z M9.6 5.0 A0.6 0.6 0 0 1 9.6 6.2 A0.6 0.6 0 0 1 9.6 5.0 Z"/>
          </svg>
        )}
        {(wordCount + sentCount) > 0 && (
          <span style={{ fontSize: '10px', color: C.textM, flexShrink: 0, marginLeft: '5px', opacity: 0.65, whiteSpace: 'nowrap' }}>
            {`{${wordCount}}w · {${sentCount}}s`}
          </span>
        )}
      </div>

      {/* Line 2: level + subtype tag + progress bar (type dot merged into bar at 0%) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        {levelLabel && <span style={{ fontSize: '10px', color: C.textM, flexShrink: 0 }}>{levelLabel}</span>}
        {TYPE_SHORT_LABELS[source.type] && (
          <span style={{ fontSize: '10px', color: col, flexShrink: 0, opacity: 0.85 }}>{TYPE_SHORT_LABELS[source.type]}</span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <ProgressBar done={effDone} total={effTotal} skipped={effSkipped}
            realTotal={effRealTotal} color={col} soundProfile={null} />
        </div>
      </div>
    </div>
  );
}

// ── Family group header (library + archive lists) ─────────────
function FamilyHeader({ family }) {
  const { C } = useAppTheme();
  return (
    <div style={{ padding: '12px 12px 5px', fontSize: '10px', fontFamily: SH.fm, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.textM, borderBottom: `1px solid ${C.border}`, background: `${C.border}22` }}>
      {FAMILY_LABELS[family] || family}
    </div>
  );
}

// ── Source detail panel ────────────────────────────────────────
function SourceDetailPanel({
  source, sections, grammarEntries, allNotes, correctionSessions,
  aviWordCounts, aviSentenceCounts, aviWordSectionCounts, aviSentSectionCounts, tasks, allSources,
  onNavigateToGrammar, onNavigateToNote, onNavigateToCorrection,
  onSectionToggle, onSectionTitleSave, onSourceTitleSave, onSourceFieldSave,
  onScheduleSection, onCycleStatus, onSectionFieldSave, onSectionOrderSave,
  onDeleteSection, onDeleteSource, onAddSections, onAddNote, onAddCorrection,
  onAddNoteFromSection, onAddCorrectionFromSection,  onCycleSourceStatus, onSourceToggleDone,
  onLinkSources, onUnlinkSources, onToggleNoteLink,
  onArchiveSource, onRestoreSource, isPendingArchive,
  highlightSectionId, onHighlightClear,
  onClose, dsh = 3, isOverlay = false,
}) {
  const { C, S } = useAppTheme();
  const [addSecOpen,        setAddSecOpen]        = useState(false);
  const [addSecCount,       setAddSecCount]       = useState('');
  const [addSecSaving,      setAddSecSaving]      = useState(false);
  const [addingToSeries,    setAddingToSeries]    = useState(false);
  // Source linking
  const [linkSearchOpen,    setLinkSearchOpen]    = useState(false);
  const [linkSearch,        setLinkSearch]        = useState('');
  const [pendingLink,       setPendingLink]        = useState(null); // source object
  // Cost entry
  const [addingCost,      setAddingCost]      = useState(false);
  const [newCostDate,     setNewCostDate]     = useState(toDateStr(getLogicalToday(dsh)));
  const [newCostAmount,   setNewCostAmount]   = useState('');
  const [newCostCurrency, setNewCostCurrency] = useState('KRW');
  const [newCostNotes,    setNewCostNotes]    = useState('');
  const [grammarOpen,     setGrammarOpen]     = useState(() => {
    try { return localStorage.getItem('avi_cl_grammar_open') === 'true'; } catch { return false; }
  });
  const [notesOpen,       setNotesOpen]       = useState(() => {
    try { return localStorage.getItem('avi_cl_notes_open') === 'true'; } catch { return false; }
  });
  const headerRef = useRef(null);
  const footerRef = useRef(null);
  const [headerH, setHeaderH] = useState(0);
  const [footerH, setFooterH] = useState(0);

  useLayoutEffect(() => {
    const update = () => {
      if (headerRef.current) setHeaderH(headerRef.current.offsetHeight);
      if (footerRef.current) setFooterH(footerRef.current.offsetHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    if (headerRef.current) ro.observe(headerRef.current);
    if (footerRef.current) ro.observe(footerRef.current);
    return () => ro.disconnect();
  }, [source.id]);

  const col        = typeColor(source.type);
  const noSections = sections.length === 0;
  const wordCount  = aviWordSectionCounts
    ? Object.entries(aviWordSectionCounts).filter(([k]) => k.startsWith(source.title + '|')).reduce((s, [, v]) => s + v, 0)
    : 0;
  const sentCount  = aviSentSectionCounts
    ? Object.entries(aviSentSectionCounts).filter(([k]) => k.startsWith(source.title + '|')).reduce((s, [, v]) => s + v, 0)
    : 0;
  const corrSessions = (correctionSessions || []).filter(c => c.sourceId === source.id);

  // Notes / Corrections collapsible — pool all notes/corrections linked to this source or its sections.
  // Three linking paths exist: note.linkedSourceId, note.linkedSectionId, and section.linkedNoteIds.
  // The third path catches notes linked via the note editor's section picker, which only writes to
  // section.linkedNoteIds and does not set any field on the note document itself.
  const sectionIds    = new Set(sections.map(s => s.id));
  const linkedNotesCt = (allNotes || []).filter(n =>
    n.linkedSourceId === source.id ||
    (n.linkedSectionId && sectionIds.has(n.linkedSectionId)) ||
    sections.some(s => (s.linkedNoteIds || []).includes(n.id))
  ).length;

  // Source status (section-less only)
  const srcStatus    = getSourceStatus(source);
  const srcStatusCol = statusColor(srcStatus, C);

  // Grammar summary from all sections
  const grammarTermIds = [...new Set(sections.flatMap(s => s.glossaryTermIds || []))];
  const grammarTerms   = grammarTermIds.map(id => grammarEntries?.find(e => e.id === id)).filter(Boolean);

  const pooledNotes = (allNotes || []).filter(n =>
    !n.tags?.includes('question') &&
    (
      n.linkedSourceId === source.id ||
      (n.linkedSectionId && sectionIds.has(n.linkedSectionId)) ||
      sections.some(s => (s.linkedNoteIds || []).includes(n.id))
    )
  );
  const pooledCorrs = (correctionSessions || []).filter(c =>
    c.sourceId === source.id ||
    sections.some(s => (s.linkedCorrectionNoteIds || []).includes(c.id))
  );

  // Source linking helpers
  const hasPSLink = !!(source.linkedGrammarSourceId) || (source.linkedPracticeSourceIds?.length > 0);
  const hasCLink  = !!(source.linkedCompanionIds?.length);
  const linkSearchResults = useMemo(() => {
    if (!linkSearch.trim()) return [];
    const q = linkSearch.trim().toLowerCase();
    return (allSources || []).filter(s => s.id !== source.id && s.title?.toLowerCase().includes(q)).slice(0, 6);
  }, [linkSearch, allSources, source.id]);

  const resetLinkState = () => { setLinkSearchOpen(false); setLinkSearch(''); setPendingLink(null); };
  const confirmLink = role => { onLinkSources?.(source.id, pendingLink.id, role); resetLinkState(); };

  const CURRENCIES = ['KRW', 'USD', 'EUR'];
  const CURRENCY_SYMBOL = { KRW: '₩', USD: '$', EUR: '€' };
  const saveCost = () => {
    if (!newCostAmount) return;
    const entry = { id: crypto.randomUUID(), date: newCostDate, amount: parseFloat(newCostAmount) || 0, currency: newCostCurrency, notes: newCostNotes.trim() };
    onSourceFieldSave(source, { costs: [...(source.costs || []), entry] });
    setAddingCost(false); setNewCostAmount(''); setNewCostCurrency('KRW'); setNewCostNotes('');
    setNewCostDate(toDateStr(getLogicalToday(dsh)));
  };
  const removeCost = costId => onSourceFieldSave(source, { costs: (source.costs || []).filter(c => c.id !== costId) });

  const handleAddSecs = async () => {
    const n = parseInt(addSecCount);
    if (!n || n < 1) return;
    setAddSecSaving(true);
    await onAddSections(source.id, n);
    setAddSecCount(''); setAddSecOpen(false); setAddSecSaving(false);
  };

  const pillStyle = (color) => ({
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    padding: '2px 8px', borderRadius: '10px', fontSize: '11px',
    border: `1px solid ${color}55`, color, background: `${color}12`,
  });

  const corrLabel = c => c.title || c.sourceLabel || 'Correction';

  return (
        <div className={isOverlay ? 'cl-mobile-overlay' : undefined} style={isOverlay
        ? { position: 'fixed', top: '74px', bottom: '56px', left: 0, right: 0, zIndex: 60, overflow: 'hidden', background: C.surface }
          : { position: 'relative', width: '600px', minWidth: '600px', height: '100%', overflow: 'hidden', borderLeft: `1px solid ${C.border}`, background: C.surface }}>

      {/* ── Header — fixed behind sections (z-index 1) ── */}
      <div ref={headerRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1, background: C.surface, borderBottom: `1px solid ${C.border}`, padding: '16px 18px 12px' }}>

        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '10px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <EditableTitle value={source.title} url={source.url || ''}
              onSave={(title, url) => onSourceTitleSave(source, title, url, source.type)}
              style={{ fontSize: '15px', fontWeight: 500, color: C.text, wordBreak: 'break-word' }} />
          </div>
          {(wordCount + sentCount) > 0 && (
            <span style={{ fontSize: '11px', color: C.textM, flexShrink: 0, marginTop: '3px', whiteSpace: 'nowrap' }}>
              {`{${wordCount}}w · {${sentCount}}s`}
            </span>
          )}
          <button onClick={onClose} style={{ color: C.textM, fontSize: '15px', lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, marginTop: '2px' }}>✕</button>
        </div>

        {/* Chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', marginBottom: '9px' }}>
          <select value={source.type || ''} onChange={e => onSourceTitleSave(source, source.title, source.url || '', e.target.value)}
            style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '12px', cursor: 'pointer', border: `1px solid ${col}88`, background: `${col}18`, color: col, outline: 'none', appearance: 'none', WebkitAppearance: 'none' }}>
            {TYPES.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}
          </select>
          {(CONTENT_SUBTYPES[source.type] || []).length > 0 && (
            <InlineSelectChip value={source.subtype} options={CONTENT_SUBTYPES[source.type] || []}
              onSave={v => onSourceFieldSave(source, { subtype: v || null })} label="subtype" C={C} />
          )}
          <InlineSelectChip value={source.levelMin} options={LEVELS}
            onSave={v => onSourceFieldSave(source, { levelMin: v || null })} label="level" C={C} />
          {source.levelMin && (
            <InlineSelectChip value={source.levelMax} options={LEVELS}
              onSave={v => onSourceFieldSave(source, { levelMax: v || null })} label="→ to" C={C} />
          )}
          <InlineSelectChip
            value={source.studyIntent ? (STUDY_INTENTS.find(i => i.value === source.studyIntent)?.label || source.studyIntent) : null}
            options={STUDY_INTENTS.map(i => i.label)}
            onSave={v => { const found = STUDY_INTENTS.find(i => i.label === v); onSourceFieldSave(source, { studyIntent: found?.value || null }); }}
            label="intent" C={C} />
          <button
            onClick={() => onSourceFieldSave(source, { paused: !source.paused })}
            title={source.paused ? 'Resume — return to active progress' : 'Pause — send back to Queue, even if partly done'}
            style={{
              display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', cursor: 'pointer',
              border: `1px solid ${source.paused ? C.warning : C.border}`,
              background: source.paused ? `${C.warning}18` : 'transparent',
              color: source.paused ? C.warning : C.textM,
            }}
          >
            {source.paused ? 'Paused' : 'Pause'}
          </button>
        </div>

        {/* Source status (section-less only) */}
        {noSections && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '9px' }}>
            <span style={{ fontSize: '11px', color: C.textM, marginRight: '2px' }}>Status</span>
            <button onClick={() => onCycleSourceStatus?.(source.id, 'backward')} title="Previous status"
              style={{ width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: 'pointer', color: C.textM, padding: 0, opacity: 0.55 }}>{Icons.chevronLeft}</button>
            <div onClick={() => onSourceToggleDone?.(source)} title={srcStatus === 'Done' ? 'Undo done' : 'Mark done'}
              style={{ width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0, cursor: 'pointer',
                border: srcStatus === 'Done' ? 'none' : `1.5px solid ${srcStatusCol}`,
                background: srcStatus === 'Done' ? (C.success || '#5ba05b') : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s' }}>
              {srcStatus === 'Done' && <span style={{ color: '#fff', fontSize: '9px', lineHeight: 1 }}>✓</span>}
            </div>
            <button onClick={() => onCycleSourceStatus?.(source.id, 'forward')} title="Next status"
              style={{ width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: 'pointer', color: C.textM, padding: 0, opacity: 0.55 }}>{Icons.chevronRight}</button>
            <span style={{ fontSize: '11px', color: srcStatusCol, marginLeft: '2px' }}>{srcStatus}</span>
          </div>
        )}

        {/* Origin + Series */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
          <EditableOrigin value={source.origin || ''} onSave={v => onSourceFieldSave(source, { origin: v })} C={C} />
          {source.series ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ fontSize: '11px', color: C.textM }}>·</span>
              <span style={{ fontSize: '11px', color: C.textM }}>Series:</span>
              <EditableOrigin value={source.series} onSave={v => onSourceFieldSave(source, { series: v || null })} placeholder="series name…" C={C} />
              <span style={{ fontSize: '11px', color: C.textM }}>#</span>
              <EditableOrderNum value={source.seriesOrder} onSave={v => onSourceFieldSave(source, { seriesOrder: v })} C={C} />
              <button onClick={() => onSourceFieldSave(source, { series: null, seriesOrder: null })} title="Remove from series"
                style={{ fontSize: '10px', color: C.textM, background: 'none', border: 'none', cursor: 'pointer', opacity: 0.5 }}>×</button>
            </div>
          ) : addingToSeries ? (
            <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ fontSize: '11px', color: C.textM }}>·</span>
              <span style={{ fontSize: '11px', color: C.textM }}>Series:</span>
              <input autoFocus
                style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '6px', width: '130px', border: `1px solid ${C.accent}`, background: C.bg, color: C.textM, outline: 'none' }}
                placeholder="series name…"
                onKeyDown={e => {
                  if (e.key === 'Enter' && e.target.value.trim()) { onSourceFieldSave(source, { series: e.target.value.trim() }); setAddingToSeries(false); }
                  if (e.key === 'Escape') setAddingToSeries(false);
                }}
                onBlur={e => { if (!e.target.value.trim()) setAddingToSeries(false); }} />
              <button onClick={() => setAddingToSeries(false)} style={{ fontSize: '11px', color: C.textM, background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
            </div>
          ) : (
            <button onClick={() => setAddingToSeries(true)}
              style={{ fontSize: '10px', color: C.textM, background: 'none', border: `1px dashed ${C.border}`, borderRadius: '8px', padding: '1px 8px', cursor: 'pointer', opacity: 0.55 }}>
              + series
            </button>
          )}
        </div>

        {/* Source links (grammar-practice + companions) */}
        <div style={{ marginBottom: '8px' }}>
          {(hasPSLink || hasCLink) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '6px' }}>
              {source.linkedGrammarSourceId && (() => {
                const tgt = allSources?.find(s => s.id === source.linkedGrammarSourceId);
                return tgt ? (
                  <span style={pillStyle(C.warning)}>
                    <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true"><path fill={C.warning} d="M0.8 0.9 C3.5 1.6 6.2 2.7 8.3 3.9 C10.7 4.0 12.4 5.6 13.0 7.9 C13.4 10.0 13.3 12.2 13.6 14.6 L4.2 14.6 C4.7 12.5 5.1 10.6 5.7 9.0 C5.9 8.4 6.3 7.7 6.8 7.1 C4.8 5.1 2.6 3.0 0.8 0.9 Z M9.6 4.4 A1.2 1.2 0 0 0 9.6 6.8 A1.2 1.2 0 0 0 9.6 4.4 Z M9.6 5.0 A0.6 0.6 0 0 1 9.6 6.2 A0.6 0.6 0 0 1 9.6 5.0 Z"/></svg>
                    Primary: {tgt.title.slice(0, 16)}
                    <button onClick={() => onUnlinkSources?.(source.id, source.linkedGrammarSourceId)} style={{ color: C.warning, background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', padding: 0 }}>×</button>
                  </span>
                ) : null;
              })()}
              {(source.linkedPracticeSourceIds || []).map(tid => {
                const tgt = allSources?.find(s => s.id === tid);
                return tgt ? (
                  <span key={tid} style={pillStyle(C.warning)}>
                    <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true"><path fill={C.warning} d="M0.8 0.9 C3.5 1.6 6.2 2.7 8.3 3.9 C10.7 4.0 12.4 5.6 13.0 7.9 C13.4 10.0 13.3 12.2 13.6 14.6 L4.2 14.6 C4.7 12.5 5.1 10.6 5.7 9.0 C5.9 8.4 6.3 7.7 6.8 7.1 C4.8 5.1 2.6 3.0 0.8 0.9 Z M9.6 4.4 A1.2 1.2 0 0 0 9.6 6.8 A1.2 1.2 0 0 0 9.6 4.4 Z M9.6 5.0 A0.6 0.6 0 0 1 9.6 6.2 A0.6 0.6 0 0 1 9.6 5.0 Z"/></svg>
                    Secondary: {tgt.title.slice(0, 14)}
                    <button onClick={() => onUnlinkSources?.(source.id, tid)} style={{ color: C.warning, background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', padding: 0 }}>×</button>
                  </span>
                ) : null;
              })}
              {(source.linkedCompanionIds || []).map(tid => {
                const tgt = allSources?.find(s => s.id === tid);
                return tgt ? (
                  <span key={tid} style={pillStyle(C.text)}>
                    <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true"><path fill={C.text} d="M0.8 0.9 C3.5 1.6 6.2 2.7 8.3 3.9 C10.7 4.0 12.4 5.6 13.0 7.9 C13.4 10.0 13.3 12.2 13.6 14.6 L4.2 14.6 C4.7 12.5 5.1 10.6 5.7 9.0 C5.9 8.4 6.3 7.7 6.8 7.1 C4.8 5.1 2.6 3.0 0.8 0.9 Z M9.6 4.4 A1.2 1.2 0 0 0 9.6 6.8 A1.2 1.2 0 0 0 9.6 4.4 Z M9.6 5.0 A0.6 0.6 0 0 1 9.6 6.2 A0.6 0.6 0 0 1 9.6 5.0 Z"/></svg>
                    {tgt.title.slice(0, 20)}
                    <button onClick={() => onUnlinkSources?.(source.id, tid)} style={{ color: C.text, background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', padding: 0 }}>×</button>
                  </span>
                ) : null;
              })}
            </div>
          )}

          {linkSearchOpen ? (
            pendingLink ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', color: C.textM }}>"{pendingLink.title.slice(0, 20)}" is the:</span>
                <button onClick={() => confirmLink('primary')} style={{ fontSize: '11px', padding: '2px 10px', borderRadius: '8px', border: `1px solid ${C.warning}`, background: `${C.warning}18`, color: C.warning, cursor: 'pointer' }}>Primary</button>
                <button onClick={() => confirmLink('secondary')} style={{ fontSize: '11px', padding: '2px 10px', borderRadius: '8px', border: `1px solid ${C.warning}`, background: `${C.warning}18`, color: C.warning, cursor: 'pointer' }}>Secondary</button>
                <button onClick={() => confirmLink('companion')} style={{ fontSize: '11px', padding: '2px 10px', borderRadius: '8px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}>Companion</button>
                <button onClick={() => setPendingLink(null)} style={{ fontSize: '11px', color: C.textM, background: 'none', border: 'none', cursor: 'pointer' }}>Back</button>
              </div>
            ) : (
              <div style={{ position: 'relative' }}>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <input autoFocus value={linkSearch} onChange={e => setLinkSearch(e.target.value)}
                    style={{ ...S.formInput, fontSize: '12px', margin: 0, flex: 1 }} placeholder="Search sources to link…" />
                  <button onClick={resetLinkState} style={{ fontSize: '11px', color: C.textM, background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '2px 8px', cursor: 'pointer' }}>Cancel</button>
                </div>
                {linkSearchResults.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: C.raised, border: `1px solid ${C.border}`, borderRadius: '6px', zIndex: 10, overflow: 'hidden', marginTop: '2px' }}>
                    {linkSearchResults.map(s => (
                      <div key={s.id} onClick={() => { setPendingLink(s); setLinkSearch(''); }}
                        style={{ padding: '7px 12px', cursor: 'pointer', fontSize: '12px', color: C.text, borderBottom: `1px solid ${C.border}` }}
                        className="task-row">
                        {s.title}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          ) : (
            <button onClick={() => setLinkSearchOpen(true)}
              style={{ fontSize: '10px', color: C.textM, background: 'none', border: `1px dashed ${C.border}`, borderRadius: '8px', padding: '1px 8px', cursor: 'pointer', opacity: 0.6 }}>
              + Link source
            </button>
          )}
        </div>
      </div>

      {/* Cost entries */}
        <div style={{ marginBottom: '8px' }}>
          {(source.costs || []).map(cost => (
            <div key={cost.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', fontSize: '11px', color: C.textM, flexWrap: 'wrap' }}>
              <span style={{ color: C.text, fontWeight: 500 }}>{CURRENCY_SYMBOL[cost.currency] || ''}{Number(cost.amount).toLocaleString()}</span>
              <span>{cost.currency}</span>
              {cost.date && <span>{cost.date}</span>}
              {cost.notes && <span style={{ opacity: 0.7 }}>{cost.notes}</span>}
              <button onClick={() => removeCost(cost.id)} style={{ color: C.textM, background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', padding: 0, lineHeight: 1 }}>×</button>
            </div>
          ))}
          {addingCost ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <DatePicker value={newCostDate} onChange={setNewCostDate} dsh={dsh} />
                <input type="number" min="0" value={newCostAmount} onChange={e => setNewCostAmount(e.target.value)}
                  placeholder="Amount" style={{ ...S.formInput, margin: 0, width: '90px', fontSize: '12px' }} />
                <select value={newCostCurrency} onChange={e => setNewCostCurrency(e.target.value)}
                  style={{ fontSize: '11px', padding: '3px 6px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, outline: 'none' }}>
                  {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <input value={newCostNotes} onChange={e => setNewCostNotes(e.target.value)}
                placeholder="Notes (optional)…" style={{ ...S.formInput, margin: 0, fontSize: '12px' }} />
              <div style={{ display: 'flex', gap: '6px' }}>
                <button onClick={saveCost} disabled={!newCostAmount}
                  style={{ fontSize: '11px', padding: '2px 12px', borderRadius: '6px', background: C.accent, color: '#fff', border: 'none', cursor: 'pointer', opacity: newCostAmount ? 1 : 0.5 }}>Save</button>
                <button onClick={() => setAddingCost(false)}
                  style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAddingCost(true)}
              style={{ fontSize: '10px', color: C.textM, background: 'none', border: `1px dashed ${C.border}`, borderRadius: '8px', padding: '1px 8px', cursor: 'pointer', opacity: 0.55 }}>
              + Cost
            </button>
          )}
        </div>

      {/* Scroll area — over header (z-index 2), under footer (z-index 3) */}
      <div className="cl-scroll-area" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflowY: 'auto', zIndex: 2, paddingTop: headerH, paddingBottom: footerH, pointerEvents: 'none', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        <div style={{ background: C.surface, minHeight: '100%', pointerEvents: 'auto' }}>

        {/* Grammar — collapsible, scrolls with sections */}
        {grammarTerms.length > 0 && (
          <div style={{ borderBottom: `1px solid ${C.border}` }}>
            <button
              onClick={() => { const next = !grammarOpen; setGrammarOpen(next); try { localStorage.setItem('avi_cl_grammar_open', String(next)); } catch {} }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 18px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ fontSize: '9px', color: C.textM }}>{grammarOpen ? '▾' : '▸'}</span>
              <span style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM }}>
                Grammar ({grammarTerms.length})
              </span>
            </button>
            {grammarOpen && (
              <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', maxHeight: '110px', overflowY: 'auto', padding: '4px 18px 10px' }}>
                {grammarTerms.map(entry => (
                  <span key={entry.id} onClick={() => onNavigateToGrammar?.(entry.id)}
                    style={{ padding: '2px 9px', borderRadius: '12px', fontSize: '11px', fontFamily: SH.fk, border: `1px solid ${C.accent}44`, color: C.accent, background: C.accentSoft, cursor: onNavigateToGrammar ? 'pointer' : 'default', alignSelf: 'flex-start' }}>
                    {entry.glossaryTerm}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Notes / Corrections — pooled from all sections, same pattern as Grammar */}
        {(pooledNotes.length > 0 || pooledCorrs.length > 0) && (
          <div style={{ borderBottom: `1px solid ${C.border}` }}>
            <button
              onClick={() => { const next = !notesOpen; setNotesOpen(next); try { localStorage.setItem('avi_cl_notes_open', String(next)); } catch {} }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 18px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ fontSize: '9px', color: C.textM }}>{notesOpen ? '▾' : '▸'}</span>
              <span style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM }}>
                Notes / Corrections ({pooledNotes.length + pooledCorrs.length})
              </span>
            </button>
            {notesOpen && (
              <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', maxHeight: '110px', overflowY: 'auto', padding: '4px 18px 10px' }}>
                {pooledNotes.map(n => (
                  <span key={n.id} onClick={() => onNavigateToNote?.(n.id)}
                    style={{ padding: '2px 9px', borderRadius: '12px', fontSize: '11px', border: `1px solid ${C.border}`, color: C.text, background: C.bg, cursor: onNavigateToNote ? 'pointer' : 'default', alignSelf: 'flex-start' }}>
                    {n.title || 'Untitled'}
                  </span>
                ))}
                {pooledCorrs.map(c => (
                  <span key={c.id} onClick={() => onNavigateToCorrection?.(c.id)}
                    style={{ padding: '2px 9px', borderRadius: '12px', fontSize: '11px', border: `1px solid ${C.border}`, color: C.textM, background: C.bg, cursor: onNavigateToCorrection ? 'pointer' : 'default', alignSelf: 'flex-start', fontStyle: 'italic' }}>
                    {c.title || 'Correction'}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Pending-archive banner */}
        {isPendingArchive && (
          <div style={{ padding: '7px 18px', background: `${C.warning}14`, borderBottom: `1px solid ${C.warning}33`, display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: C.warning }}>
            All sections complete — {source.title.slice(0, 24)} will move to Archive after rollover.
          </div>
        )}
        {!noSections ? (
          <SectionList
            sections={sections} sourceId={source.id} sourceTitle={source.title}
            aviWordSectionCounts={aviWordSectionCounts} aviSentSectionCounts={aviSentSectionCounts}
            grammarEntries={grammarEntries} allNotes={allNotes}
            correctionSessions={correctionSessions}
            onNavigateToGrammar={onNavigateToGrammar} onNavigateToNote={onNavigateToNote}
            onNavigateToCorrection={onNavigateToCorrection}
            onSectionToggle={onSectionToggle} onSectionTitleSave={onSectionTitleSave}
            onSchedule={onScheduleSection} onCycleStatus={onCycleStatus}
            onSectionFieldSave={onSectionFieldSave} onSectionOrderSave={onSectionOrderSave}
            onDeleteSection={onDeleteSection} onToggleNoteLink={onToggleNoteLink}
            onAddNoteFromSection={onAddNoteFromSection}
            onAddCorrectionFromSection={onAddCorrectionFromSection}
            highlightSectionId={highlightSectionId}
            onHighlightClear={onHighlightClear}
          />
        ) : (
          <SectionDetailPanel
            sec={{
              id:                    source.id,
              sectionNote:           source.sourceNote,
              linkedNoteIds:         source.linkedNoteIds         || [],
              linkedCorrectionNoteIds: source.linkedCorrectionNoteIds || [],
              glossaryTermIds:       source.glossaryTermIds       || [],
            }}
            grammarEntries={grammarEntries} allNotes={allNotes}
            correctionSessions={correctionSessions} isSourceLevel={true}
            onSectionFieldSave={(_, updates) => {
              const mapped = {};
              if ('sectionNote'             in updates) mapped.sourceNote             = updates.sectionNote;
              if ('linkedNoteIds'           in updates) mapped.linkedNoteIds           = updates.linkedNoteIds;
              if ('linkedCorrectionNoteIds' in updates) mapped.linkedCorrectionNoteIds = updates.linkedCorrectionNoteIds;
              if ('glossaryTermIds'         in updates) mapped.glossaryTermIds         = updates.glossaryTermIds;
              onSourceFieldSave(source, mapped);
            }}
            onNavigateToGrammar={onNavigateToGrammar} onNavigateToNote={onNavigateToNote}
            onNavigateToCorrection={onNavigateToCorrection}
            onToggleNoteLink={(_, noteId) => {
              // Route to source-level note toggle: use source.id as the section-less identifier
              onToggleNoteLink?.({ id: source.id, linkedNoteIds: source.linkedNoteIds || [] }, noteId);
            }}
            onDeleteSection={null} C={C} S={S}
          />
        )}

        {/* Add sections */}
        <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.border}` }}>
          {!addSecOpen ? (
            <button onClick={() => setAddSecOpen(true)} style={{ fontSize: '11px', padding: '3px 12px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}>
              + Add sections
            </button>
          ) : (
            <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '80px' }}>
                <label style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.06em', color: C.textM, textTransform: 'uppercase' }}>Count *</label>
                <input autoFocus type="number" min="1" max="999"
                  style={{ ...S.formInput, fontSize: '12px', margin: 0, padding: '4px 8px' }}
                  value={addSecCount} onChange={e => setAddSecCount(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddSecs(); if (e.key === 'Escape') setAddSecOpen(false); }} />
              </div>
              <button onClick={handleAddSecs} disabled={!parseInt(addSecCount) || addSecSaving}
                style={{ ...S.btnPrimary, fontSize: '12px', padding: '4px 14px', height: '30px', opacity: (!parseInt(addSecCount) || addSecSaving) ? 0.5 : 1 }}>
                {addSecSaving ? 'Adding…' : 'Add'}
              </button>
              <button onClick={() => setAddSecOpen(false)}
                style={{ fontSize: '12px', padding: '4px 10px', height: '30px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, borderRadius: '8px', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          )}
        </div>

      </div>
      </div>

      {/* Footer — over sections (z-index 3) */}
      <div ref={footerRef} style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 3, background: C.surface, borderTop: `1px solid ${C.border}`, padding: '12px 18px' }}>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
          <button onClick={() => onAddNote?.(source.id)}
            style={{ fontSize: '11px', padding: '1px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}>
            + Note
          </button>
          <button onClick={() => onAddCorrection?.(source.id)}
            style={{ fontSize: '11px', padding: '1px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}>
            + Corrections
          </button>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {source.archived ? (
            <button onClick={() => onRestoreSource?.(source.id)}
              style={{ fontSize: '11px', color: C.accent, background: 'none', border: `1px solid ${C.accent}55`, borderRadius: '6px', padding: '2px 10px', cursor: 'pointer' }}>
              Restore to Library
            </button>
          ) : (
            <button onClick={() => onArchiveSource?.(source.id)}
              style={{ fontSize: '11px', color: C.textM, background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '2px 10px', cursor: 'pointer', opacity: 0.65 }}>
              Archive source
            </button>
          )}
        <button onClick={() => onDeleteSource(source.id)}
          style={{ fontSize: '11px', color: C.textM, background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '2px 10px', cursor: 'pointer', opacity: 0.6 }}>
          Delete source
        </button>
        </div>
      </div>
    </div>
  );
}

// ── Delete Source cascade confirmation (Phase D3) ─────────────
const SENTENCE_MINING_SUFFIX = ' (sentence mining)';

// Resolve the full delete blast radius from Firestore (not the in-memory arrays),
// so decks/cards/sections written on another device or session are never missed.
async function resolveDeletePlan(uid, source) {
  const title        = source.title || '';
  const sentenceName = title + SENTENCE_MINING_SUFFIX;

  // Decks: union of linkedSourceId match and the two exact name patterns
  const decksCol = collection(db, 'users', uid, 'decks');
  const [byLink, byName, bySent] = await Promise.all([
    getDocs(query(decksCol, where('linkedSourceId', '==', source.id))),
    getDocs(query(decksCol, where('name', '==', title))),
    getDocs(query(decksCol, where('name', '==', sentenceName))),
  ]);
  const deckMap = new Map();
  for (const snap of [byLink, byName, bySent]) {
    for (const d of snap.docs) if (!deckMap.has(d.id)) deckMap.set(d.id, { id: d.id, ...d.data() });
  }
  const matchedDecks = [...deckMap.values()];
  const deckIds      = matchedDecks.map(d => d.id);

  // Cards whose deckIds intersect the matched decks (array-contains-any, chunked at 10)
  const cardMap = new Map();
  const fcCol   = collection(db, 'users', uid, 'flashcards');
  for (let i = 0; i < deckIds.length; i += 10) {
    const chunk = deckIds.slice(i, i + 10);
    if (!chunk.length) continue;
    const snap = await getDocs(query(fcCol, where('deckIds', 'array-contains-any', chunk)));
    for (const c of snap.docs) if (!cardMap.has(c.id)) cardMap.set(c.id, { id: c.id, ...c.data() });
  }
  const cards         = [...cardMap.values()];
  const cardIds       = cards.map(c => c.id);
  const perDeckCounts = matchedDecks.map(d => cards.filter(c => (c.deckIds || []).includes(d.id)).length);

  // Sections belonging to the source
  const secSnap    = await getDocs(query(collection(db, 'users', uid, 'content_sections'), where('resourceId', '==', source.id)));
  const sectionIds = secSnap.docs.map(d => d.id);

  // Entries that will move to Sourceless
  const [wSnap, sSnap] = await Promise.all([
    getDocs(query(collection(db, 'users', uid, 'wordInputs'),     where('source', '==', title))),
    getDocs(query(collection(db, 'users', uid, 'sentenceInputs'), where('source', '==', title))),
  ]);
  const entryCount = wSnap.docs.length + sSnap.docs.length;

  return { matchedDecks, deckIds, cardIds, perDeckCounts, cardCount: cardIds.length, sectionIds, sectionCount: sectionIds.length, entryCount };
}

function CountRow({ label, value, C }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '2px 0' }}>
      <span style={{ fontSize: '12px', color: C.textS }}>{label}</span>
      <span style={{ fontSize: '13px', fontWeight: 600, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function DeleteSourceCascadeModal({ source, C, S, onCancel, onConfirm }) {
  const [busy,     setBusy]     = useState(false);
  const [progress, setProgress] = useState('');
  const [errorMsg, setErrorMsg] = useState(null);
  const [plan,     setPlan]     = useState(null); // null while resolving from Firestore

  useEffect(() => {
    let cancelled = false;
    const uid = auth.currentUser?.uid;
    if (!uid || !source) return;
    setPlan(null);
    (async () => {
      try {
        const resolved = await resolveDeletePlan(uid, source);
        if (!cancelled) setPlan(resolved);
      } catch (e) {
        console.error('D3: plan resolve failed', e);
        if (!cancelled) setErrorMsg('Could not read the current data for this source. Close and try again.');
      }
    })();
    return () => { cancelled = true; };
  }, [source]);

  return (
    <div style={S.overlay} onClick={() => { if (!busy) onCancel(); }}>
      <div style={{ ...S.modal, maxWidth: '440px' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', color: C.text }}>
          <span style={{ display: 'flex', color: '#c0392b' }}>{Icons.alert}</span>
          <span style={{ fontSize: '15px', fontWeight: 600 }}>Delete source</span>
        </div>

        <div style={{ fontSize: '13px', color: C.text, marginBottom: '12px', lineHeight: 1.5 }}>
          Deleting <strong>{source?.title || 'this source'}</strong> removes the source, its sections, and its named flashcard decks. The vocabulary entries are kept — they move to Sourceless so they stay grouped.
        </div>

        <div style={{ ...S.infoBox, marginTop: 0 }}>
          <CountRow label="Decks to delete" value={plan ? plan.matchedDecks.length : '…'} C={C} />
          {plan && plan.matchedDecks.length > 0 && (
            <div style={{ fontSize: '11px', color: C.textS, margin: '2px 0 6px 0', lineHeight: 1.5 }}>
              {plan.matchedDecks.map(d => d.name).join(' | ')}
            </div>
          )}
          <CountRow label="Flashcards in those decks" value={plan ? plan.cardCount : '…'} C={C} />
          {plan && plan.matchedDecks.length > 0 && (
            <div style={{ fontSize: '11px', color: C.textS, margin: '2px 0 6px 0', lineHeight: 1.5 }}>
              {plan.perDeckCounts.join(' | ')}
            </div>
          )}
          <CountRow label="Sections to delete" value={plan ? plan.sectionCount : '…'} C={C} />
          <CountRow label="AVI entries to move to Sourceless" value={plan ? plan.entryCount : '…'} C={C} />
        </div>

        <div style={{ fontSize: '11px', color: C.textM, margin: '10px 0 14px 0', lineHeight: 1.5 }}>
          Quiz history, notes, corrections, questions, review stats, and grammar entries are not affected.
        </div>

        {errorMsg && (
          <div style={{ fontSize: '11px', color: '#c0392b', marginBottom: '10px', lineHeight: 1.5 }}>{errorMsg}</div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' }}>
          {busy && (
            <span style={{ fontSize: '11px', color: C.textM, fontStyle: 'italic', marginRight: 'auto' }}>{progress || 'Working…'}</span>
          )}
          <button onClick={onCancel} disabled={busy}
            style={{ fontSize: '12px', padding: '5px 14px', border: `1px solid ${C.border}`, background: 'transparent', color: C.text, borderRadius: '8px', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
            Cancel
          </button>
          <button
            onClick={async () => {
              setErrorMsg(null);
              setBusy(true);
              try {
                await onConfirm(source, plan, setProgress);
                onCancel();
              } catch (e) {
                console.error('D3 cascade failed', e);
                setErrorMsg('Something went wrong during deletion. Close this and retry — re-running is safe.');
                setBusy(false);
              }
            }}
            disabled={busy || !plan}
            style={{ fontSize: '12px', padding: '5px 14px', border: 'none', background: '#c0392b', color: '#fff', borderRadius: '8px', opacity: (busy || !plan) ? 0.6 : 1, cursor: (busy || !plan) ? 'not-allowed' : 'pointer' }}>
            {busy ? 'Deleting…' : 'Delete source'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Add Source modal ──────────────────────────────────────────
function AddSourceModal({ onSave, onClose, C, S }) {
  const [title,        setTitle]        = useState('');
  const [type,         setType]         = useState('Grammar');
  const [url,          setUrl]          = useState('');
  const [origin,       setOrigin]       = useState('');
  const [sectionCount, setSectionCount] = useState('');
  const [subtype,      setSubtype]      = useState('');
  const [levelMin,     setLevelMin]     = useState('');
  const [levelMax,     setLevelMax]     = useState('');
  const [studyIntent,  setStudyIntent]  = useState('');
  const [saving,       setSaving]       = useState(false);

  const handleTypeChange = (newType) => { setType(newType); setSubtype(''); };

  const handleSave = async (mode = 'library') => {
    if (!title.trim()) return;
    setSaving(true);
    await onSave({ title: title.trim(), type, url: url.trim(), origin: origin.trim(),
      sectionCount: parseInt(sectionCount) || 0, subtype: subtype || null,
      levelMin: levelMin || null, levelMax: levelMax || null, studyIntent: studyIntent || null }, mode);
    setSaving(false);
  };

  const count          = parseInt(sectionCount) || 0;
  const subtypeOptions = CONTENT_SUBTYPES[type] || [];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: '16px', border: `1px solid ${C.border}`, width: '480px', maxWidth: '92vw', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: SH.fd, fontSize: '18px', color: C.text }}>Add source</span>
          <button onClick={onClose} style={{ color: C.textM, fontSize: '18px', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        <div style={S.formGroup}>
          <label style={S.formLabel}>Title *</label>
          <input style={S.formInput} value={title} autoFocus onChange={e => setTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            placeholder="e.g. HTSK Unit 1, KSI 5A…" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div style={S.formGroup}>
            <label style={S.formLabel}>Type</label>
            <select style={S.formSelect} value={type} onChange={e => handleTypeChange(e.target.value)}>
              {TYPES.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}
            </select>
          </div>
          <div style={S.formGroup}>
            <label style={S.formLabel}>Origin</label>
            <input style={S.formInput} value={origin} onChange={e => setOrigin(e.target.value)} placeholder="e.g. YouTube, Netflix…" />
          </div>
        </div>

        {subtypeOptions.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <div style={S.formGroup}>
              <label style={S.formLabel}>Subtype</label>
              <select style={S.formSelect} value={subtype} onChange={e => setSubtype(e.target.value)}>
                <option value="">— select —</option>
                {subtypeOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={S.formGroup}>
              <label style={S.formLabel}>Level from</label>
              <select style={S.formSelect} value={levelMin} onChange={e => setLevelMin(e.target.value)}>
                <option value="">—</option>
                {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div style={S.formGroup}>
              <label style={S.formLabel}>Level to</label>
              <select style={S.formSelect} value={levelMax} onChange={e => setLevelMax(e.target.value)}>
                <option value="">—</option>
                {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
          </div>
        )}

        <div style={S.formGroup}>
          <label style={S.formLabel}>Study intent</label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {STUDY_INTENTS.map(({ value, label }) => {
              const active = studyIntent === value;
              return (
                <button key={value} type="button" onClick={() => setStudyIntent(active ? '' : value)} style={{
                  padding: '4px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: 500,
                  border: `1px solid ${active ? C.accent : C.border}`, background: active ? C.accentSoft : 'transparent',
                  color: active ? C.accent : C.textS, cursor: 'pointer', transition: 'all 0.15s',
                }}>{label}</button>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '12px' }}>
          <div style={S.formGroup}>
            <label style={S.formLabel}>URL (optional)</label>
            <input style={S.formInput} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div style={S.formGroup}>
            <label style={S.formLabel}>Sections</label>
            <input style={S.formInput} type="number" min="0" value={sectionCount} onChange={e => setSectionCount(e.target.value)} placeholder="0" />
          </div>
        </div>

        {count > 0 && (
          <div style={{ fontSize: '11px', color: C.textM, marginTop: '-8px', padding: '8px 10px', borderRadius: '8px', background: C.accentSoft }}>
            Will create <strong style={{ color: C.accent }}>{count}</strong> section{count > 1 ? 's' : ''}: "1" → "{count}"
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button style={S.btnGhost} onClick={onClose}>Cancel</button>
          <button style={{ ...S.btnGhost, opacity: (!title.trim() || saving) ? 0.6 : 1 }}
            onClick={() => handleSave('close')} disabled={!title.trim() || saving}>
            {saving ? 'Adding…' : 'Close'}
          </button>
          <button style={{ ...S.btnPrimary, ...S.btnMetallic, opacity: (!title.trim() || saving) ? 0.6 : 1 }}
            onClick={() => handleSave('library')} disabled={!title.trim() || saving}>
            {saving ? 'Adding…' : 'Library'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Quick Question modal ──────────────────────────────────────
function QuickQuestionModal({ onSave, onClose, C, S }) {
  const [title,  setTitle]  = useState('Q: ');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.setSelectionRange(3, 3);
    }
  }, []);

  const canSave = title.replace(/^Q:\s*/, '').trim().length > 0 && !saving;

  const handleSave = async (mode = 'close') => {
    if (!canSave) return;
    setSaving(true);
    await onSave({ title: title.trim(), tags: ['question'] }, mode);
    setSaving(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: '16px', border: `1px solid ${C.border}`, width: '480px', maxWidth: '92vw', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: SH.fd, fontSize: '18px', color: C.text }}>Add question</span>
          <button onClick={onClose} style={{ color: C.textM, fontSize: '18px', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        <div style={S.formGroup}>
          <label style={S.formLabel}>Question</label>
          <input
            ref={inputRef}
            style={S.formInput}
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && canSave) handleSave(); if (e.key === 'Escape') onClose(); }}
            placeholder="Q: what does X mean…"
          />
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button style={S.btnGhost} onClick={onClose}>Cancel</button>
          <button style={{ ...S.btnGhost, opacity: canSave ? 1 : 0.6 }} onClick={() => handleSave('close')} disabled={!canSave}>
            {saving ? 'Saving…' : 'Close'}
          </button>
          <button style={{ ...S.btnPrimary, ...S.btnMetallic, opacity: canSave ? 1 : 0.6 }} onClick={() => handleSave('notes')} disabled={!canSave}>
            {saving ? 'Saving…' : 'Notes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Passive-media sources excluded from Overview and auto-archive unless intent is mining

// ── Content Library Overview tab ──────────────────────────────
function CLOverviewTab({
  sources, sections, sectionsBySource,
  allNotes, correctionSessions,
  grammarEntries, grammarMasteryCounts,
  appointments, cards, decks,
  adriftDays, dsh,
  onNavigateToSource,
}) {
  const { C } = useAppTheme();
  const [queueOpen,   setQueueOpen]   = useState(false);
  const [tierShown,   setTierShown]   = useState({ grammar: 2, mining: 2, casual: 2 });
  const [carouselIdx, setCarouselIdx] = useState(0);

  const CEFR    = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const cefrIdx = (level) => CEFR.indexOf(level);

  // ── Date math ──────────────────────────────────────────────
  const logicalToday = useMemo(() => getLogicalToday(dsh), [dsh]);
  const todayStr     = useMemo(() => toDateStr(logicalToday), [logicalToday]);
  const todayMs      = useMemo(() => logicalToday.getTime(), [logicalToday]);
  const adriftMs     = (adriftDays ?? 14) * 86400000;

  const fmtDaysAgo = (iso) => {
    if (!iso) return '';
    const days = Math.floor((todayMs - new Date(iso).getTime()) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  };

  const stripHtml = (html) =>
    (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

  // ── Source classification ───────────────────────────────────
  const isComplete = useCallback((src) => {
    if (src.archived || src.pendingArchive) return true;
    const st = getSourceStatus(src);
    if (st === 'Done') return true;
    const secs = sectionsBySource[src.id] || [];
    if (!secs.length) return st === 'Skip';
    return secs.every(s => s.status === 'Done' || s.status === 'Skip');
  }, [sectionsBySource]);

  const isActive = useCallback((src) => {
    if (isComplete(src)) return false;
    const st = getSourceStatus(src);
    if (st === 'In Progress' || st === 'Scheduled') return true;
    return (sectionsBySource[src.id] || []).some(s =>
      s.status === 'In Progress' || s.status === 'Scheduled' || s.status === 'Done'
    );
  }, [sectionsBySource, isComplete]);

  const isAdrift = useCallback((src) => {
    if (isActive(src) || isComplete(src)) return false;
    if (!src.lastActivityAt) return false;
    return (todayMs - new Date(src.lastActivityAt).getTime()) > adriftMs;
  }, [isActive, isComplete, todayMs, adriftMs]);

  const activeSources = useMemo(() => sources.filter(s => isActive(s) && !isPassiveMediaExcluded(s)),  [sources, isActive]);
  const adriftSources = useMemo(() => sources.filter(s => isAdrift(s) && !isPassiveMediaExcluded(s)), [sources, isAdrift]);

  // ── Active CEFR range for Queue sort ───────────────────────
  const activeRange = useMemo(() => {
    const pool = activeSources.length ? activeSources : adriftSources;
    let min = Infinity, max = -Infinity;
    pool.forEach(src => {
      const lo = cefrIdx(src.levelMin);
      const hi = cefrIdx(src.levelMax ?? src.levelMin);
      if (lo >= 0) min = Math.min(min, lo);
      if (hi >= 0) max = Math.max(max, hi);
    });
    return (min <= max && isFinite(min)) ? { min, max } : null;
  }, [activeSources, adriftSources]);

  // ── Queue ───────────────────────────────────────────────────
  const queueByTier = useMemo(() => {
    const notQueue = (s) => isActive(s) || isAdrift(s) || isComplete(s);

    const candidates = sources.filter(s =>
      !notQueue(s) && !isPassiveMediaExcluded(s)
    ).map(src => {
      const totalSections = (sectionsBySource[src.id] || []).length;
      // Series gate: hide if a lower-order sibling is also in candidates
      const seriesBlocked = src.series && src.seriesOrder != null &&
        sources.some(o =>
          o.id !== src.id && o.series === src.series &&
          o.seriesOrder != null && parseFloat(o.seriesOrder) < parseFloat(src.seriesOrder) &&
          !notQueue(o)
        );
      if (seriesBlocked) return null;
      // Faded if lower-order sibling is Active/Adrift
      const waiting = src.series && src.seriesOrder != null &&
        [...activeSources, ...adriftSources].some(o =>
          o.series === src.series && o.seriesOrder != null &&
          parseFloat(o.seriesOrder) < parseFloat(src.seriesOrder)
        );
      // CEFR distance sort key
      const lo = cefrIdx(src.levelMin);
      const hi = cefrIdx(src.levelMax ?? src.levelMin);
      let bucket = 2, dist = 0, exactMatch = false;
      if (lo >= 0 && hi >= 0) {
        bucket = 0;
        if (!activeRange) {
          dist = lo;
        } else if (lo >= activeRange.min && hi <= activeRange.max) {
          dist = 0; exactMatch = true;
        } else if (hi < activeRange.min) {
          dist = activeRange.min - hi;
        } else if (lo > activeRange.max) {
          dist = lo - activeRange.max;
        }
        // overlapping-but-extending case: dist stays 0, no outline
      }
      return { ...src, _total: totalSections, _waiting: waiting, _exact: exactMatch, _key: [bucket, dist, totalSections] };
    }).filter(Boolean);

    // Grammar:Practice sources are sub-items; exclude from standalone list
    const practiceIds = new Set(
      candidates.filter(s => s.type === 'Grammar').flatMap(s => s.linkedPracticeSourceIds || [])
    );

    const sortFn = (a, b) => {
      for (let i = 0; i < 3; i++) if (a._key[i] !== b._key[i]) return a._key[i] - b._key[i];
      return 0;
    };

    const tiers = { grammar: [], mining: [], casual: [] };
    candidates.forEach(src => {
      const tier = src.studyIntent; // 'grammar'|'mining'|'casual'
      if (!tier || !tiers[tier] || practiceIds.has(src.id)) return;
      tiers[tier].push({
        ...src,
        _practiceItems: (src.linkedPracticeSourceIds || [])
          .map(id => candidates.find(c => c.id === id))
          .filter(Boolean),
      });
    });
    Object.keys(tiers).forEach(k => tiers[k].sort(sortFn));
    return tiers;
  }, [sources, sectionsBySource, isActive, isAdrift, isComplete, activeSources, adriftSources, activeRange]);

  // ── Grammar recent reviews ──────────────────────────────────
  const recentGrammarReviews = useMemo(() => (cards || [])
    .filter(c => c.type === 'grammar' && (c.lastReview || c.lastReviewed))
    .sort((a, b) => (b.lastReview || b.lastReviewed).localeCompare(a.lastReview || a.lastReviewed))
    .slice(0, 3)
    .map(c => {
      const entry = grammarEntries.find(e => e.id === c.linkedGrammarEntryId);
      const ml    = ['introduced', 'practicing', 'confident', 'mastered'].indexOf(entry?.masteryLevel || 'introduced');
      // Compute the logical review date respecting the day-flip hour.
      const rd = new Date(c.lastReview || c.lastReviewed);
      if (rd.getHours() < dsh) rd.setDate(rd.getDate() - 1);
      return {
        entry,
        masteryLevel: ml === -1 ? 0 : ml,
        reviewDate:   rd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      };
    })
    .filter(r => r.entry),
    [cards, grammarEntries, dsh]
  );

  // ── Recent 한국어 appointment ────────────────────────────────
  const recentLangAppt = useMemo(() =>
    (appointments || [])
      .filter(a => a.category === 'lang' && a.date < todayStr)
      .sort((a, b) => b.date.localeCompare(a.date))[0] || null,
    [appointments, todayStr]
  );

  // ── Open questions ──────────────────────────────────────────
  const openQuestions = useMemo(() =>
    allNotes
      .filter(n => (n.tags || []).includes('question') && !n.answered)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    [allNotes]
  );

  // ── Notes carousel (8 most recent, questions excluded) ──────
  const carouselNotes = useMemo(() =>
    [...allNotes.filter(n => !(n.tags || []).includes('question')), ...correctionSessions]
      .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
      .slice(0, 8),
    [allNotes, correctionSessions]
  );

  const carouselNote    = carouselNotes[carouselIdx] || null;
  const carouselPreview = carouselNote
    ? carouselNote.type === 'correction'
      ? ((carouselNote.rows || []).map(r => r.topic).filter(Boolean).join(', ') || stripHtml(carouselNote.bodyHtml).slice(0, 500))
      : stripHtml(carouselNote.bodyHtml).slice(0, 500)
    : '';

  const MASTERY_COLORS = ['#888', '#e0a030', '#c97d3a', '#5ba05b', '#2a8fb0', '#7b6cf6'];

  // ── Shared Active/Adrift card renderer ─────────────────────
  const renderSourceCard = (src) => {
    const secs   = sectionsBySource[src.id] || [];
    const done   = secs.filter(s => s.status === 'Done').length;
    const active = secs.filter(s => s.status !== 'Skip').length;
    const skip   = secs.filter(s => s.status === 'Skip').length;
    const noSecs = !secs.length;
    const col    = typeColor(src.type);
    const level  = src.levelMin
      ? (src.levelMax && src.levelMax !== src.levelMin ? `${src.levelMin}–${src.levelMax}` : src.levelMin)
      : null;
    return (
      <div key={src.id} onClick={() => onNavigateToSource('library', src.id)}
        style={{ padding: '10px 12px', borderRadius: '10px', border: `1px solid ${C.border}`, background: C.raised, cursor: 'pointer', marginBottom: '8px' }}
        className="task-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
          {level && <span style={{ fontSize: '10px', color: C.textM, flexShrink: 0 }}>{level}</span>}
          <span style={{ fontSize: '13px', fontWeight: 500, color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{src.title}</span>
        </div>
        {!noSecs && <div style={{ marginBottom: '5px' }}><ProgressBar done={done} total={active} skipped={skip} realTotal={secs.length} color={col} soundProfile={null} /></div>}
        <div style={{ fontSize: '11px', color: C.textM }}>
          {noSecs ? getSourceStatus(src) : `${done} of ${active} done`}
          {src.lastActivityAt ? ` · ${fmtDaysAgo(src.lastActivityAt)}` : ''}
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '4px 0 28px' }}>

      {/* ── Band 1: Grammar + Appointment | Goals ─────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>

        {/* Left brace: grammar + appointment */}
        <div style={{ border: `1px solid ${C.border}`, borderRadius: '12px', padding: '14px 16px', background: C.raised }}>
          <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>Recent Grammar</div>
          {recentGrammarReviews.length === 0 ? (
            <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', marginBottom: '14px' }}>No grammar cards reviewed yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px', marginBottom: '14px' }}>
              {recentGrammarReviews.map(({ entry, masteryLevel, reviewDate }) => (
                <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: MASTERY_COLORS[Math.min(masteryLevel, MASTERY_COLORS.length - 1)], flexShrink: 0 }} />
                  <span style={{ fontSize: '13px', fontFamily: SH.fk, color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.glossaryTerm}</span>
                  <span style={{ fontSize: '11px', color: C.textM, flexShrink: 0 }}>{reviewDate}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ borderTop: `1px solid ${C.border}`, margin: '10px 0 12px' }} />
          <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>Recent 한국어 Lesson</div>
          {!recentLangAppt ? (
            <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>No lessons scheduled.</div>
          ) : (
            <div style={{ padding: '8px 12px', borderRadius: '8px',
              border: `1px solid ${(recentLangAppt.followUpQueue || []).length === 0 ? (C.danger || '#c0392b') : C.border}`,
              background: (recentLangAppt.followUpQueue || []).length === 0 ? `${C.danger || '#c0392b'}0d` : 'transparent',
            }}>
              <div style={{ fontSize: '13px', fontWeight: 500, color: C.text }}>
                {recentLangAppt.type
                  ? `${recentLangAppt.type} — ${recentLangAppt.provider || ''}`
                  : (recentLangAppt.provider || 'Tutor')}
              </div>              <div style={{ fontSize: '11px', color: C.textM, marginTop: '2px' }}>
                {fmtApptDate(recentLangAppt.date)}{recentLangAppt.time ? ` · ${fmtTime(recentLangAppt.time)}` : ''}
              </div>
              {(recentLangAppt.followUpQueue || []).length === 0 && (
                <div style={{ fontSize: '11px', color: C.danger || '#c0392b', marginTop: '4px' }}>No follow-up scheduled</div>
              )}
            </div>
          )}
        </div>

        {/* Right: Goals placeholder */}
        <div style={{ border: `1px dashed ${C.border}`, borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '120px' }}>
          <span style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>Goals placeholder</span>
        </div>
      </div>

      {/* ── Band 2: Active | Adrift ──────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.accent, marginBottom: '10px' }}>Active</div>
          {activeSources.length === 0
            ? <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>Nothing active.</div>
            : activeSources.map(renderSourceCard)
          }
        </div>
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.warning, marginBottom: '10px' }}>Adrift</div>
          {adriftSources.length === 0
            ? <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>Nothing adrift.</div>
            : adriftSources.map(src => (
                <div key={src.id} style={{ opacity: 0.8 }}>{renderSourceCard(src)}</div>
              ))
          }
        </div>
      </div>

      {/* ── Band 3: Queue (collapsible) ─────────────────── */}
      <div style={{ border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden' }}>
        <button onClick={() => setQueueOpen(o => !o)}
          style={{ width: '100%', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px', background: C.raised, border: 'none', cursor: 'pointer', textAlign: 'left' }}>
          <span style={{ fontSize: '11px', color: C.textM }}>{queueOpen ? '▾' : '▸'}</span>
          <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.text }}>Queue</span>
        </button>
        {queueOpen && (
          <div style={{ padding: '14px 16px', borderTop: `1px solid ${C.border}`, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px' }}>
            {[{ key: 'grammar', label: 'Study' }, { key: 'mining', label: 'Mining' }, { key: 'casual', label: 'Casual' }].map(({ key: tk, label }) => {
              const items  = queueByTier[tk] || [];
              const shown  = tierShown[tk];
              const hasMore = items.length > shown;
              return (
                <div key={tk}>
                  <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>{label}</div>
                  {items.length === 0 ? (
                    <div style={{ fontSize: '11px', color: C.textM, fontStyle: 'italic' }}>No {label.toLowerCase()}-tier sources.</div>
                  ) : (
                    <>
                      {items.slice(0, shown).map(src => {
                        const col   = typeColor(src.type);
                        const level = src.levelMin
                          ? (src.levelMax && src.levelMax !== src.levelMin ? `${src.levelMin}–${src.levelMax}` : src.levelMin) : null;
                        return (
                          <div key={src.id} style={{ marginBottom: '6px', opacity: src._waiting ? 0.5 : 1 }}>
                            <div onClick={() => onNavigateToSource('library', src.id)}
                              style={{ padding: '8px 10px', borderRadius: '8px', cursor: 'pointer', background: C.raised,
                                border: src._exact ? `2px solid ${col}` : `1px solid ${C.border}` }}
                              className="task-row">
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: col, flexShrink: 0 }} />
                                {level && <span style={{ fontSize: '10px', color: C.textM, flexShrink: 0 }}>{level}</span>}
                                <span style={{ fontSize: '12px', color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{src.title}</span>
                                {src._total > 0 && <span style={{ fontSize: '10px', color: C.textM, flexShrink: 0 }}>{src._total}§</span>}
                              </div>
                            </div>
                            {(src._practiceItems || []).map(p => (
                              <div key={p.id} onClick={() => onNavigateToSource('library', p.id)}
                                style={{ marginLeft: '14px', marginTop: '3px', padding: '5px 10px', borderRadius: '7px', cursor: 'pointer', border: `1px solid ${C.border}`, background: C.raised, opacity: 0.6 }}
                                className="task-row">
                                <span style={{ fontSize: '11px', color: C.textM }}>{p.title}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                      {hasMore && (
                        <button onClick={() => setTierShown(prev => ({ ...prev, [tk]: prev[tk] + 3 }))}
                          style={{ fontSize: '11px', color: C.textM, background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '2px 10px', cursor: 'pointer', marginTop: '4px' }}>
                          [...]
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Band 4: Open Questions | Notes carousel ───────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>

        {/* Open Questions */}
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.text, marginBottom: '10px' }}>Open Questions</div>
          {openQuestions.length === 0 ? (
            <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>No open questions.</div>
          ) : openQuestions.map(n => (
            <div key={n.id} style={{ padding: '8px 12px', borderRadius: '8px', border: `1px solid ${C.border}`, background: C.raised, marginBottom: '6px' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 500, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '3px' }}>{n.title}</div>
              <div style={{ fontSize: '10px', color: C.textM, fontFamily: SH.fm }}>
                {n.createdAt ? new Date(n.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
              </div>
            </div>
          ))}
        </div>

        {/* Notes carousel */}
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.text, marginBottom: '10px' }}>Recent Notes</div>
          {carouselNotes.length === 0 ? (
            <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>No notes yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                <button onClick={() => setCarouselIdx(i => (i - 1 + carouselNotes.length) % carouselNotes.length)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textM, fontSize: '14px', padding: '2px', flexShrink: 0 }}>◀</button>
                <div style={{ flex: 1, padding: '10px 12px', borderRadius: '8px', border: `1px solid ${C.border}`, background: C.raised, minHeight: '80px' }}>
                  {carouselNote && (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px' }}>
                        <span style={{ fontSize: '10px', padding: '1px 7px', borderRadius: '8px',
                          border: `1px solid ${carouselNote.type === 'correction' ? C.warning : C.border}`,
                          color: carouselNote.type === 'correction' ? C.warning : C.textM,
                          background: carouselNote.type === 'correction' ? `${C.warning}15` : 'transparent' }}>
                          {carouselNote.type === 'correction' ? 'Correction' : 'Note'}
                        </span>
                        <span style={{ fontSize: '10px', color: C.textM, marginLeft: 'auto', fontFamily: SH.fm }}>
                          {new Date(carouselNote.updatedAt || carouselNote.createdAt || '').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                      </div>
                      <div style={{ fontSize: '12.5px', fontWeight: 500, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '4px' }}>{carouselNote.title}</div>
                      <div style={{ fontSize: '11.5px', color: C.textS, lineHeight: 1.4 }}>{carouselPreview}</div>
                    </>
                  )}
                </div>
                <button onClick={() => setCarouselIdx(i => (i + 1) % carouselNotes.length)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textM, fontSize: '14px', padding: '2px', flexShrink: 0 }}>▶</button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '4px' }}>
                {carouselNotes.map((_, i) => (
                  <div key={i} onClick={() => setCarouselIdx(i)}
                    style={{ width: carouselIdx === i ? '16px' : '6px', height: '6px', borderRadius: '3px', background: carouselIdx === i ? C.accent : C.border, cursor: 'pointer', transition: 'all 0.2s' }} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Archive Management modal ───────────────────────────────────
function ArchiveManagementModal({ sources, onArchiveSelected, onRestoreSelected, defaultMode, onClose, C, S }) {
  const [mode,     setMode]     = useState(defaultMode || 'archive');
  const [selected, setSelected] = useState(new Set());
  const [search,   setSearch]   = useState('');

  const switchMode = (m) => { setMode(m); setSelected(new Set()); };

  const pool = mode === 'archive'
    ? sources.filter(s => !s.archived)
    : sources.filter(s => s.archived === true);

  const filtered = search.trim()
    ? pool.filter(s => s.title?.toLowerCase().includes(search.trim().toLowerCase()))
    : pool;

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  const handleConfirm = () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (mode === 'archive') onArchiveSelected(ids); else onRestoreSelected(ids);
    onClose();
  };

  const col = mode === 'archive' ? C.warning : C.accent;
  const actionLabel = mode === 'archive'
    ? (selected.size > 0 ? `Archive ${selected.size} source${selected.size > 1 ? 's' : ''}` : 'Archive Selected')
    : (selected.size > 0 ? `Restore ${selected.size} source${selected.size > 1 ? 's' : ''}` : 'Restore Selected');

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: '14px', border: `1px solid ${C.border}`, width: '480px', maxWidth: '92vw', padding: '22px', display: 'flex', flexDirection: 'column', gap: '14px', maxHeight: '80vh' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: SH.fd, fontSize: '16px', color: C.text }}>Archive Management</span>
          <button onClick={onClose} style={{ color: C.textM, background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ display: 'flex', gap: '4px', background: C.bg, border: `1px solid ${C.border}`, borderRadius: '10px', padding: '3px', width: 'fit-content' }}>
          {[{ id: 'archive', label: 'Archive' }, { id: 'restore', label: 'Restore' }].map(({ id, label }) => (
            <button key={id} onClick={() => switchMode(id)} style={{ padding: '4px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 500, border: 'none', cursor: 'pointer', transition: 'all 0.15s', background: mode === id ? C.raised : 'transparent', color: mode === id ? C.text : C.textM, boxShadow: mode === id ? '0 1px 3px rgba(0,0,0,0.15)' : 'none' }}>{label}</button>
          ))}
        </div>
        <input style={{ ...S.formInput, margin: 0, fontSize: '12px' }} placeholder="Search sources…" value={search} onChange={e => setSearch(e.target.value)} />
        {filtered.length > 0 && (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '-6px' }}>
            <button onClick={() => setSelected(new Set(filtered.map(s => s.id)))} style={{ fontSize: '11px', color: C.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Select all</button>
            {selected.size > 0 && <><button onClick={() => setSelected(new Set())} style={{ fontSize: '11px', color: C.textM, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Clear</button><span style={{ fontSize: '11px', color: C.textM }}>{selected.size} selected</span></>}
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: '8px', minHeight: '160px', maxHeight: '300px' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: C.textM, fontSize: '12px', fontStyle: 'italic' }}>{mode === 'archive' ? 'No library sources found' : 'No archived sources found'}</div>
          ) : filtered.map(src => (
            <div key={src.id} onClick={() => toggle(src.id)} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer', background: selected.has(src.id) ? `${col}10` : 'transparent' }} className="task-row">
              <div style={{ width: '16px', height: '16px', borderRadius: '3px', flexShrink: 0, border: `1.5px solid ${selected.has(src.id) ? col : C.border}`, background: selected.has(src.id) ? col : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.12s' }}>
                {selected.has(src.id) && <span style={{ color: '#fff', fontSize: '10px', lineHeight: 1 }}>✓</span>}
              </div>
              <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: typeColor(src.type), flexShrink: 0 }} />
              <span style={{ fontSize: '13px', color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{src.title}</span>
              <span style={{ fontSize: '11px', color: C.textM, flexShrink: 0 }}>{src.type}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ ...S.btnGhost, fontSize: '12px' }}>Cancel</button>
          <button onClick={handleConfirm} disabled={selected.size === 0} style={{ fontSize: '12px', padding: '6px 16px', borderRadius: '8px', border: 'none', cursor: selected.size > 0 ? 'pointer' : 'not-allowed', background: selected.size > 0 ? col : C.border, color: selected.size > 0 ? '#fff' : C.textM, opacity: selected.size > 0 ? 1 : 0.7 }}>{actionLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ── Main page component ───────────────────────────────────────
export function ContentLibraryPage({
  showDecoPanel,
  soundProfile, onNavigateToGrammar, onNavigateToNote, addTask,
  defaultOpenSourceId, onNavigateToCorrection,
  noteTarget, correctionTarget, correctionSessionTarget,
  triggerAddSource, triggerAddQuestion, triggerAddNote, triggerAddCorrection,
  aviSources, aviSections, aviWordCounts, aviSentenceCounts,
  onSourcesChange, onSectionsChange, onSourceRename,
  tasks, onCompleteLinkedTask, patchTask, registerSectionUpdateCallback,
  aviWordSectionCounts, aviSentSectionCounts,
  settings,
  appointments, cards, decks, grammarMasteryCounts,
  pendingApptLink, onApptLinkConsumed,
  wordInputs, sentenceInputs,
  updateCards, updateDecks, onSourceCascadeComplete,
}) {
  const { C, S } = useAppTheme();
  const isMobile   = typeof window !== 'undefined' && window.innerWidth <= 700;
  const dsh        = settings?.dayStartHour ?? 3;
  const adriftDays = settings?.adriftDays   ?? 14;
  const [sources,            setSources]            = useState(() => (aviSources || []).filter(s => !s.isSourceless));
  const [sections,           setSections]           = useState(() => aviSections || []);
  const [deleteSourceTarget, setDeleteSourceTarget] = useState(null);
  const [cascadeToast,       setCascadeToast]       = useState(null);
  const [grammarEntries,     setGrammarEntries]     = useState([]);
  const [allNotes,           setAllNotes]           = useState([]);
  const [correctionSessions, setCorrectionSessions] = useState([]);
  const [loading,            setLoading]            = useState(true);
  const [search,             setSearch]             = useState('');
  const [typeFilter,         setTypeFilter]         = useState('all');
  const [showAddSource,      setShowAddSource]      = useState(false);
  const [selectedSourceId,   setSelectedSourceId]   = useState(null);
  const [highlightSectionId,    setHighlightSectionId]    = useState(null);
  const [localNoteTarget,       setLocalNoteTarget]       = useState(null);
  const [localCorrectionTarget, setLocalCorrectionTarget] = useState(null);
  const [scheduleModal,      setScheduleModal]      = useState(null);
  const [archiveSearch,      setArchiveSearch]      = useState('');
  const [archiveTypeFilter,  setArchiveTypeFilter]  = useState('all');
  const [pendingArchiveBannerSourceId, setPendingArchiveBannerSourceId] = useState(null);
  const [archiveMgmtOpen,    setArchiveMgmtOpen]    = useState(false);
  const [archiveMgmtMode,    setArchiveMgmtMode]    = useState('archive');
  const [preLinkedData,      setPreLinkedData]       = useState(null);
  // { key, sourceId, sectionId, apptId, mode: 'note'|'correction' }
  const [showQuickQuestion,  setShowQuickQuestion]   = useState(false);
  const [adAliases,          setAdAliases]            = useState({});
  const statusDebounceRef = useRef({});
  const migrationDoneRef  = useRef(false);
  const pendingArchiveCheckedRef = useRef(false);

  const [activeTab, setActiveTab] = useState(() => {
    try { return localStorage.getItem(CL_TAB_KEY) || 'overview'; } catch { return 'overview'; }
  });
  const setTab = useCallback((t) => {
    setActiveTab(t);
    setSelectedSourceId(null);
    try { localStorage.setItem(CL_TAB_KEY, t); } catch {}
  }, []);

  // Used for cross-tab navigation links (Overview → Library source)
  const setTabAndSource = useCallback((t, sourceId, sectionId = null) => {
    setActiveTab(t);
    setSelectedSourceId(sourceId);
    setHighlightSectionId(sectionId);
    try { localStorage.setItem(CL_TAB_KEY, t); } catch {}
  }, []);

  // Internal navigation: switch to Notes tab and open a specific note or correction session
  const handleNavigateToNoteInCL = useCallback((noteId) => {
    setLocalNoteTarget(noteId);
    setLocalCorrectionTarget(null);
    setTab('notes');
  }, []);
  const handleNavigateToCorrectionsInCL = useCallback((corrId) => {
    setLocalCorrectionTarget(corrId);
    setLocalNoteTarget(null);
    setTab('notes');
  }, []);

  // Reset local targets when leaving Notes tab so re-clicking the same pill re-triggers the open
  useEffect(() => {
    if (activeTab !== 'notes') {
      setLocalNoteTarget(null);
      setLocalCorrectionTarget(null);
    }
  }, [activeTab]);

  // Gazette ad aliases — same doc DevDashboard Actions tab edits.
  // Loaded once on mount; edits made later in DevDashboard pick up on the
  // next visit to this page, same staleness as everything else here.
  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    getDoc(doc(db, 'users', uid, 'settings', 'gazetteAdAliases'))
      .then(snap => setAdAliases(snap.exists() ? snap.data() : {}))
      .catch(e => console.error('gazetteAdAliases load failed', e));
  }, []);

  // Topbar trigger counters — open CL modals/flows from header buttons.
  // Refs are seeded with the current prop value at mount, so a fresh mount
  // (e.g. leaving CL and coming back) starts "caught up" and doesn't replay
  // a stale trigger from before — only a genuine new increment fires.
  const lastTriggerAddSource     = useRef(triggerAddSource);
  const lastTriggerAddQuestion   = useRef(triggerAddQuestion);
  const lastTriggerAddNote       = useRef(triggerAddNote);
  const lastTriggerAddCorrection = useRef(triggerAddCorrection);

  useEffect(() => {
    if (triggerAddSource > lastTriggerAddSource.current) setShowAddSource(true);
    lastTriggerAddSource.current = triggerAddSource;
  }, [triggerAddSource]);
  useEffect(() => {
    if (triggerAddQuestion > lastTriggerAddQuestion.current) setShowQuickQuestion(true);
    lastTriggerAddQuestion.current = triggerAddQuestion;
  }, [triggerAddQuestion]);
  useEffect(() => {
    if (triggerAddNote > lastTriggerAddNote.current) {
      setPreLinkedData({ key: crypto.randomUUID(), sourceId: null, sectionId: null, mode: 'note' });
      setTab('notes');
    }
    lastTriggerAddNote.current = triggerAddNote;
  }, [triggerAddNote]);
  useEffect(() => {
    if (triggerAddCorrection > lastTriggerAddCorrection.current) {
      setPreLinkedData({ key: crypto.randomUUID(), sourceId: null, sectionId: null, mode: 'correction' });
      setTab('notes');
    }
    lastTriggerAddCorrection.current = triggerAddCorrection;
  }, [triggerAddCorrection]);
  useEffect(() => {
    if (!pendingApptLink) return;
    setPreLinkedData({ key: pendingApptLink.key, apptId: pendingApptLink.apptId, sourceId: null, sectionId: null, mode: pendingApptLink.mode });
    setTab('notes');
    onApptLinkConsumed?.();
  }, [pendingApptLink]);

  // Navigate to Notes tab when targets arrive from other pages (Grammar Index etc.)
  useEffect(() => { if (noteTarget)                               setTab('notes'); }, [noteTarget]);
  useEffect(() => { if (correctionTarget || correctionSessionTarget) setTab('notes'); }, [correctionTarget, correctionSessionTarget]);

  // Pre-link handlers — switch to Notes tab with source/section context
  const handleAddNoteFromSource = useCallback((sourceId) => {
    setPreLinkedData({ key: crypto.randomUUID(), sourceId, sectionId: null, mode: 'note' });
    setTab('notes');
  }, []);
  const handleAddNoteFromSection = useCallback((sourceId, sectionId) => {
    setPreLinkedData({ key: crypto.randomUUID(), sourceId, sectionId, mode: 'note' });
    setTab('notes');
  }, []);
  const handleAddCorrectionFromSource = useCallback((sourceId) => {
    setPreLinkedData({ key: crypto.randomUUID(), sourceId, sectionId: null, mode: 'correction' });
    setTab('notes');
  }, []);
  const handleAddCorrectionFromSection = useCallback((sourceId, sectionId) => {
    setPreLinkedData({ key: crypto.randomUUID(), sourceId, sectionId, mode: 'correction' });
    setTab('notes');
  }, []);

  // Note state sync — keep CL's allNotes/correctionSessions in sync with embedded NotesPage writes
  const handleNoteCreated = useCallback((note) => {
    if (note.type === 'correction') setCorrectionSessions(prev => [note, ...prev]);
    else setAllNotes(prev => [note, ...prev]);
  }, []);
  const handleNoteUpdated = useCallback((note) => {
    if (note.type === 'correction') setCorrectionSessions(prev => prev.map(n => n.id === note.id ? note : n));
    else setAllNotes(prev => prev.map(n => n.id === note.id ? note : n));
  }, []);
  const handleNoteDeleted = useCallback((id) => {
    setAllNotes(prev => prev.filter(n => n.id !== id));
    setCorrectionSessions(prev => prev.filter(n => n.id !== id));
  }, []);

  const handleQuickQuestion = useCallback(async ({ title, tags }, mode = 'close') => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const now = new Date().toISOString();
    const payload = { title, tags, bodyHtml: '<p><br></p>', createdAt: now, updatedAt: now };
    const ref = await addDoc(collection(db, 'users', uid, 'notes'), payload);
    handleNoteCreated({ id: ref.id, ...payload });
    setShowQuickQuestion(false);
    if (mode === 'notes') {
      setLocalNoteTarget(ref.id);
      setLocalCorrectionTarget(null);
      setTab('notes');
    }
  }, [handleNoteCreated]);

  // ── Initial data load ─────────────────────────────────────
  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    (async () => {
      try {
        const [grammarSnap, notesSnap] = await Promise.all([
          getDocs(collection(db, 'users', uid, 'grammar_entries')),
          getDocs(collection(db, 'users', uid, 'notes')),
        ]);
        setGrammarEntries(grammarSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        const allNoteDocs = notesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        setAllNotes(allNoteDocs.filter(n => n.type !== 'correction'));
        setCorrectionSessions(allNoteDocs.filter(n => n.type === 'correction'));
      } catch (e) {
        console.error('ContentLibrary: load failed', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Section content migration (strips source-title prefix, runs once)
  useEffect(() => {
    if (migrationDoneRef.current || !sources.length) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    (async () => {
      try {
        const settingsRef  = doc(db, 'users', uid, 'settings', 'main');
        const settingsSnap = await getDoc(settingsRef);
        if (settingsSnap.data()?.[SECTIONS_MIGRATION_KEY]) { migrationDoneRef.current = true; return; }
        const titleById = {};
        sources.forEach(src => { if (src.id) titleById[src.id] = src.title; });
        const updates = [];
        sections.forEach(sec => {
          const srcTitle = titleById[sec.resourceId];
          if (!srcTitle) return;
          const prefix = srcTitle + ' ';
          if (sec.content?.startsWith(prefix)) {
            const newContent = sec.content.slice(prefix.length).trim();
            if (newContent && newContent !== sec.content) updates.push({ id: sec.id, newContent });
          }
        });
        if (updates.length > 0) {
          setSections(prev => prev.map(s => { const upd = updates.find(u => u.id === s.id); return upd ? { ...s, content: upd.newContent } : s; }));
          const batch = writeBatch(db);
          updates.forEach(({ id, newContent }) => batch.update(doc(db, 'users', uid, 'content_sections', id), { content: newContent }));
          await batch.commit();
        }
        await setDoc(settingsRef, { [SECTIONS_MIGRATION_KEY]: true }, { merge: true });
        migrationDoneRef.current = true;
      } catch (e) { console.error('Section migration failed:', e); }
    })();
  }, [sources, sections]);

  useEffect(() => { if (aviSources?.length && !sources.length) setSources(aviSources.filter(s => !s.isSourceless)); }, [aviSources]);
  useEffect(() => { if (aviSections?.length && !sections.length) setSections(aviSections); }, [aviSections]);

  useEffect(() => {
    if (!defaultOpenSourceId) return;
    setSelectedSourceId(defaultOpenSourceId);
    // Switch to the correct tab depending on whether the source is archived
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const src = sources.find(s => s.id === defaultOpenSourceId);
    const targetTab = src?.archived ? 'archive' : 'library';
    setActiveTab(targetTab);
    try { localStorage.setItem(CL_TAB_KEY, targetTab); } catch {}
  }, [defaultOpenSourceId]); // intentionally omit sources — we read closure value at navigation time

  // Register with App.jsx so toggleTask can update CL's local sections state in-memory
  useEffect(() => {
    registerSectionUpdateCallback?.((sectionId, updates) => {
      setSections(prev => prev.map(s => s.id === sectionId ? { ...s, ...updates } : s));
    });
    return () => { registerSectionUpdateCallback?.(null); };
  }, [registerSectionUpdateCallback]);

  // Pending-archive rollover check — runs once after sources are first populated
  useEffect(() => {
    if (pendingArchiveCheckedRef.current || !sources.length) return;
    pendingArchiveCheckedRef.current = true;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const logicalToday = getLogicalDateStr(dsh);
    const toArchive = sources.filter(s => s.pendingArchive === true && s.pendingArchiveDate && s.pendingArchiveDate < logicalToday);
    if (!toArchive.length) return;
    (async () => {
      const batch = writeBatch(db);
      const secUpdates = [];
      toArchive.forEach(src => {
        batch.update(doc(db, 'users', uid, 'content_sources', src.id), { archived: true, pendingArchive: null, pendingArchiveDate: null });
        sections.filter(s => s.resourceId === src.id && s.status !== 'Done' && s.status !== 'Skip')
          .forEach(sec => { batch.update(doc(db, 'users', uid, 'content_sections', sec.id), { status: 'Skip' }); secUpdates.push(sec.id); });
      });
      await batch.commit().catch(e => console.error('Pending archive rollover failed:', e));
      setSources(prev => prev.map(s => toArchive.find(a => a.id === s.id) ? { ...s, archived: true, pendingArchive: null, pendingArchiveDate: null } : s));
      setSections(prev => prev.map(s => secUpdates.includes(s.id) ? { ...s, status: 'Skip' } : s));
    })();
  }, [sources, dsh]);

  // Sets pendingArchive flag + shows 5-second banner; moves to Archive after next day rollover
  const triggerAutoArchive = useCallback((sourceId) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const logicalToday = getLogicalDateStr(dsh);
    setSources(prev => prev.map(s => s.id === sourceId ? { ...s, pendingArchive: true, pendingArchiveDate: logicalToday } : s));
    setPendingArchiveBannerSourceId(sourceId);
    setTimeout(() => setPendingArchiveBannerSourceId(id => id === sourceId ? null : id), 5000);
    updateDoc(doc(db, 'users', uid, 'content_sources', sourceId), { pendingArchive: true, pendingArchiveDate: logicalToday })
      .catch(e => console.error('Auto-archive flag failed:', e));
  }, [dsh]);

  // ── Section handlers ──────────────────────────────────────
  const handleSectionToggle = useCallback(async (section) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const isDone   = section.status === 'Done';
    const revertTo = section.previousStatus || 'Not started';
    const now      = new Date().toISOString();
    const updates  = isDone
      ? { status: revertTo, previousStatus: null }
      : { status: 'Done', previousStatus: section.status, lastActivityAt: now };
    setSections(prev => prev.map(s => s.id === section.id ? { ...s, ...updates } : s));
    if (!isDone && section.resourceId) setSources(prev => prev.map(s => s.id === section.resourceId ? { ...s, lastActivityAt: now } : s));
    try {
      await updateDoc(doc(db, 'users', uid, 'content_sections', section.id), updates);
      if (!isDone && section.resourceId) await updateDoc(doc(db, 'users', uid, 'content_sources', section.resourceId), { lastActivityAt: now });
    } catch (e) { console.error('Section toggle failed:', e); }
    // Sync: when section → Done, complete the linked task (skip recurring tasks)
    if (!isDone && section.linkedTaskId) {
      const linked = tasks?.find(t => t.id === section.linkedTaskId);
      if (linked && !linked.completed && !(linked.recurrence && linked.recurrence.type !== 'none')) {
        onCompleteLinkedTask?.(section.linkedTaskId);
      }
    }
    // Clear pendingArchive if undoing Done
    if (isDone && section.resourceId) {
      const src = sources.find(s => s.id === section.resourceId);
      if (src?.pendingArchive) {
        setSources(prev => prev.map(s => s.id === section.resourceId ? { ...s, pendingArchive: null, pendingArchiveDate: null } : s));
        updateDoc(doc(db, 'users', uid, 'content_sources', section.resourceId), { pendingArchive: null, pendingArchiveDate: null }).catch(() => {});
      }
    }
    // Auto-archive check when marking Done
    if (!isDone && section.resourceId) {
      const src = sources.find(s => s.id === section.resourceId);
      if (src && !src.archived && !src.pendingArchive && !isPassiveMediaExcluded(src)) {
        const projected = sections.map(s => s.id === section.id ? { ...s, status: 'Done' } : s);
        const srcSections = projected.filter(s => s.resourceId === section.resourceId);
        if (srcSections.length > 0 && srcSections.every(s => s.status === 'Done' || s.status === 'Skip')) {
          triggerAutoArchive(section.resourceId);
        }
      }
    }
  }, [tasks, onCompleteLinkedTask, sections, sources, triggerAutoArchive]);

  const handleCycleStatus = useCallback((sectionId, direction) => {
    const uid = auth.currentUser?.uid;
    const sec = sections.find(s => s.id === sectionId);
    if (!sec) return;
    const cycle   = ['Not started', 'In Progress', 'Skip'];
    const baseIdx = Math.max(0, cycle.indexOf(sec.status || 'Not started'));
    const newStat = cycle[direction === 'forward' ? (baseIdx + 1) % cycle.length : (baseIdx - 1 + cycle.length) % cycle.length];
    clearTimeout(statusDebounceRef.current[sectionId]);
    statusDebounceRef.current[sectionId] = setTimeout(async () => {
      if (!uid) return;
      try { await updateDoc(doc(db, 'users', uid, 'content_sections', sectionId), { status: newStat }); }
      catch (e) { console.error('Status cycle failed:', e); }
    }, 500);
    setSections(prev => prev.map(s => s.id === sectionId ? { ...s, status: newStat } : s));
    if (sec.resourceId) {
      const src = sources.find(s => s.id === sec.resourceId);
      if (src && !src.archived) {
        if (newStat === 'Done' || newStat === 'Skip') {
          if (!src.pendingArchive && !isPassiveMediaExcluded(src)) {
            const projected = sections.map(s => s.id === sectionId ? { ...s, status: newStat } : s);
            const srcSections = projected.filter(s => s.resourceId === sec.resourceId);
            if (srcSections.length > 0 && srcSections.every(s => s.status === 'Done' || s.status === 'Skip')) {
              triggerAutoArchive(sec.resourceId);
            }
          }
        } else if (src.pendingArchive) {
          setSources(prev => prev.map(s => s.id === sec.resourceId ? { ...s, pendingArchive: null, pendingArchiveDate: null } : s));
          if (uid) updateDoc(doc(db, 'users', uid, 'content_sources', sec.resourceId), { pendingArchive: null, pendingArchiveDate: null }).catch(() => {});
        }
      }
    }
  }, [sections, sources, triggerAutoArchive]);

  const handleSectionTitleSave = useCallback(async (section, newTitle, newUrl) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    setSections(prev => prev.map(s => s.id === section.id ? { ...s, content: newTitle, url: newUrl } : s));
    try { await updateDoc(doc(db, 'users', uid, 'content_sections', section.id), { content: newTitle, url: newUrl || null }); }
    catch (e) { console.error('Section title save failed:', e); }
  }, []);

  // ── Source handlers ───────────────────────────────────────
  const handleSourceTitleSave = useCallback(async (source, newTitle, newUrl, newType) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const updates = { title: newTitle, url: newUrl };
    if (newType !== undefined) updates.type = newType;
    if (newTitle !== source.title) onSourceRename?.(source.title, newTitle);
    setSources(prev => prev.map(s => s.id === source.id ? { ...s, ...updates } : s));
    try { await updateDoc(doc(db, 'users', uid, 'content_sources', source.id), updates); }
    catch (e) { console.error('Source save failed:', e); }
  }, [onSourceRename]);

  const handleSourceFieldSave = useCallback(async (source, updates) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    setSources(prev => prev.map(s => s.id === source.id ? { ...s, ...updates } : s));
    try { await updateDoc(doc(db, 'users', uid, 'content_sources', source.id), updates); }
    catch (e) { console.error('Source field save failed:', e); }
  }, []);

  const handleSectionFieldSave = useCallback(async (section, updates) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    setSections(prev => prev.map(s => s.id === section.id ? { ...s, ...updates } : s));
    try { await updateDoc(doc(db, 'users', uid, 'content_sections', section.id), updates); }
    catch (e) { console.error('Section field save failed:', e); }
  }, []);

  const handleDeleteSection = useCallback(async (sectionId) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    setSections(prev => prev.filter(s => s.id !== sectionId));
    try { await deleteDoc(doc(db, 'users', uid, 'content_sections', sectionId)); }
    catch (e) { console.error('Delete section failed:', e); }
  }, []);

  // Phase D3: routes the delete affordance through the cascade confirmation
  // modal.
  const handleDeleteSource = useCallback((sourceId) => {
    const src = sources.find(s => s.id === sourceId);
    if (src) setDeleteSourceTarget(src);
  }, [sources]);

  // Phase D3 Stage 2: the ordered, batched, idempotent delete cascade.
  // Operates on the Firestore-resolved plan, not in-memory arrays.
  const handleConfirmDeleteCascade = useCallback(async (source, plan, onProgress) => {
    const uid = auth.currentUser?.uid;
    if (!uid || !source || source.isSourceless || !plan) return;
    const title      = source.title || '';
    const deckIdSet  = new Set(plan.deckIds);
    const cardIdSet  = new Set(plan.cardIds);
    const sectionIds = new Set(plan.sectionIds);

    let batch = writeBatch(db);
    let ops   = 0;
    const flush = async () => { if (ops === 0) return; await batch.commit(); batch = writeBatch(db); ops = 0; };

    // (1) Ensure the Sourceless source doc exists
    onProgress?.('Preparing Sourceless');
    const slSnap = await getDocs(query(collection(db, 'users', uid, 'content_sources'), where('isSourceless', '==', true)));
    if (slSnap.empty) {
      const slRef = doc(collection(db, 'users', uid, 'content_sources'));
      await setDoc(slRef, { title: 'Sourceless', isSourceless: true, createdAt: new Date().toISOString() });
    }

    // (2) Move AVI entries to Sourceless (server query is authoritative)
    onProgress?.('Moving entries to Sourceless');
    let movedCount = 0;
    const [wSnap, sSnap] = await Promise.all([
      getDocs(query(collection(db, 'users', uid, 'wordInputs'),     where('source', '==', title))),
      getDocs(query(collection(db, 'users', uid, 'sentenceInputs'), where('source', '==', title))),
    ]);
    movedCount = wSnap.docs.length + sSnap.docs.length;
    for (const d of [...wSnap.docs, ...sSnap.docs]) {
      batch.update(d.ref, { source: 'Sourceless' });
      ops++; if (ops >= 450) await flush();
    }
    await flush();

    // (3) Delete the flashcards in the matched decks (from the resolved plan)
    onProgress?.('Deleting flashcards');
    for (const cardId of plan.cardIds) {
      batch.delete(doc(db, 'users', uid, 'flashcards', cardId));
      ops++; if (ops >= 450) await flush();
    }
    // (4) Delete the matched deck docs
    onProgress?.('Deleting decks');
    for (const deckId of plan.deckIds) {
      batch.delete(doc(db, 'users', uid, 'decks', deckId));
      ops++; if (ops >= 450) await flush();
    }
    // (5) Delete the source's sections
    onProgress?.('Deleting sections');
    for (const sectionId of plan.sectionIds) {
      batch.delete(doc(db, 'users', uid, 'content_sections', sectionId));
      ops++; if (ops >= 450) await flush();
    }
    // (6) Delete the source doc LAST
    batch.delete(doc(db, 'users', uid, 'content_sources', source.id));
    ops++;
    await flush();

    // Prune in-memory state by the exact ids we deleted
    updateCards?.(prev => prev ? prev.filter(c => !cardIdSet.has(c.id)) : prev);
    updateDecks?.(prev => prev.filter(d => !deckIdSet.has(d.id)));
    setSections(prev => prev.filter(s => !sectionIds.has(s.id)));
    setSources(prev => prev.filter(s => s.id !== source.id));
    if (selectedSourceId === source.id) setSelectedSourceId(null);

    // (7) Clean links to the deleted source/sections across notes, corrections, questions
    onProgress?.('Cleaning references');
    try {
      const notesSnap = await getDocs(collection(db, 'users', uid, 'notes'));
      let nb = writeBatch(db);
      let nops = 0;
      const nflush = async () => { if (nops === 0) return; await nb.commit(); nb = writeBatch(db); nops = 0; };
      const cleanedIds = [];
      for (const nd of notesSnap.docs) {
        const n = nd.data();
        const patch = {};
        if (n.linkedSectionId && sectionIds.has(n.linkedSectionId)) patch.linkedSectionId = null;
        if (n.linkedSourceId && n.linkedSourceId === source.id)     patch.linkedSourceId  = null;
        const staleLinks = (n.linkedNoteIds || []).filter(id => sectionIds.has(id));
        if (staleLinks.length) patch.linkedNoteIds = arrayRemove(...staleLinks);
        if (Object.keys(patch).length) {
          nb.update(nd.ref, patch);
          cleanedIds.push(nd.id);
          nops++; if (nops >= 450) await nflush();
        }
      }
      await nflush();
      if (cleanedIds.length) {
        const cleanedSet = new Set(cleanedIds);
        const patchNote = (n) => ({
          ...n,
          linkedSectionId: (n.linkedSectionId && sectionIds.has(n.linkedSectionId)) ? null : n.linkedSectionId,
          linkedSourceId:  (n.linkedSourceId === source.id) ? null : n.linkedSourceId,
          linkedNoteIds:   (n.linkedNoteIds || []).filter(id => !sectionIds.has(id)),
        });
        setAllNotes(prev => prev.map(n => cleanedSet.has(n.id) ? patchNote(n) : n));
        setCorrectionSessions(prev => prev.map(n => cleanedSet.has(n.id) ? patchNote(n) : n));
      }
    } catch (e) { console.error('D3: reference cleanup failed', e); }

    onProgress?.('Syncing AVI');
    await onSourceCascadeComplete?.(title);

    onProgress?.('Done');
    setCascadeToast(
      `Deleted ${title} — ${plan.matchedDecks.length} ${plan.matchedDecks.length === 1 ? 'deck' : 'decks'}, ` +
      `${plan.cardIds.length} ${plan.cardIds.length === 1 ? 'card' : 'cards'} removed; ` +
      `${movedCount} ${movedCount === 1 ? 'entry' : 'entries'} moved to Sourceless`
    );
    setTimeout(() => setCascadeToast(null), 6000);
  }, [selectedSourceId, updateCards, updateDecks, onSourceCascadeComplete]);

  const handleSectionOrderSave = useCallback(async (sourceId, orderedIds) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    setSources(prev => prev.map(s => s.id === sourceId ? { ...s, sectionOrder: orderedIds } : s));
    try { await updateDoc(doc(db, 'users', uid, 'content_sources', sourceId), { sectionOrder: orderedIds }); }
    catch (e) { console.error('Section order save failed:', e); }
  }, []);

  // Source-level status cycle (section-less sources); writes sourceStatus field
  const handleCycleSourceStatus = useCallback((sourceId, direction) => {
    const src = sources.find(s => s.id === sourceId);
    if (!src) return;
    const cycle   = ['Not started', 'In Progress', 'Skip'];
    const current = src.sourceStatus ?? src.watchStatus ?? 'Not started';
    const baseIdx = Math.max(0, cycle.indexOf(current));
    const newStatus = cycle[direction === 'forward' ? (baseIdx + 1) % cycle.length : (baseIdx - 1 + cycle.length) % cycle.length];
    clearTimeout(statusDebounceRef.current['src_' + sourceId]);
    statusDebounceRef.current['src_' + sourceId] = setTimeout(async () => {
      const uid = auth.currentUser?.uid;
      if (!uid) return;
      try { await updateDoc(doc(db, 'users', uid, 'content_sources', sourceId), { sourceStatus: newStatus }); }
      catch (e) { console.error('Source status cycle failed:', e); }
    }, 500);
    setSources(prev => prev.map(s => s.id === sourceId ? { ...s, sourceStatus: newStatus } : s));
    const noSecs = !sections.some(s => s.resourceId === sourceId);
    if (noSecs && !src.archived) {
      if ((newStatus === 'Done' || newStatus === 'Skip') && !src.pendingArchive && !isPassiveMediaExcluded(src)) {
        triggerAutoArchive(sourceId);
      } else if (newStatus !== 'Done' && newStatus !== 'Skip' && src.pendingArchive) {
        const uid = auth.currentUser?.uid;
        setSources(prev => prev.map(s => s.id === sourceId ? { ...s, pendingArchive: null, pendingArchiveDate: null } : s));
        if (uid) updateDoc(doc(db, 'users', uid, 'content_sources', sourceId), { pendingArchive: null, pendingArchiveDate: null }).catch(() => {});
      }
    }
  }, [sections, sources, triggerAutoArchive]);

  // Source-level Done toggle (section-less sources); writes sourceStatus field
  const handleSourceToggleDone = useCallback(async (source) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const current = source.sourceStatus ?? source.watchStatus ?? 'Not started';
    const noSecs  = !sections.some(s => s.resourceId === source.id);
    if (current === 'Done') {
      const revertTo = source.previousStatus || 'Not started';
      setSources(prev => prev.map(s => s.id === source.id ? { ...s, sourceStatus: revertTo, previousStatus: null, pendingArchive: null, pendingArchiveDate: null } : s));
      try { await updateDoc(doc(db, 'users', uid, 'content_sources', source.id), { sourceStatus: revertTo, previousStatus: null, pendingArchive: null, pendingArchiveDate: null }); }
      catch (e) { console.error('Source toggle failed:', e); }
    } else {
      const now = new Date().toISOString();
      setSources(prev => prev.map(s => s.id === source.id ? { ...s, sourceStatus: 'Done', previousStatus: current, lastActivityAt: now } : s));
      try { await updateDoc(doc(db, 'users', uid, 'content_sources', source.id), { sourceStatus: 'Done', previousStatus: current, lastActivityAt: now }); }
      catch (e) { console.error('Source toggle failed:', e); }
      if (noSecs && !source.archived && !source.pendingArchive && !isPassiveMediaExcluded(source)) {
        triggerAutoArchive(source.id);
      }
    }
  }, [sections, triggerAutoArchive]);

  const handleOpenScheduleModal = useCallback((section) => {
    const src = sources.find(s => s.id === section.resourceId);
    setScheduleModal({ section, sourceTitle: src?.title || '' });
  }, [sources]);

  const handleConfirmSchedule = useCallback(async (section, date) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const src       = sources.find(s => s.id === section.resourceId);
    const taskTitle = sectionTaskTitle(src?.title || '', section.content);
    const now       = new Date().toISOString();
    // Reschedule: update the existing linked task instead of creating a duplicate
    const existingTask = section.linkedTaskId
      ? tasks?.find(t => t.id === section.linkedTaskId && !t.completed)
      : null;
    let taskId;
    if (existingTask) {
      patchTask?.(existingTask.id, { date });
      taskId = existingTask.id;
    } else {
      if (!addTask) return;
      taskId = addTask({ title: taskTitle, category: 'lang', date, completed: false, linkedSectionId: section.id });
    }
    const updates = { status: 'Scheduled', linkedTaskId: taskId || null, lastActivityAt: now };
    setSections(prev => prev.map(s => s.id === section.id ? { ...s, ...updates } : s));
    if (section.resourceId) setSources(prev => prev.map(s => s.id === section.resourceId ? { ...s, lastActivityAt: now } : s));
    try {
      await updateDoc(doc(db, 'users', uid, 'content_sections', section.id), updates);
      if (section.resourceId) await updateDoc(doc(db, 'users', uid, 'content_sources', section.resourceId), { lastActivityAt: now });
    } catch (e) { console.error('Schedule confirm failed:', e); }
    setScheduleModal(null);
  }, [addTask, patchTask, sources, tasks]);

  const handleAddSource = useCallback(async ({ title, type, url, origin, sectionCount, subtype, levelMin, levelMax, studyIntent }, mode = 'library') => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const srcPayload = {
      title, type, url, origin,
      subtype: subtype || null, levelMin: levelMin || null, levelMax: levelMax || null,
      studyIntent: studyIntent || null, series: null, seriesOrder: null,
      lastActivityAt: null, sourceStatus: 'Not started', createdAt: new Date().toISOString(),
    };
    const srcRef = await addDoc(collection(db, 'users', uid, 'content_sources'), srcPayload);
    setSources(prev => prev.some(s => s.id === srcRef.id) ? prev : [...prev, { id: srcRef.id, ...srcPayload }]);
    if (sectionCount > 0) {
      const newSections = [];
      for (let i = 1; i <= sectionCount; i++) {
        const secPayload = { content: String(i), resourceId: srcRef.id, status: 'Not started', createdAt: new Date().toISOString() };
        const secRef = await addDoc(collection(db, 'users', uid, 'content_sections'), secPayload);
        newSections.push({ id: secRef.id, ...secPayload });
      }
      setSections(prev => [...prev, ...newSections.filter(n => !prev.some(p => p.id === n.id))]);
    }
    setShowAddSource(false);
    if (mode === 'library') setTabAndSource('library', srcRef.id);
  }, []);

  const handleAddSections = useCallback(async (sourceId, count) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const existing = sections.filter(s => s.resourceId === sourceId);
    const maxNum   = existing.reduce((max, s) => { const n = parseInt(s.content); return isNaN(n) ? max : Math.max(max, n); }, 0);
    const newSecs  = [];
    for (let i = 1; i <= count; i++) {
      const secPayload = { content: String(maxNum + i), resourceId: sourceId, status: 'Not started', createdAt: new Date().toISOString() };
      const secRef = await addDoc(collection(db, 'users', uid, 'content_sections'), secPayload);
      newSecs.push({ id: secRef.id, ...secPayload });
    }
    setSections(prev => [...prev, ...newSecs.filter(n => !prev.some(p => p.id === n.id))]);
  }, [sections]);

  // Toggle note link on a section or section-less source.
  // Also writes/clears linkedSourceId on the note document.
  const handleToggleNoteLink = useCallback(async (sec, noteId) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const sourceId      = sec.resourceId ?? sec.id; // sec.id for section-less
    const sectionDocId  = sec.resourceId ? sec.id : null; // null = section-less
    const currentIds    = sec.linkedNoteIds || [];
    const isAdding      = !currentIds.includes(noteId);
    const newIds        = isAdding ? [...currentIds, noteId] : currentIds.filter(id => id !== noteId);

    // Update section or source document
    if (sectionDocId) {
      setSections(prev => prev.map(s => s.id === sectionDocId ? { ...s, linkedNoteIds: newIds } : s));
      try { await updateDoc(doc(db, 'users', uid, 'content_sections', sectionDocId), { linkedNoteIds: newIds }); }
      catch (e) { console.error('Toggle note link (section) failed:', e); }
    } else {
      setSources(prev => prev.map(s => s.id === sourceId ? { ...s, linkedNoteIds: newIds } : s));
      try { await updateDoc(doc(db, 'users', uid, 'content_sources', sourceId), { linkedNoteIds: newIds }); }
      catch (e) { console.error('Toggle note link (source) failed:', e); }
    }

    // Update linkedSourceId on the note document
    if (isAdding) {
      setAllNotes(prev => prev.map(n => n.id === noteId ? { ...n, linkedSourceId: sourceId } : n));
      try { await updateDoc(doc(db, 'users', uid, 'notes', noteId), { linkedSourceId: sourceId }); }
      catch (e) { console.error('Set note linkedSourceId failed:', e); }
    } else {
      // Clear linkedSourceId only if no other section in this source still links to this note
      const stillLinked = sections.some(s =>
        (s.resourceId ?? null) === (sec.resourceId ?? null) &&
        s.id !== sectionDocId &&
        (s.linkedNoteIds || []).includes(noteId)
      );
      if (!stillLinked) {
        setAllNotes(prev => prev.map(n => n.id === noteId ? { ...n, linkedSourceId: null } : n));
        try { await updateDoc(doc(db, 'users', uid, 'notes', noteId), { linkedSourceId: null }); }
        catch (e) { console.error('Clear note linkedSourceId failed:', e); }
      }
    }
  }, [sections]);

  // Link two sources (grammar-practice or companion). Both sides updated atomically.
  // role: 'primary'   → current source is secondary, target is primary
  // role: 'secondary' → current source is primary, target is secondary
  // role: 'companion' → both sides get companion link
  const handleLinkSources = useCallback(async (currentId, targetId, role) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const currentSrc = sources.find(s => s.id === currentId);
    const targetSrc  = sources.find(s => s.id === targetId);
    if (!currentSrc || !targetSrc) return;
    const batch      = writeBatch(db);
    const currentRef = doc(db, 'users', uid, 'content_sources', currentId);
    const targetRef  = doc(db, 'users', uid, 'content_sources', targetId);
    if (role === 'primary') {
      batch.update(currentRef, { linkedGrammarSourceId: targetId });
      batch.update(targetRef,  { linkedPracticeSourceIds: [...(targetSrc.linkedPracticeSourceIds || []), currentId] });
      setSources(prev => prev.map(s => {
        if (s.id === currentId) return { ...s, linkedGrammarSourceId: targetId };
        if (s.id === targetId)  return { ...s, linkedPracticeSourceIds: [...(s.linkedPracticeSourceIds || []), currentId] };
        return s;
      }));
    } else if (role === 'secondary') {
      batch.update(currentRef, { linkedPracticeSourceIds: [...(currentSrc.linkedPracticeSourceIds || []), targetId] });
      batch.update(targetRef,  { linkedGrammarSourceId: currentId });
      setSources(prev => prev.map(s => {
        if (s.id === currentId) return { ...s, linkedPracticeSourceIds: [...(s.linkedPracticeSourceIds || []), targetId] };
        if (s.id === targetId)  return { ...s, linkedGrammarSourceId: currentId };
        return s;
      }));
    } else if (role === 'companion') {
      batch.update(currentRef, { linkedCompanionIds: [...(currentSrc.linkedCompanionIds || []), targetId] });
      batch.update(targetRef,  { linkedCompanionIds: [...(targetSrc.linkedCompanionIds || []), currentId] });
      setSources(prev => prev.map(s => {
        if (s.id === currentId) return { ...s, linkedCompanionIds: [...(s.linkedCompanionIds || []), targetId] };
        if (s.id === targetId)  return { ...s, linkedCompanionIds: [...(s.linkedCompanionIds || []), currentId] };
        return s;
      }));
    }
    try { await batch.commit(); }
    catch (e) { console.error('Link sources failed:', e); }
  }, [sources]);

  // Unlink two sources (detects relationship type automatically, removes both sides)
  const handleUnlinkSources = useCallback(async (currentId, targetId) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const currentSrc = sources.find(s => s.id === currentId);
    const targetSrc  = sources.find(s => s.id === targetId);
    if (!currentSrc) return;
    const batch      = writeBatch(db);
    const currentRef = doc(db, 'users', uid, 'content_sources', currentId);
    const targetRef  = doc(db, 'users', uid, 'content_sources', targetId);
    if (currentSrc.linkedGrammarSourceId === targetId) {
      // current = secondary, target = primary
      batch.update(currentRef, { linkedGrammarSourceId: null });
      batch.update(targetRef,  { linkedPracticeSourceIds: (targetSrc?.linkedPracticeSourceIds || []).filter(id => id !== currentId) });
      setSources(prev => prev.map(s => {
        if (s.id === currentId) return { ...s, linkedGrammarSourceId: null };
        if (s.id === targetId)  return { ...s, linkedPracticeSourceIds: (s.linkedPracticeSourceIds || []).filter(id => id !== currentId) };
        return s;
      }));
    } else if ((currentSrc.linkedPracticeSourceIds || []).includes(targetId)) {
      // current = primary, target = secondary
      batch.update(currentRef, { linkedPracticeSourceIds: (currentSrc.linkedPracticeSourceIds || []).filter(id => id !== targetId) });
      batch.update(targetRef,  { linkedGrammarSourceId: null });
      setSources(prev => prev.map(s => {
        if (s.id === currentId) return { ...s, linkedPracticeSourceIds: (s.linkedPracticeSourceIds || []).filter(id => id !== targetId) };
        if (s.id === targetId)  return { ...s, linkedGrammarSourceId: null };
        return s;
      }));
    } else if ((currentSrc.linkedCompanionIds || []).includes(targetId)) {
      // companion link
      batch.update(currentRef, { linkedCompanionIds: (currentSrc.linkedCompanionIds || []).filter(id => id !== targetId) });
      batch.update(targetRef,  { linkedCompanionIds: (targetSrc?.linkedCompanionIds || []).filter(id => id !== currentId) });
      setSources(prev => prev.map(s => {
        if (s.id === currentId) return { ...s, linkedCompanionIds: (s.linkedCompanionIds || []).filter(id => id !== targetId) };
        if (s.id === targetId)  return { ...s, linkedCompanionIds: (s.linkedCompanionIds || []).filter(id => id !== currentId) };
        return s;
      }));
    }
    try { await batch.commit(); }
    catch (e) { console.error('Unlink sources failed:', e); }
  }, [sources]);

  const handleArchiveSource = useCallback(async (sourceId) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const sectionsToSkip = sections.filter(s => s.resourceId === sourceId && s.status !== 'Done' && s.status !== 'Skip');
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', uid, 'content_sources', sourceId), { archived: true, pendingArchive: null, pendingArchiveDate: null });
    sectionsToSkip.forEach(sec => batch.update(doc(db, 'users', uid, 'content_sections', sec.id), { status: 'Skip' }));
    setSources(prev => prev.map(s => s.id === sourceId ? { ...s, archived: true, pendingArchive: null, pendingArchiveDate: null } : s));
    setSections(prev => prev.map(s => sectionsToSkip.find(sk => sk.id === s.id) ? { ...s, status: 'Skip' } : s));
    if (selectedSourceId === sourceId) setSelectedSourceId(null);
    try { await batch.commit(); } catch (e) { console.error('Archive source failed:', e); }
  }, [sections, selectedSourceId]);

  const handleRestoreSource = useCallback(async (sourceId) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const sectionsToRestore = sections.filter(s => s.resourceId === sourceId && s.status === 'Skip');
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', uid, 'content_sources', sourceId), { archived: false, pendingArchive: null, pendingArchiveDate: null });
    sectionsToRestore.forEach(sec => batch.update(doc(db, 'users', uid, 'content_sections', sec.id), { status: 'Not started' }));
    setSources(prev => prev.map(s => s.id === sourceId ? { ...s, archived: false, pendingArchive: null, pendingArchiveDate: null } : s));
    setSections(prev => prev.map(s => sectionsToRestore.find(sk => sk.id === s.id) ? { ...s, status: 'Not started' } : s));
    if (selectedSourceId === sourceId) setSelectedSourceId(null);
    try { await batch.commit(); } catch (e) { console.error('Restore source failed:', e); }
  }, [sections, selectedSourceId]);

  const handleBulkArchive = useCallback(async (sourceIds) => {
    const uid = auth.currentUser?.uid;
    if (!uid || !sourceIds.length) return;
    const batch = writeBatch(db);
    const secUpdates = [];
    sourceIds.forEach(sourceId => {
      batch.update(doc(db, 'users', uid, 'content_sources', sourceId), { archived: true, pendingArchive: null, pendingArchiveDate: null });
      sections.filter(s => s.resourceId === sourceId && s.status !== 'Done' && s.status !== 'Skip')
        .forEach(sec => { batch.update(doc(db, 'users', uid, 'content_sections', sec.id), { status: 'Skip' }); secUpdates.push(sec.id); });
    });
    setSources(prev => prev.map(s => sourceIds.includes(s.id) ? { ...s, archived: true, pendingArchive: null, pendingArchiveDate: null } : s));
    setSections(prev => prev.map(s => secUpdates.includes(s.id) ? { ...s, status: 'Skip' } : s));
    if (sourceIds.includes(selectedSourceId)) setSelectedSourceId(null);
    try { await batch.commit(); } catch (e) { console.error('Bulk archive failed:', e); }
  }, [sections, selectedSourceId]);

  const handleBulkRestore = useCallback(async (sourceIds) => {
    const uid = auth.currentUser?.uid;
    if (!uid || !sourceIds.length) return;
    const batch = writeBatch(db);
    const secUpdates = [];
    sourceIds.forEach(sourceId => {
      batch.update(doc(db, 'users', uid, 'content_sources', sourceId), { archived: false, pendingArchive: null, pendingArchiveDate: null });
      sections.filter(s => s.resourceId === sourceId && s.status === 'Skip')
        .forEach(sec => { batch.update(doc(db, 'users', uid, 'content_sections', sec.id), { status: 'Not started' }); secUpdates.push(sec.id); });
    });
    setSources(prev => prev.map(s => sourceIds.includes(s.id) ? { ...s, archived: false, pendingArchive: null, pendingArchiveDate: null } : s));
    setSections(prev => prev.map(s => secUpdates.includes(s.id) ? { ...s, status: 'Not started' } : s));
    try { await batch.commit(); } catch (e) { console.error('Bulk restore failed:', e); }
  }, [sections]);

  // ── Derived data ──────────────────────────────────────────
  const sectionsBySource = useMemo(() => {
    const map = {};
    const titleToId = {};
    sources.forEach(src => { titleToId[src.title?.toLowerCase()] = src.id; });
    sections.forEach(sec => {
      let key = sec.resourceId || null;
      if (!key && sec.resourceRaw) key = titleToId[sec.resourceRaw.toLowerCase()] || null;
      if (!key) return;
      if (!map[key]) map[key] = [];
      map[key].push(sec);
    });
    const naturalKey = str => { const parts = []; (str || '').replace(/(\d+)|(\D+)/g, (_, num, txt) => { parts.push(num ? parseInt(num, 10) : txt.toLowerCase()); }); return parts; };
    const naturalCompare = (a, b) => { const ka = naturalKey(a.content), kb = naturalKey(b.content); for (let i = 0; i < Math.max(ka.length, kb.length); i++) { const av = ka[i] ?? '', bv = kb[i] ?? ''; if (av < bv) return -1; if (av > bv) return 1; } return 0; };
    Object.keys(map).forEach(key => {
      const src = sources.find(s => s.id === key);
      const order = src?.sectionOrder;
      if (order?.length) {
        const orderMap = Object.fromEntries(order.map((id, i) => [id, i]));
        map[key].sort((a, b) => { const ai = orderMap[a.id] ?? Infinity, bi = orderMap[b.id] ?? Infinity; return ai !== bi ? ai - bi : naturalCompare(a, b); });
      } else {
        map[key].sort((a, b) => { const aI = a.content?.toLowerCase().includes('information') ? 0 : 1, bI = b.content?.toLowerCase().includes('information') ? 0 : 1; return aI !== bI ? aI - bI : naturalCompare(a, b); });
      }
    });
    return map;
  }, [sections, sources]);

  // Source-level AVI totals derived from section counts (which are confirmed correct)
  const wordCountBySource = useMemo(() => {
    const r = {};
    Object.entries(aviWordSectionCounts || {}).forEach(([k, v]) => {
      const i = k.lastIndexOf('|');
      if (i > -1) { const s = k.slice(0, i); r[s] = (r[s] || 0) + v; }
    });
    return r;
  }, [aviWordSectionCounts]);

  const sentCountBySource = useMemo(() => {
    const r = {};
    Object.entries(aviSentSectionCounts || {}).forEach(([k, v]) => {
      const i = k.lastIndexOf('|');
      if (i > -1) { const s = k.slice(0, i); r[s] = (r[s] || 0) + v; }
    });
    return r;
  }, [aviSentSectionCounts]);

  // Family-grouped (TYPES order), alphabetical within each family; excludes archived sources
  const visible = useMemo(() => {
    let list = sources.filter(s => !s.archived);
    list = list.filter(s => matchesTypeFilter(s, typeFilter));
    if (search.trim()) { const q = search.trim().toLowerCase(); list = list.filter(s => s.title?.toLowerCase().includes(q) || s.origin?.toLowerCase().includes(q) || s.type?.toLowerCase().includes(q)); }
    return [...list].sort((a, b) => (familySortIndex(a) - familySortIndex(b)) || (a.title || '').localeCompare(b.title || ''));
  }, [sources, typeFilter, search]);

  const visibleArchived = useMemo(() => {
    let list = sources.filter(s => s.archived === true);
    list = list.filter(s => matchesTypeFilter(s, archiveTypeFilter));
    if (archiveSearch.trim()) { const q = archiveSearch.trim().toLowerCase(); list = list.filter(s => s.title?.toLowerCase().includes(q) || s.origin?.toLowerCase().includes(q) || s.type?.toLowerCase().includes(q)); }
    return [...list].sort((a, b) => (familySortIndex(a) - familySortIndex(b)) || (a.title || '').localeCompare(b.title || ''));
  }, [sources, archiveTypeFilter, archiveSearch]);

  const totalDone    = useMemo(() => sections.filter(s => s.status === 'Done').length, [sections]);  const selectedSource = useMemo(() => sources.find(s => s.id === selectedSourceId) || null, [sources, selectedSourceId]);

  const tabBarRef     = useRef(null);
  const sourceListRef = useRef(null);
  const [tabBarH, setTabBarH] = useState(46);
  useLayoutEffect(() => {
    if (tabBarRef.current) setTabBarH(tabBarRef.current.offsetHeight + 8);
  }, []);

  // ↑/↓ navigate the Library tab's source list; Escape closes the detail panel.
  // No-ops automatically when focus is in any search box or modal input.
  useGlobalKey(e => {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') { if (selectedSourceId) setSelectedSourceId(null); return; }
    const currentIdx = visible.findIndex(s => s.id === selectedSourceId);
    const nextIdx = e.key === 'ArrowDown'
      ? (currentIdx < visible.length - 1 ? currentIdx + 1 : 0)
      : (currentIdx > 0 ? currentIdx - 1 : visible.length - 1);
    const nextSource = visible[nextIdx];
    if (!nextSource) return;
    setSelectedSourceId(nextSource.id);
    sourceListRef.current
      ?.querySelector(`[data-source-id="${nextSource.id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, { enabled: activeTab === 'library' && visible.length > 0 });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', color: C.textM, fontSize: '13px' }}>Loading content library…</div>;

  const TAB_LABELS = { overview: 'Overview', library: 'Library', notes: 'Notes', archive: 'Archive' };

  return (
    <>
      <style>{`
        .source-row-wrap:hover .edit-pencil,
        .section-row:hover .edit-pencil { opacity: 0.5 !important; }
        .edit-pencil:hover { opacity: 1 !important; }
        .sec-action-btn:hover { border-color: var(--accent) !important; color: var(--accent) !important; }
        .cl-scroll-area::-webkit-scrollbar { display: none; }
        @keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
        .cl-mobile-overlay { animation: slideInRight 0.22s ease both; }
      `}</style>

      {/* Tab bar */}
      <div ref={tabBarRef} style={{ marginBottom: '8px', display: 'flex', justifyContent: isMobile ? 'center' : 'flex-start' }}>
        <div style={{ display: 'flex', gap: '4px', background: C.cardBg || C.surface, border: `1px solid ${C.border}`, padding: '4px', borderRadius: '12px', width: 'fit-content' }}>
          {['overview', 'library', 'notes', 'archive'].map(t => {
            const active = activeTab === t;
            return (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: '6px 14px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 500,
                color: active ? C.text : C.textS, cursor: 'pointer', transition: 'all 0.15s',
                background: active ? C.raised : 'transparent',
                boxShadow: active ? '0 1px 4px rgba(0,0,0,0.2)' : 'none',
                border: 'none', whiteSpace: 'nowrap',
              }}>{TAB_LABELS[t]}</button>
            );
          })}
        </div>
      </div>

      {activeTab === 'library' && (
        <>
          <div style={{ display: 'flex', margin: '0 -28px -28px', height: `calc(100% + 28px - ${tabBarH}px)`, overflow: 'hidden' }}>

            {/* LEFT: source list */}
            <div style={{ width: isMobile ? '100%' : '400px', minWidth: isMobile ? 0 : '400px', flexShrink: isMobile ? 1 : 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: `1px solid ${C.border}` }}>
              <div style={{ padding: '16px 14px 0', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                  <input type="text" placeholder="Search sources…" value={search} onChange={e => setSearch(e.target.value)}
                    style={{ ...S.formInput, flex: 1, fontSize: '12px', margin: 0 }} />
                  <button onClick={() => { setArchiveMgmtMode('archive'); setArchiveMgmtOpen(true); }}
                    style={{ fontSize: '11px', padding: '0 10px', height: '34px', borderRadius: '8px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {isMobile ? 'Manage' : 'Archive Management'}
                  </button>
                </div>
                {/* Type filter tabs */}
                <div style={{ display: 'flex', gap: '4px', overflowX: 'auto', paddingBottom: '8px', marginBottom: '4px' }}>
                  {FILTER_CHIPS.map(({ id, label }) => {
                    const active = typeFilter === id;
                    const col    = chipColor(id, C);
                    return (
                      <button key={id} onClick={() => setTypeFilter(id)} style={{
                        padding: '3px 10px', borderRadius: '12px', fontSize: '11px', whiteSpace: 'nowrap',
                        border: `1px solid ${active ? col : C.border}`,
                        background: active ? `${col}18` : 'transparent',
                        color: active ? col : C.textM, cursor: 'pointer', flexShrink: 0,
                      }}>{label}</button>
                    );
                  })}
                </div>
              </div>
              <div ref={sourceListRef} style={{ flex: 1, overflowY: 'auto', paddingBottom: isMobile ? '80px' : 0 }}>
                {visible.length === 0 ? (
                  <div style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '12px', fontStyle: 'italic' }}>No sources found</div>
                ) : visible.map((source, idx) => {
                  const fam       = familyOf(source);
                  const newFamily = idx === 0 || familyOf(visible[idx - 1]) !== fam;
                  return (
                  <div key={source.id} data-source-id={source.id}>
                  {newFamily && <FamilyHeader family={fam} />}
                  <SourceRow source={source}
                    sections={sectionsBySource[source.id] || []}
                    isSelected={selectedSourceId === source.id}
                    wordCount={wordCountBySource[source.title] || 0}
                    sentCount={sentCountBySource[source.title] || 0}
                    onSelect={() => setSelectedSourceId(source.id === selectedSourceId ? null : source.id)} />
                  </div>
                  );
                })}
              </div>
            </div>

            {/* CENTER: image — hidden when the main area is too narrow;
                App.jsx computes showDecoPanel from live window width minus
                current sidebar width (E1: reactive, sidebar-aware) */}
            {showDecoPanel && (
              <div style={{ flex: 1, position: 'relative', overflow: 'hidden', pointerEvents: 'none', flexShrink: 1, minWidth: 0 }}>
                {decoDividerSrc
                  ? <img src={decoDividerSrc} alt="" aria-hidden="true" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center center', opacity: 0.88 }} />
                  : <div style={{ ...decoBlockStyle(C), position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.5 }} />}
              </div>
            )}

            {/* RIGHT: detail panel slot — always rendered */}
            {selectedSource ? (
              <SourceDetailPanel
                key={selectedSourceId}
                dsh={dsh}
                source={selectedSource}
                sections={sectionsBySource[selectedSource.id] || []}
                grammarEntries={grammarEntries}
                allNotes={allNotes}
                correctionSessions={correctionSessions}
                allSources={sources}
                aviWordCounts={aviWordCounts}
                aviSentenceCounts={aviSentenceCounts}
                aviWordSectionCounts={aviWordSectionCounts}
                aviSentSectionCounts={aviSentSectionCounts}
                tasks={tasks}
                onNavigateToGrammar={onNavigateToGrammar}
                onNavigateToNote={handleNavigateToNoteInCL}
                onNavigateToCorrection={handleNavigateToCorrectionsInCL}
                onSectionToggle={handleSectionToggle}
                onSectionTitleSave={handleSectionTitleSave}
                onSourceTitleSave={handleSourceTitleSave}
                onSourceFieldSave={handleSourceFieldSave}
                onScheduleSection={handleOpenScheduleModal}
                onCycleStatus={handleCycleStatus}
                onCycleSourceStatus={handleCycleSourceStatus}
                onSourceToggleDone={handleSourceToggleDone}
                onSectionFieldSave={handleSectionFieldSave}
                onSectionOrderSave={handleSectionOrderSave}
                onDeleteSection={handleDeleteSection}
                onDeleteSource={handleDeleteSource}
                onAddSections={handleAddSections}
                onAddNote={handleAddNoteFromSource}
                onAddCorrection={handleAddCorrectionFromSource}
                onAddNoteFromSection={handleAddNoteFromSection}
                onAddCorrectionFromSection={handleAddCorrectionFromSection}
                onLinkSources={handleLinkSources}
                onUnlinkSources={handleUnlinkSources}
                onToggleNoteLink={handleToggleNoteLink}
                onArchiveSource={handleArchiveSource}
                onRestoreSource={handleRestoreSource}
                isPendingArchive={selectedSourceId === pendingArchiveBannerSourceId}
                isOverlay={isMobile}
                onClose={() => setSelectedSourceId(null)}
              />
            ) : !isMobile ? (
              <div style={{ width: '600px', minWidth: '600px', height: '100%', borderLeft: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
                <span style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', textAlign: 'center', lineHeight: 1.6 }}>
                  Select a source to view details. Completed sources auto-archive after rollover.
                </span>
              </div>
            ) : null}
          </div>

          {scheduleModal && (
            <ScheduleSectionModal
              section={scheduleModal.section}
              sourceTitle={scheduleModal.sourceTitle || ''}
              tasks={tasks}
              onSave={handleConfirmSchedule}
              onClose={() => setScheduleModal(null)}
              C={C} S={S} dsh={dsh}
            />
          )}
          </>
      )}

      {activeTab === 'overview' && (
        <ContentLibraryGazette
          sources={sources}
          sections={sections}
          sectionsBySource={sectionsBySource}
          allNotes={allNotes}
          correctionSessions={correctionSessions}
          grammarEntries={grammarEntries}
          grammarMasteryCounts={grammarMasteryCounts}
          appointments={appointments}
          cards={cards}
          decks={decks}
          adriftDays={adriftDays}
          dsh={dsh}
          onNavigateToSource={setTabAndSource}
          onNavigateToNote={handleNavigateToNoteInCL}
          onNavigateToCorrection={handleNavigateToCorrectionsInCL}
          wordInputs={wordInputs}
          sentenceInputs={sentenceInputs}
          adAliases={adAliases}
        />
      )}
      {activeTab === 'notes' && (
        <div style={{ margin: '0 -28px -28px', height: `calc(100% + 28px - ${tabBarH}px)`, overflow: 'hidden', display: 'flex' }}>
        <NotesPage
          embedded
          defaultOpenNoteId={localNoteTarget || noteTarget}
          defaultCorrectionSourceId={correctionTarget}
          defaultOpenCorrectionId={localCorrectionTarget || correctionSessionTarget}
          preLinkedData={preLinkedData}
          onPreLinkConsumed={() => setPreLinkedData(null)}
          initNotes={allNotes}
          initCorrections={correctionSessions}
          initGrammarEntries={grammarEntries}
          initSources={sources}
          initSections={sections}
          onNoteCreated={handleNoteCreated}
          onNoteUpdated={handleNoteUpdated}
          onNoteDeleted={handleNoteDeleted}
          onNavigateToGrammar={onNavigateToGrammar}
          onNavigateToContent={(sourceId, sectionId) => {
            const src = sources.find(s => s.id === sourceId);
            setTabAndSource(src?.archived ? 'archive' : 'library', sourceId, sectionId);
          }}
          appointments={appointments}
        />
        </div>
      )}

      {activeTab === 'archive' && (
        <>
          <div style={{ display: 'flex', margin: '0 -28px -28px', height: `calc(100% + 28px - ${tabBarH}px)`, overflow: 'hidden' }}>
            <div style={{ width: isMobile ? '100%' : '400px', minWidth: isMobile ? 0 : '400px', flexShrink: isMobile ? 1 : 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: `1px solid ${C.border}` }}>
              <div style={{ padding: '16px 14px 0', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                  <input type="text" placeholder="Search archive…" value={archiveSearch} onChange={e => setArchiveSearch(e.target.value)}
                    style={{ ...S.formInput, flex: 1, fontSize: '12px', margin: 0 }} />
                  <button onClick={() => { setArchiveMgmtMode('restore'); setArchiveMgmtOpen(true); }}
                    style={{ fontSize: '11px', padding: '0 10px', height: '34px', borderRadius: '8px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {isMobile ? 'Manage' : 'Archive Management'}
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '4px', overflowX: 'auto', paddingBottom: '8px', marginBottom: '4px' }}>
                  {FILTER_CHIPS.map(({ id, label }) => {
                    const active = archiveTypeFilter === id;
                    const col    = chipColor(id, C);
                    return (
                      <button key={id} onClick={() => setArchiveTypeFilter(id)} style={{ padding: '3px 10px', borderRadius: '12px', fontSize: '11px', whiteSpace: 'nowrap', border: `1px solid ${active ? col : C.border}`, background: active ? `${col}18` : 'transparent', color: active ? col : C.textM, cursor: 'pointer', flexShrink: 0 }}>{label}</button>
                    );
                  })}
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', paddingBottom: isMobile ? '80px' : 0 }}>
                {visibleArchived.length === 0 ? (
                  <div style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '12px', fontStyle: 'italic' }}>No archived sources</div>
                ) : visibleArchived.map((source, idx) => {
                  const fam       = familyOf(source);
                  const newFamily = idx === 0 || familyOf(visibleArchived[idx - 1]) !== fam;
                  return (
                  <div key={source.id}>
                  {newFamily && <FamilyHeader family={fam} />}
                  <SourceRow source={source}
                    sections={sectionsBySource[source.id] || []}
                    isSelected={selectedSourceId === source.id}
                    wordCount={wordCountBySource[source.title] || 0}
                    sentCount={sentCountBySource[source.title] || 0}
                    onSelect={() => setSelectedSourceId(source.id === selectedSourceId ? null : source.id)} />
                  </div>
                  );
                })}
              </div>
            </div>
            {showDecoPanel && (
              <div style={{ flex: 1, position: 'relative', overflow: 'hidden', pointerEvents: 'none', flexShrink: 1, minWidth: 0 }}>
                {decoDividerSrc
                  ? <img src={decoDividerSrc} alt="" aria-hidden="true" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center center', opacity: 0.88 }} />
                  : <div style={{ ...decoBlockStyle(C), position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.5 }} />}
              </div>
            )}
            {selectedSource ? (
              <SourceDetailPanel
                key={selectedSourceId}
                dsh={dsh}
                source={selectedSource}
                sections={sectionsBySource[selectedSource.id] || []}
                grammarEntries={grammarEntries}
                allNotes={allNotes}
                correctionSessions={correctionSessions}
                allSources={sources}
                aviWordCounts={aviWordCounts}
                aviSentenceCounts={aviSentenceCounts}
                aviWordSectionCounts={aviWordSectionCounts}
                aviSentSectionCounts={aviSentSectionCounts}
                tasks={tasks}
                onNavigateToGrammar={onNavigateToGrammar}
                onNavigateToNote={handleNavigateToNoteInCL}
                onNavigateToCorrection={handleNavigateToCorrectionsInCL}
                onSectionToggle={handleSectionToggle}
                onSectionTitleSave={handleSectionTitleSave}
                onSourceTitleSave={handleSourceTitleSave}
                onSourceFieldSave={handleSourceFieldSave}
                onScheduleSection={handleOpenScheduleModal}
                onCycleStatus={handleCycleStatus}
                onCycleSourceStatus={handleCycleSourceStatus}
                onSourceToggleDone={handleSourceToggleDone}
                onSectionFieldSave={handleSectionFieldSave}
                onSectionOrderSave={handleSectionOrderSave}
                onDeleteSection={handleDeleteSection}
                onDeleteSource={handleDeleteSource}
                onAddSections={handleAddSections}
                onAddNote={handleAddNoteFromSource}
                onAddCorrection={handleAddCorrectionFromSource}
                onAddNoteFromSection={handleAddNoteFromSection}
                onAddCorrectionFromSection={handleAddCorrectionFromSection}
                onLinkSources={handleLinkSources}
                onUnlinkSources={handleUnlinkSources}
                onToggleNoteLink={handleToggleNoteLink}
                onArchiveSource={handleArchiveSource}
                onRestoreSource={handleRestoreSource}
                isPendingArchive={selectedSourceId === pendingArchiveBannerSourceId}
                highlightSectionId={highlightSectionId}
                onHighlightClear={() => setHighlightSectionId(null)}
                isOverlay={isMobile}
                onClose={() => setSelectedSourceId(null)}              
              />
            ) : !isMobile ? (
              <div style={{ width: '600px', minWidth: '600px', height: '100%', borderLeft: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
                <span style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', textAlign: 'center', lineHeight: 1.6 }}>
                  Select a source to view details. Completed sources auto-archive after rollover.
                </span>
              </div>
            ) : null}
          </div>
        </>
      )}

      {archiveMgmtOpen && (
        <ArchiveManagementModal
          sources={sources}
          onArchiveSelected={handleBulkArchive}
          onRestoreSelected={handleBulkRestore}
          defaultMode={archiveMgmtMode}
          onClose={() => setArchiveMgmtOpen(false)}
          C={C} S={S}
        />
      )}
      {showAddSource     && <AddSourceModal     onSave={handleAddSource}    onClose={() => setShowAddSource(false)}    C={C} S={S} />}
      {showQuickQuestion && <QuickQuestionModal onSave={handleQuickQuestion} onClose={() => setShowQuickQuestion(false)} C={C} S={S} />}
      {deleteSourceTarget && (
        <DeleteSourceCascadeModal
          source={deleteSourceTarget}
          C={C} S={S}
          onConfirm={handleConfirmDeleteCascade}
          onCancel={() => setDeleteSourceTarget(null)}
        />
      )}
      {cascadeToast && <div style={S.toast}>{cascadeToast}</div>}
    </>
  );
}
