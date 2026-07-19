// src/pages/NotesPage.jsx
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  collection, getDocs, doc, addDoc, updateDoc, deleteDoc,
} from 'firebase/firestore';
import { db, auth } from '../firebase.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { Icons } from '../components/Icons.jsx';
import { decoDividerSrc, decoBlockStyle } from '../utils/decoAssets.js';
import { DEMO } from '../demo/demoConfig.js';

const PRESET_TAGS = ['vocabulary', 'grammar', 'reading', 'listening', 'speaking', 'writing', 'culture', 'review', 'question'];
const TAB_KEY = 'avi_notes_tab';
const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

// ── Helpers ───────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Delete confirm ────────────────────────────────────────────
function DeleteConfirm({ onConfirm, onCancel, C, S }) {
  return (
    <div style={S.confirmOverlay}>
      <div style={S.confirmBox}>
        <div style={S.confirmTitle}>Delete?</div>
        <div style={S.confirmMsg}>This cannot be undone.</div>
        <div style={S.confirmActions}>
          <button style={S.btnGhost} onClick={onCancel}>Cancel</button>
          <button style={S.btnDanger} onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── Markdown-to-HTML migration helper ────────────────────────
// Runs once on load for notes that have a legacy `body` string but no `bodyHtml`.
function mdToHtml(md) {
  if (!md) return '';
  return md
    .split('\n')
    .map(line => {
      let h = line
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/~~(.+?)~~/g,     '<s>$1</s>')
        .replace(/_(.+?)_/g,       '<em>$1</em>')
        .replace(/`(.+?)`/g,       '<code>$1</code>')
        .replace(/^- (.+)/,        '<li>$1</li>');
      return h || '<br>';
    })
    .join('\n');
}

// Strip all HTML tags — used for the NoteCard plain-text preview.
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<details[^>]*>[\s\S]*?<\/details>/gi, '[toggle]')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── Multi-picker modal (shared by Grammar and Section pickers) ─
function MultiPickerModal({ label, items, selectedIds, onToggle, onClose, renderItem, C, S }) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(it => it._searchText?.toLowerCase().includes(q));
  }, [items, search]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: '16px', border: `1px solid ${C.border}`,
        width: '420px', maxWidth: '92vw', maxHeight: '72vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '18px 20px 12px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontFamily: SH.fd, fontSize: '16px', color: C.text }}>{label}</span>
          <button onClick={onClose} style={{ color: C.textM, fontSize: '18px', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '12px 20px', flexShrink: 0 }}>
          <input autoFocus style={S.formInput} placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 16px' }}>
          {filtered.map(it => {
            const isSelected = (selectedIds || []).includes(it.id);
            return (
              <div key={it.id} onClick={() => onToggle(it.id)}
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
                {renderItem(it, isSelected)}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ fontSize: '13px', color: C.textM, fontStyle: 'italic', paddingTop: '8px' }}>No results.</div>
          )}
        </div>
        <div style={{ padding: '12px 20px', borderTop: `1px solid ${C.border}`, flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
          <button style={{ ...S.btnPrimary, ...S.btnMetallic }} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Correction link picker modal (source OR section, single-select) ─
function CorrectionLinkPickerModal({ sources, sections, appointments, currentSourceId, currentSectionId, currentApptId, onSelect, onClose, C, S }) {
  const [search, setSearch] = useState('');

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = [];
    const seenSectionIds = new Set();

    sources.forEach(src => {
      if (!q || src.title?.toLowerCase().includes(q)) {
        out.push({ kind: 'source', id: src.id, label: src.title, sub: null });
      }
      const srcSecs = sections.filter(sec =>
        sec.resourceId === src.id ||
        src.title?.toLowerCase() === sec.resourceRaw?.toLowerCase()
      );
      const queue    = srcSecs.filter(s => s.status !== 'Done' && s.status !== 'Skip');
      const previous = srcSecs.filter(s => s.status === 'Done' || s.status === 'Skip');
      [...queue, ...previous].forEach(sec => {
        seenSectionIds.add(sec.id);
        if (!q || sec.content?.toLowerCase().includes(q) || src.title?.toLowerCase().includes(q)) {
          out.push({ kind: 'section', id: sec.id, label: sec.content, sub: src.title, sourceId: src.id });
        }
      });
    });

    sections.filter(sec => !seenSectionIds.has(sec.id)).forEach(sec => {
      const srcTitle = sec.resourceRaw || '';
      if (!q || sec.content?.toLowerCase().includes(q) || srcTitle.toLowerCase().includes(q)) {
        out.push({ kind: 'section', id: sec.id, label: sec.content, sub: srcTitle, sourceId: null });
      }
    });

    // 한국어 appointments
    const langAppts = (appointments || []).filter(a => a.category === 'lang');
    if (langAppts.length > 0) {
      langAppts
        .filter(a => !q || (a.provider || a.type || '').toLowerCase().includes(q))
        .forEach(a => out.push({ kind: 'appointment', id: a.id, label: a.provider || a.type, sub: null }));
    }

    return out;
  }, [sources, sections, appointments, search]);

  const isActive = (item) =>
    item.kind === 'source'      ? (item.id === currentSourceId && !currentSectionId && !currentApptId) :
    item.kind === 'section'     ? (item.id === currentSectionId) :
    item.kind === 'appointment' ? (item.id === currentApptId) :
    false;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: '16px', border: `1px solid ${C.border}`,
        width: '440px', maxWidth: '92vw', maxHeight: '72vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '18px 20px 12px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontFamily: SH.fd, fontSize: '16px', color: C.text }}>Link source or section</span>
          <button onClick={onClose} style={{ color: C.textM, fontSize: '18px', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '12px 20px', flexShrink: 0 }}>
          <input autoFocus style={S.formInput} placeholder="Search sources and sections…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 16px' }}>
          {items.map((item) => {
            const active = isActive(item);
            return (
              <div key={`${item.kind}-${item.id}`}
                onClick={() => { onSelect(item); onClose(); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '8px 10px', borderRadius: '8px', cursor: 'pointer',
                  background: active ? C.accentSoft : 'transparent',
                  marginBottom: '2px', transition: 'background 0.15s',
                }}
                className="task-row"
              >
                {item.kind === 'appointment' ? (
                  <span style={{ flexShrink: 0, color: C.textM, display: 'flex', alignItems: 'center' }}>
                    {Icons.appt}
                  </span>
                ) : (
                  <span style={{
                    fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                    padding: '2px 6px', borderRadius: '4px', flexShrink: 0,
                    color: item.kind === 'source' ? C.accent : C.textM,
                    background: item.kind === 'source' ? C.accentSoft : `${C.border}55`,
                    border: `1px solid ${item.kind === 'source' ? C.accent + '44' : C.border}`,
                  }}>
                    {item.kind === 'source' ? 'Source' : 'Section'}
                  </span>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', color: C.text, fontWeight: item.kind === 'source' ? 500 : 400 }}>{item.label}</div>
                  {item.sub && <div style={{ fontSize: '10px', color: C.textM, marginTop: '1px' }}>{item.sub}</div>}
                </div>
                {active && <span style={{ fontSize: '10px', color: C.accent, flexShrink: 0 }}>✓</span>}
              </div>
            );
          })}
          {items.length === 0 && (
            <div style={{ fontSize: '13px', color: C.textM, fontStyle: 'italic', paddingTop: '8px' }}>No results.</div>
          )}
        </div>
        <div style={{ padding: '10px 20px', borderTop: `1px solid ${C.border}`, flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {(currentSourceId || currentSectionId) ? (
            <button onClick={() => { onSelect(null); onClose(); }}
              style={{ fontSize: '12px', color: C.textM, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              Clear link
            </button>
          ) : <span />}
          <button style={S.btnGhost} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── WYSIWYG toolbar ───────────────────────────────────────────
// Uses document.execCommand for instant in-place formatting.
// onLinkInsert opens a prompt; onToggleInsert inserts a <details> block without a name prompt.
function WysiwygToolbar({ editorRef, C, onLinkInsert, onToggleInsert, onHighlight }) {
  const cmd = (command, value) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value ?? null);
  };

  const divider = <span style={{ width: '1px', height: '14px', background: C.border, margin: '0 2px', flexShrink: 0 }} />;

  const btnBase = {
    padding: '3px 8px', borderRadius: '5px', fontSize: '12px',
    border: `1px solid ${C.border}`, background: 'transparent', color: C.textM,
    cursor: 'pointer', lineHeight: 1.4, transition: 'background 0.1s',
    fontFamily: 'inherit', flexShrink: 0,
  };

  return (
    <div style={{ display: 'flex', gap: '4px', marginBottom: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
      <button style={{ ...btnBase, fontWeight: 700 }}     onMouseDown={e => { e.preventDefault(); cmd('bold'); }}          title="Bold">B</button>
      <button style={{ ...btnBase, fontStyle: 'italic' }} onMouseDown={e => { e.preventDefault(); cmd('italic'); }}        title="Italic">i</button>
      <button style={{ ...btnBase, textDecoration: 'underline' }} onMouseDown={e => { e.preventDefault(); cmd('underline'); }} title="Underline">U</button>
      <button style={{ ...btnBase, textDecoration: 'line-through' }} onMouseDown={e => { e.preventDefault(); cmd('strikeThrough'); }} title="Strikethrough">S</button>
      {divider}
      <button style={btnBase} onMouseDown={e => { e.preventDefault(); cmd('insertUnorderedList'); }} title="Bullet list">&#8226; List</button>
      <button style={btnBase} onMouseDown={e => { e.preventDefault(); cmd('insertOrderedList'); }}   title="Numbered list">1. List</button>
      {divider}
      <button
        onMouseDown={e => { e.preventDefault(); onHighlight('#f5c518'); }}
        title="Highlight yellow"
        style={{ ...btnBase, padding: '3px 7px', borderColor: '#f5c518aa' }}
      >
        <span style={{ fontWeight: 700, color: '#b8960a', background: '#f5c51833', borderRadius: '2px', padding: '0 2px' }}>A</span>
      </button>
      <button
        onMouseDown={e => { e.preventDefault(); onHighlight('#3ecfcf'); }}
        title="Highlight teal"
        style={{ ...btnBase, padding: '3px 7px', borderColor: '#3ecfcfaa' }}
      >
        <span style={{ fontWeight: 700, color: '#1a9e9e', background: '#3ecfcf33', borderRadius: '2px', padding: '0 2px' }}>A</span>
      </button>
      <button
        onMouseDown={e => { e.preventDefault(); onHighlight('transparent'); }}
        title="Remove highlight"
        style={{ ...btnBase, padding: '3px 7px' }}
      >
        <span style={{ fontWeight: 700, color: C.textM, textDecoration: 'line-through', fontSize: '11px' }}>HL</span>
      </button>
      {divider}
      <button style={btnBase} onMouseDown={e => { e.preventDefault(); onLinkInsert(); }}   title="Insert link">Link</button>
      <button style={btnBase} onMouseDown={e => { e.preventDefault(); onToggleInsert(); }} title="Insert toggle block">Toggle</button>
    </div>
  );
}

// ── WYSIWYG editor (contentEditable div) ─────────────────────
function WysiwygEditor({ value, onChange, C, S }) {
  const editorRef   = useRef(null);
  const isComposing = useRef(false);

  // Seed initial HTML once on mount only.
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value || '';
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleInput = () => {
    if (!isComposing.current) {
      onChange(editorRef.current?.innerHTML || '');
    }
  };

  const handleLinkInsert = () => {
    const sel = window.getSelection();
    const selectedText = sel && !sel.isCollapsed ? sel.toString() : '';
    const url = window.prompt('Enter URL:', 'https://');
    if (!url || url === 'https://') return;
    editorRef.current?.focus();
    if (selectedText) {
      document.execCommand('createLink', false, url);
    } else {
      const display = window.prompt('Link text:', url) || url;
      document.execCommand('insertHTML', false,
        `<a href="${url}" target="_blank" rel="noopener noreferrer">${display}</a>`);
    }
    onChange(editorRef.current?.innerHTML || '');
  };

  const handleToggleInsert = () => {
    editorRef.current?.focus();
    const html = `<details style="margin:6px 0;border:1px solid currentColor;border-radius:6px;padding:4px 10px;opacity:0.7"><summary style="cursor:pointer;font-weight:600;padding:4px 0;list-style:none;outline:none">Details</summary><div style="padding:6px 0 2px">Content here…</div></details><p><br></p>`;
    document.execCommand('insertHTML', false, html);
    onChange(editorRef.current?.innerHTML || '');
  };

  const handleHighlight = (color) => {
    editorRef.current?.focus();
    document.execCommand('hiliteColor', false, color);
    onChange(editorRef.current?.innerHTML || '');
  };

  const editorStyle = {
    ...S.formInput,
    minHeight: '200px',
    lineHeight: 1.7,
    outline: 'none',
    cursor: 'text',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    // Links inside the editor
  };

  return (
    <>
      <style>{`
        .avi-editor a { color: inherit; opacity: 0.8; text-decoration: underline; cursor: pointer; }
        .avi-editor details summary::-webkit-details-marker { display: none; }
        .avi-editor details summary::before { content: '› '; transition: transform 0.15s; display: inline-block; }
        .avi-editor details[open] summary::before { transform: rotate(90deg); }
        .avi-editor ul { padding-left: 20px; }
        .avi-editor ol { padding-left: 20px; }
        .avi-editor li { margin: 2px 0; }
        .avi-editor code { font-family: monospace; font-size: 0.9em; padding: 1px 4px; border-radius: 3px; background: rgba(128,128,128,0.15); }
      `}</style>
      <WysiwygToolbar
        editorRef={editorRef} C={C}
        onLinkInsert={handleLinkInsert}
        onToggleInsert={handleToggleInsert}
        onHighlight={handleHighlight}
      />
      <div
        ref={editorRef}
        contentEditable={!DEMO}
        suppressContentEditableWarning
        className="avi-editor"
        style={editorStyle}
        onInput={handleInput}
        onCompositionStart={() => { isComposing.current = true; }}
        onCompositionEnd={() => { isComposing.current = false; handleInput(); }}
        onKeyDown={e => {
          // Tab inserts 4 spaces instead of moving focus
          if (e.key === 'Tab') {
            e.preventDefault();
            document.execCommand('insertText', false, '    ');
          }
        }}
        // Open links on click only when holding Ctrl/Cmd
        onClick={e => {
          const a = e.target.closest('a');
          if (a && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            window.open(a.href, '_blank', 'noopener,noreferrer');
          }
        }}
      />
    </>
  );
}

// ── Note editor panel ─────────────────────────────────────────
function NoteEditor({ note, initialTags, initialSourceId, initialSectionId, initialApptId, grammarEntries, sections, sources, appointments, onSave, onDelete, onClose, onNavigateToGrammar, onNavigateToContent, onLinkNoteToSection, isOverlay = false, wide, C, S }) {
  // Migrate legacy markdown `body` to `bodyHtml` on first load.
  const initialHtml = note?.bodyHtml ?? (note?.body ? mdToHtml(note.body) : '');

  const [title,         setTitle]         = useState(note?.title    || '');
  const [bodyHtml,      setBodyHtml]      = useState(initialHtml);
  const [tagInput,      setTagInput]      = useState('');
  const [tags,          setTags]          = useState(note?.tags     || initialTags || []);
  const [answered,      setAnswered]      = useState(note?.answered ?? false);
  const [linkedGrammar,   setLinkedGrammar]   = useState(note?.linkedGrammarIds || []);
  const [linkedSourceId,  setLinkedSourceId]  = useState(note?.linkedSourceId  || initialSourceId  || '');
  const [linkedSectionId, setLinkedSectionId] = useState(note?.linkedSectionId || initialSectionId || '');
  const [linkedApptId,    setLinkedApptId]    = useState(note?.linkedApptId    || initialApptId    || '');  
  const [showGrammarPicker, setShowGrammarPicker] = useState(false);
  const [showSectionPicker, setShowSectionPicker] = useState(false);
  const [showLinkPicker,    setShowLinkPicker]    = useState(false);
  const [showDelete,    setShowDelete]    = useState(false);
  const [saving,        setSaving]        = useState(false);
  const [saveIndicator, setSaveIndicator] = useState(null); // 'saving' | 'saved' | null
  const autoSaveTimer = useRef(null);

  const isNew = !note?.id;
  const isQuestion = tags.includes('question');

  // Auto-save: fires 2s after last change, only for existing notes.
  const scheduleAutoSave = useCallback((overrides = {}) => {
    if (isNew) return;
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
      setSaveIndicator('saving');
      await onSave({
        ...(note || {}),
        title:            overrides.title      ?? title,
        bodyHtml:         overrides.bodyHtml   ?? bodyHtml,
        tags:             overrides.tags       ?? tags,
        answered:         overrides.answered   ?? answered,
        linkedGrammarIds: overrides.linkedGrammarIds ?? linkedGrammar,
        linkedSourceId:   'linkedSourceId'  in overrides ? (overrides.linkedSourceId  ?? null) : (linkedSourceId  || null),
        linkedSectionId:  'linkedSectionId' in overrides ? (overrides.linkedSectionId ?? null) : (linkedSectionId || null),
        linkedApptId:     'linkedApptId'    in overrides ? (overrides.linkedApptId    ?? null) : (linkedApptId    || null),
      });
      setSaveIndicator('saved');
      setTimeout(() => setSaveIndicator(null), 2000);
    }, 2000);
  }, [isNew, note, title, bodyHtml, tags, answered, linkedGrammar, onSave]);

  // Clean up timer on unmount
  useEffect(() => () => clearTimeout(autoSaveTimer.current), []);

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) {
      const next = [...tags, t];
      setTags(next);
      scheduleAutoSave({ tags: next });
    }
    setTagInput('');
  };
  const removeTag = (t) => {
    const next = tags.filter(x => x !== t);
    setTags(next);
    scheduleAutoSave({ tags: next });
  };
  const toggleGrammarLink = (id) => {
    const next = linkedGrammar.includes(id)
      ? linkedGrammar.filter(x => x !== id)
      : [...linkedGrammar, id];
    setLinkedGrammar(next);
    scheduleAutoSave({ linkedGrammarIds: next });
  };

  const handleSave = async () => {
    if (DEMO) return; // demo: Notes are read-only (7C addendum)
    if (!title.trim() && !stripHtml(bodyHtml)) return;
    setSaving(true);
        await onSave({ ...(note || {}), title: title.trim(), bodyHtml, tags, answered, linkedGrammarIds: linkedGrammar, linkedSourceId: linkedSourceId || null, linkedSectionId: linkedSectionId || null, linkedApptId: linkedApptId || null });
    setSaving(false);
  };

  const linkedLabels = linkedGrammar
    .map(id => ({ id, term: grammarEntries.find(e => e.id === id)?.glossaryTerm }))
    .filter(x => x.term);

  const customTags = tags.filter(t => !PRESET_TAGS.includes(t));

  return (
    <div
      className={isOverlay ? 'cl-mobile-overlay' : undefined}
      style={{
        ...(isOverlay
          ? { position: 'fixed', top: '74px', bottom: '56px', left: 0, right: 0, zIndex: 60, width: '100%' }
          : wide
            ? { flex: 1, minWidth: '700px' }
            : { width: '700px', minWidth: '700px', maxWidth: '700px', flexBasis: '700px', flexShrink: 0, flexGrow: 0 }
        ),
        borderLeft: isOverlay ? 'none' : `1px solid ${C.border}`, background: C.surface,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
      <div style={{ padding: '18px 20px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <span style={{ fontFamily: SH.fd, fontSize: '16px', color: C.text }}>
          {isNew ? 'New note' : 'Edit note'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {saveIndicator && (
            <span style={{
              fontSize: '11px', color: saveIndicator === 'saved' ? (C.success || '#5ba05b') : C.textM,
              fontFamily: SH.fm, transition: 'opacity 0.3s',
              opacity: saveIndicator === 'saved' ? 0.8 : 0.5,
            }}>
              {saveIndicator === 'saving' ? 'Saving…' : 'Saved'}
            </span>
          )}
          <button onClick={onClose} style={{ color: C.textM, fontSize: '18px', lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        <div style={S.formGroup}>
          <label style={S.formLabel}>Title</label>
          <input style={S.formInput} placeholder="Note title…" value={title} onChange={e => { setTitle(e.target.value); scheduleAutoSave({ title: e.target.value }); }} />
        </div>

        <div style={S.formGroup}>
          <label style={S.formLabel}>Source / Section</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              onClick={() => {
                if (!onNavigateToContent || linkedApptId) return;
                if (linkedSectionId) {
                  const sec = (sections || []).find(s => s.id === linkedSectionId);
                  onNavigateToContent(sec?.resourceId || linkedSourceId || null, linkedSectionId);
                } else if (linkedSourceId) {
                  onNavigateToContent(linkedSourceId, null);
                }
              }}
              title={(!linkedApptId && (linkedSectionId || linkedSourceId) && onNavigateToContent) ? 'Open in library' : undefined}
              style={{
                flex: 1, fontSize: '13px',
                color: (linkedSourceId || linkedSectionId || linkedApptId) ? C.text : C.textM,
                fontStyle: (linkedSourceId || linkedSectionId || linkedApptId) ? 'normal' : 'italic',
                cursor: (!linkedApptId && (linkedSectionId || linkedSourceId) && onNavigateToContent) ? 'pointer' : 'default',
              }}>
              {linkedApptId
                ? (() => {
                    const appt = (appointments || []).find(a => a.id === linkedApptId);
                    return <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>{Icons.appt} {appt?.provider || appt?.type || 'Appointment'}</span>;
                  })()
                : linkedSectionId
                  ? (() => {
                      const sec = (sections || []).find(s => s.id === linkedSectionId);
                      const src = sec ? (sources || []).find(s => s.id === sec.resourceId || s.title?.toLowerCase() === sec.resourceRaw?.toLowerCase()) : null;
                      return <>{sec?.content || 'Section'}{src && <span style={{ color: C.textM, marginLeft: '6px', fontSize: '11px' }}>· {src.title}</span>}</>;
                    })()
                  : linkedSourceId
                    ? ((sources || []).find(s => s.id === linkedSourceId)?.title || 'Source')
                    : 'No source linked'}
            </div>
            {(linkedSourceId || linkedSectionId || linkedApptId) && (
              <button
                onClick={() => {
                  setLinkedSourceId(''); setLinkedSectionId(''); setLinkedApptId('');
                  scheduleAutoSave({ linkedSourceId: null, linkedSectionId: null, linkedApptId: null });
                }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textM, fontSize: '16px', padding: 0, lineHeight: 1, flexShrink: 0 }}
              >×</button>
            )}
            <button
              onClick={() => setShowLinkPicker(true)}
              style={{ fontSize: '11px', padding: '3px 10px', borderRadius: '6px', background: 'transparent', color: C.textM, border: `1px solid ${C.border}`, cursor: 'pointer', flexShrink: 0 }}
            >
              {(linkedSourceId || linkedSectionId || linkedApptId) ? 'Change' : 'Link…'}
            </button>
          </div>
        </div>
        {showLinkPicker && (
          <CorrectionLinkPickerModal
            sources={sources || []}
            sections={sections || []}
            appointments={appointments}
            currentSourceId={linkedSourceId}
            currentSectionId={linkedSectionId}
            currentApptId={linkedApptId}
            onSelect={item => {
              if (!item) {
                setLinkedSourceId(''); setLinkedSectionId(''); setLinkedApptId('');
                scheduleAutoSave({ linkedSourceId: null, linkedSectionId: null, linkedApptId: null });
              } else if (item.kind === 'appointment') {
                setLinkedApptId(item.id); setLinkedSourceId(''); setLinkedSectionId('');
                scheduleAutoSave({ linkedApptId: item.id, linkedSourceId: null, linkedSectionId: null });
              } else if (item.kind === 'source') {
                setLinkedSourceId(item.id); setLinkedSectionId(''); setLinkedApptId('');
                scheduleAutoSave({ linkedSourceId: item.id, linkedSectionId: null, linkedApptId: null });
              } else {
                setLinkedSectionId(item.id); setLinkedSourceId(item.sourceId || ''); setLinkedApptId('');
                scheduleAutoSave({ linkedSectionId: item.id, linkedSourceId: item.sourceId || null, linkedApptId: null });
              }
            }}
            onClose={() => setShowLinkPicker(false)}
            C={C}
            S={S}
          />
        )}

        <div style={S.formGroup}>
          <label style={S.formLabel}>Body</label>
          <WysiwygEditor value={bodyHtml} onChange={v => { setBodyHtml(v); scheduleAutoSave({ bodyHtml: v }); }} C={C} S={S} />
        </div>

        {/* Tags */}
        <div style={S.formGroup}>
          <label style={S.formLabel}>Tags</label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {PRESET_TAGS.map(t => {
              const active = tags.includes(t);
              return (
                <button key={t} onClick={() => active ? removeTag(t) : setTags(prev => [...prev, t])}
                  style={{
                    padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500,
                    border: `1px solid ${active ? (C.accent2 || C.accent) : C.border}`,
                    background: active ? (C.accent2Soft || C.accentSoft) : 'transparent',
                    color: active ? (C.accent2 || C.accent) : C.textS,
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}>{t}</button>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input style={{ ...S.formInput, flex: 1 }} placeholder="Custom tag…" value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} />
            <button style={S.btnGhost} onClick={addTag}>Add</button>
          </div>
          {customTags.length > 0 && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
              {customTags.map(t => (
                <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 10px', borderRadius: '20px', fontSize: '12px', border: `1px solid ${C.accent2 || C.accent}`, color: C.accent2 || C.accent, background: C.accent2Soft || C.accentSoft }}>
                  {t}
                  <button onClick={() => removeTag(t)} style={{ color: C.accent, fontSize: '12px', lineHeight: 1, padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Answered (questions only) */}
        {isQuestion && (
          <div style={{ ...S.formGroup, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input
              type="checkbox"
              id="note-answered"
              checked={answered}
              onChange={e => { setAnswered(e.target.checked); scheduleAutoSave({ answered: e.target.checked }); }}
              style={{ width: '15px', height: '15px', accentColor: C.accent, cursor: 'pointer', flexShrink: 0 }}
            />
            <label htmlFor="note-answered" style={{ ...S.formLabel, margin: 0, cursor: 'pointer' }}>
              Answered
            </label>
          </div>
        )}

        {/* Linked grammar */}
<div style={S.formGroup}>
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
    <label style={{ ...S.formLabel, margin: 0 }}>Linked Grammar</label>
    <button onClick={() => setShowGrammarPicker(true)}
      style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px', background: 'transparent', color: C.textM, border: `1px solid ${C.border}`, cursor: 'pointer' }}>
      + Add
    </button>
  </div>
  {linkedLabels.length > 0 && (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {linkedLabels.map(({ id, term }) => (
        <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 10px', borderRadius: '20px', fontSize: '12px', border: `1px solid ${C.accent}44`, color: C.accent, background: C.accentSoft, fontFamily: SH.fk }}>
          <span onClick={() => onNavigateToGrammar && onNavigateToGrammar(id)}
            style={{ cursor: onNavigateToGrammar ? 'pointer' : 'default', textDecoration: onNavigateToGrammar ? 'underline' : 'none', textDecorationColor: `${C.accent}66` }}>
            {term}
          </span>
          <button onClick={() => toggleGrammarLink(id)} style={{ color: C.accent, fontSize: '12px', lineHeight: 1, padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
        </span>
      ))}
    </div>
  )}
  {linkedLabels.length === 0 && <div style={{ fontSize: '13px', color: C.textM, fontStyle: 'italic' }}>No linked entries.</div>}
</div>

        {/* Linked sections */}
{!isNew && (() => {
  const linkedSections = (sections || []).filter(s => (s.linkedNoteIds || []).includes(note.id));
  return (
    <div style={S.formGroup}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <label style={{ ...S.formLabel, margin: 0 }}>Linked Sections</label>
        <button onClick={() => setShowSectionPicker(true)}
          style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px', background: 'transparent', color: C.textM, border: `1px solid ${C.border}`, cursor: 'pointer' }}>
          + Add
        </button>
      </div>
      {linkedSections.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {linkedSections.map(sec => {
            const src = (sources || []).find(s => s.id === sec.resourceId || s.title?.toLowerCase() === sec.resourceRaw?.toLowerCase());
            return (
              <div key={sec.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '6px 10px', borderRadius: '8px', border: `1px solid ${C.border}`, background: C.bg }}>
                <div onClick={() => onNavigateToContent && onNavigateToContent(src?.id || null, sec.id)}
                  style={{ flex: 1, cursor: onNavigateToContent ? 'pointer' : 'default' }} className="task-row">
                  <div style={{ fontSize: '12px', fontWeight: 500, color: C.text, marginBottom: '1px' }}>{sec.content}</div>
                  {src && <div style={{ fontSize: '10px', color: C.textM }}>{src.title}</div>}
                </div>
                <button onClick={() => onLinkNoteToSection && onLinkNoteToSection(sec.id, note.id, false)}
                  style={{ color: C.textM, fontSize: '13px', lineHeight: 1, padding: 0, background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, marginTop: '2px' }}>×</button>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ fontSize: '13px', color: C.textM, fontStyle: 'italic' }}>No linked sections.</div>
      )}
    </div>
  );
})()}
      </div>

      <div style={{ padding: '14px 20px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: '8px', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>
          {!isNew && <button style={S.btnDanger} onClick={() => setShowDelete(true)}>Delete</button>}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button style={S.btnGhost} onClick={onClose}>Cancel</button>
          <button style={{ ...S.btnPrimary, ...S.btnMetallic, opacity: saving ? 0.6 : 1 }} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
          </button>
        </div>
      </div>

      {showDelete && (
        <DeleteConfirm C={C} S={S}
          onCancel={() => setShowDelete(false)}
          onConfirm={() => { setShowDelete(false); onDelete(note.id); }} />
      )}
      {showGrammarPicker && (
        <MultiPickerModal
          label="Link grammar entries"
          items={grammarEntries.map(e => ({ id: e.id, _searchText: e.glossaryTerm }))}
          selectedIds={linkedGrammar}
          onToggle={id => toggleGrammarLink(id)}
          onClose={() => setShowGrammarPicker(false)}
          renderItem={(it) => {
            const e = grammarEntries.find(x => x.id === it.id);
            return (
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: '13px', color: C.text, fontFamily: SH.fk }}>{e?.glossaryTerm}</span>
                {e?.entryNumber && <span style={{ fontSize: '11px', color: C.textM, marginLeft: '8px' }}>#{e.entryNumber}</span>}
              </div>
            );
          }}
          C={C} S={S}
        />
      )}
      {showSectionPicker && !isNew && (
        <MultiPickerModal
          label="Link content sections"
          items={(() => {
            const sorted = [...(sections || [])].sort((a, b) => {
              const srcA = (sources || []).find(s => s.id === a.resourceId || s.title?.toLowerCase() === a.resourceRaw?.toLowerCase());
              const srcB = (sources || []).find(s => s.id === b.resourceId || s.title?.toLowerCase() === b.resourceRaw?.toLowerCase());
              const idxA = srcA ? (sources || []).indexOf(srcA) : 9999;
              const idxB = srcB ? (sources || []).indexOf(srcB) : 9999;
              if (idxA !== idxB) return idxA - idxB;
              const prevA = a.status === 'Done' || a.status === 'Skip' ? 1 : 0;
              const prevB = b.status === 'Done' || b.status === 'Skip' ? 1 : 0;
              return prevA - prevB;
            });
            return sorted.map(sec => {
              const src = (sources || []).find(s => s.id === sec.resourceId || s.title?.toLowerCase() === sec.resourceRaw?.toLowerCase());
              return { id: sec.id, _searchText: `${sec.content} ${src?.title || sec.resourceRaw || ''}`, _src: src, _sec: sec };
            });
          })()}
          selectedIds={(sections || []).filter(s => (s.linkedNoteIds || []).includes(note?.id)).map(s => s.id)}
          onToggle={id => {
            const sec = sections.find(s => s.id === id);
            const alreadyLinked = (sec?.linkedNoteIds || []).includes(note.id);
            onLinkNoteToSection && onLinkNoteToSection(id, note.id, !alreadyLinked);
          }}
          onClose={() => setShowSectionPicker(false)}
          renderItem={(it) => (
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '13px', color: C.text }}>{it._sec?.content}</div>
              {it._src && <div style={{ fontSize: '10px', color: C.textM, marginTop: '1px' }}>{it._src.title}</div>}
            </div>
          )}
          C={C} S={S}
        />
      )}
    </div>
  );
}

// ── Note list card ────────────────────────────────────────────
function NoteCard({ note, active, onClick, C, grammarEntries = [], onNavigateToGrammar, sourceTitle }) {
  // Preview: strip HTML, split on sentence boundaries, show up to 2 lines
  const previewText = useMemo(() => {
    const src = note.bodyHtml || (note.body ? mdToHtml(note.body) : '');
    return stripHtml(src).slice(0, 160);
  }, [note.bodyHtml, note.body]);

  return (
    <div onClick={onClick}
      style={{ padding: '13px 16px', borderBottom: `1px solid ${C.border}`, background: active ? C.accentSoft : 'transparent', cursor: 'pointer', transition: 'background 0.15s' }}
      className="task-row">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '4px' }}>
        <div style={{ fontSize: '13.5px', fontWeight: 500, color: C.text, wordBreak: 'break-word', flex: 1 }}>
          {note.title || <span style={{ color: C.textM, fontStyle: 'italic' }}>Untitled</span>}
        </div>
        {(note.tags || []).includes('question') && (
          <span style={{
            flexShrink: 0, fontSize: '10px', fontWeight: 600, padding: '2px 7px',
            borderRadius: '10px', letterSpacing: '0.04em',
            border: `1px solid ${note.answered ? (C.success || '#5ba05b') + '88' : C.border}`,
            color: note.answered ? (C.success || '#5ba05b') : C.textM,
            background: note.answered ? (C.success || '#5ba05b') + '18' : 'transparent',
          }}>
            {note.answered ? 'Answered' : 'Open'}
          </span>
        )}
      </div>
      {previewText && (
        <div style={{ fontSize: '12px', color: C.textM, marginBottom: '6px', lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {previewText}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', color: C.textM, fontFamily: SH.fm }}>
          {formatDate(note.updatedAt || note.createdAt)}
        </span>
        {sourceTitle && (
          <span style={{ fontSize: '10px', padding: '1px 7px', borderRadius: '10px', border: `1px solid ${C.border}`, color: C.textM, maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sourceTitle}
          </span>
        )}
        {(note.tags || []).slice(0, 3).map(t => (
          <span key={t} style={{ fontSize: '10px', padding: '1px 7px', borderRadius: '10px', border: `1px solid ${C.border}`, color: C.textM }}>{t}</span>
        ))}
      </div>
      {(note.linkedGrammarIds || []).length > 0 && (
        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginTop: '5px' }}>
          {note.linkedGrammarIds.map(id => {
            const entry = grammarEntries.find(e => e.id === id);
            if (!entry) return null;
            return (
              <span key={id}
                onClick={e => { e.stopPropagation(); onNavigateToGrammar && onNavigateToGrammar(id); }}
                style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', border: `1px solid ${C.accent}44`, color: C.accent, background: C.accentSoft, fontFamily: SH.fk, cursor: onNavigateToGrammar ? 'pointer' : 'default' }}>
                {entry.glossaryTerm}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Corrections editor ────────────────────────────────────────
function CorrectionsEditor({ session, sources, sections, appointments, defaultSourceId, defaultSectionId, defaultApptId, onSave, onDelete, onClose, onNavigateToContent, isOverlay = false, wide, C, S }) {
  const isNew = !session?.id;
  const uid   = auth.currentUser?.uid;

  const initRows = (raw) =>
    (raw || [{ topic: '', original: '', corrected: '' }])
      .map(r => ({ id: crypto.randomUUID(), ...r }));

  const [title,          setTitle]          = useState(session?.title || '');
  const [sourceId,       setSourceId]       = useState(session?.sourceId    || defaultSourceId  || '');
  const [sectionId,      setSectionId]      = useState(session?.sectionId   || defaultSectionId || '');
  const [linkedApptId,   setLinkedApptId]   = useState(session?.linkedApptId || defaultApptId   || '');
  const [rows,           setRows]           = useState(() => initRows(session?.rows));
  const [locked,         setLocked]         = useState(session?.locked ?? false);
  const [showDelete,     setShowDelete]     = useState(false);
  const [saving,         setSaving]         = useState(false);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [hasActiveFocus, setHasActiveFocus] = useState(false);

  // Shared toolbar refs
  const activeEditorRef = useRef(null); // DOM element of last-focused field
  const activeFieldMeta = useRef(null); // { rowIndex, field: 'original'|'corrected' }
  const blurTimeoutRef  = useRef(null);

  useEffect(() => {
    setTitle(session?.title || '');
    setSourceId(session?.sourceId    || defaultSourceId  || '');
    setSectionId(session?.sectionId  || defaultSectionId || '');
    setLinkedApptId(session?.linkedApptId || defaultApptId || '');
    setRows(initRows(session?.rows));
    setLocked(session?.locked ?? false);
  }, [session?.id, defaultSourceId, defaultSectionId, defaultApptId]);

  const addRow    = () => setRows(prev => [...prev, { id: crypto.randomUUID(), topic: '', original: '', corrected: '' }]);
  const removeRow = (i) => setRows(prev => prev.filter((_, idx) => idx !== i));
  const updateRow = (i, field, val) => setRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));

  // Focus tracking for shared toolbar
  const handleFieldFocus = (el, rowIndex, field) => {
    clearTimeout(blurTimeoutRef.current);
    activeEditorRef.current = el;
    activeFieldMeta.current = { rowIndex, field };
    setHasActiveFocus(true);
  };
  const handleFieldBlur = () => {
    blurTimeoutRef.current = setTimeout(() => setHasActiveFocus(false), 200);
  };

  // Shared toolbar handlers
  const handleHighlight = (color) => {
    activeEditorRef.current?.focus();
    document.execCommand('hiliteColor', false, color);
    const el = activeEditorRef.current;
    if (el && activeFieldMeta.current) {
      const { rowIndex, field } = activeFieldMeta.current;
      updateRow(rowIndex, field, el.innerHTML);
    }
  };
  const handleLinkInsert = () => {
    const el = activeEditorRef.current;
    if (!el || !activeFieldMeta.current) return;
    const sel = window.getSelection();
    const selectedText = sel && !sel.isCollapsed ? sel.toString() : '';
    const url = window.prompt('Enter URL:', 'https://');
    if (!url || url === 'https://') return;
    el.focus();
    if (selectedText) {
      document.execCommand('createLink', false, url);
    } else {
      const display = window.prompt('Link text:', url) || url;
      document.execCommand('insertHTML', false, `<a href="${url}" target="_blank" rel="noopener noreferrer">${display}</a>`);
    }
    const { rowIndex, field } = activeFieldMeta.current;
    updateRow(rowIndex, field, el.innerHTML);
  };
  const handleToggleInsert = () => {
    const el = activeEditorRef.current;
    if (!el || !activeFieldMeta.current) return;
    el.focus();
    document.execCommand('insertHTML', false,
      `<details style="margin:6px 0;border:1px solid currentColor;border-radius:6px;padding:4px 10px;opacity:0.7"><summary style="cursor:pointer;font-weight:600;padding:4px 0;list-style:none;outline:none">Details</summary><div style="padding:6px 0 2px">Content here…</div></details><p><br></p>`
    );
    const { rowIndex, field } = activeFieldMeta.current;
    updateRow(rowIndex, field, el.innerHTML);
  };

  // Lock toggle — writes immediately to Firestore for existing sessions
  const handleToggleLock = async () => {
    if (DEMO) return; // demo: Notes are read-only (7C addendum)
    const next = !locked;
    setLocked(next);
    if (!isNew && session?.id && uid) {
      updateDoc(doc(db, 'users', uid, 'notes', session.id), { locked: next }).catch(e => console.error('Lock toggle failed:', e));
    }
  };

  const handleCorrectionsSave = async () => {
    if (DEMO) return; // demo: Notes are read-only (7C addendum)
    if (!title.trim()) return;
    setSaving(true);
    const cleanRows = rows.map(({ id: _id, ...r }) => r); // strip UI-only stable IDs
    await onSave({
      ...(session || {}),
      type: 'correction',
      title: title.trim(),
      sourceId:     sourceId     || null,
      sectionId:    sectionId    || null,
      linkedApptId: linkedApptId || null,
      locked,
      rows: cleanRows,
    });
    setSaving(false);
  };

  const handleLinkSelect = async (item) => {
    if (DEMO) return; // demo: Notes are read-only (7C addendum)
    if (!item) {
      setSourceId(''); setSectionId(''); setLinkedApptId('');
      if (!isNew && session?.id && uid) {
        updateDoc(doc(db, 'users', uid, 'notes', session.id), { sourceId: null, sectionId: null, linkedApptId: null }).catch(() => {});
      }
      return;
    }
    if (item.kind === 'appointment') {
      setLinkedApptId(item.id); setSourceId(''); setSectionId('');
      if (!isNew && session?.id && uid) {
        updateDoc(doc(db, 'users', uid, 'notes', session.id), { linkedApptId: item.id, sourceId: null, sectionId: null }).catch(() => {});
      }
      return;
    }
    const newSourceId  = item.kind === 'source'  ? item.id : (item.sourceId || '');
    const newSectionId = item.kind === 'section' ? item.id : '';
    setSourceId(newSourceId); setSectionId(newSectionId); setLinkedApptId('');
    if (!isNew && session?.id && uid) {
      updateDoc(doc(db, 'users', uid, 'notes', session.id), { sourceId: newSourceId || null, sectionId: newSectionId || null, linkedApptId: null }).catch(() => {});
    }
  };

  const linkedSource  = sources.find(s => s.id === sourceId);
  const linkedSection = (sections || []).find(s => s.id === sectionId);
  const linkedAppt    = (appointments || []).find(a => a.id === linkedApptId);

  // Seed a contenteditable div once on mount; wrap plain text in <p>
  const wrapIfPlain = (s) => (!s ? '' : s.startsWith('<') ? s : `<p>${s}</p>`);
  const seedField   = (el, html) => {
    if (el && !el.dataset.seeded) {
      el.innerHTML = wrapIfPlain(html);
      el.dataset.seeded = 'true';
    }
  };

  const fieldStyle = {
    ...S.formInput, outline: 'none', minHeight: '80px', lineHeight: 1.6,
    fontSize: '13px', fontFamily: SH.fk, flex: 1,
  };

  return (
    <div
      className={isOverlay ? 'cl-mobile-overlay' : undefined}
      style={{
        ...(isOverlay
          ? { position: 'fixed', top: '74px', bottom: '56px', left: 0, right: 0, zIndex: 60, width: '100%' }
          : wide
            ? { flex: 1, minWidth: '700px' }
            : { width: '700px', minWidth: '700px', maxWidth: '700px', flexBasis: '700px', flexShrink: 0, flexGrow: 0 }),
        borderLeft: isOverlay ? 'none' : `1px solid ${C.border}`, background: C.surface,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
      <style>{`
        .avi-editor a { color: inherit; opacity: 0.8; text-decoration: underline; cursor: pointer; }
        .avi-editor details summary::-webkit-details-marker { display: none; }
        .avi-editor details summary::before { content: '› '; transition: transform 0.15s; display: inline-block; }
        .avi-editor details[open] summary::before { transform: rotate(90deg); }
        .avi-editor ul { padding-left: 20px; } .avi-editor ol { padding-left: 20px; }
        .avi-editor li { margin: 2px 0; }
      `}</style>

      {/* Header */}
      <div style={{ padding: '18px 20px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
        <input
          style={{ ...S.formInput, fontFamily: SH.fd, fontSize: '16px', border: 'none', background: 'transparent', padding: '0', flex: 1, color: C.text, outline: 'none', boxShadow: 'none' }}
          placeholder={isNew ? 'New corrections session…' : 'Session title…'}
          value={title} onChange={e => setTitle(e.target.value)} readOnly={locked}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          {!isNew && (
            <button onClick={handleToggleLock} title={locked ? 'Unlock session' : 'Lock session'}
              style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', color: locked ? C.accent : C.textM, fontSize: '14px', lineHeight: 1 }}>
              {locked ? Icons.lock : Icons.lockOpen}
            </button>
          )}
          <button onClick={onClose} style={{ color: C.textM, fontSize: '18px', lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>

        {/* Source / section link */}
        <div style={{ ...S.formGroup, marginBottom: '16px' }}>
          <label style={S.formLabel}>Linked source or section</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {(linkedAppt || linkedSection || linkedSource) ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                {linkedAppt && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '20px', fontSize: '12px', border: `1px solid ${C.accent}44`, color: C.accent, background: C.accentSoft }}>
                    {Icons.appt} {linkedAppt.provider || linkedAppt.type}
                  </span>
                )}
                {!linkedAppt && linkedSection && (
                  <span
                    onClick={() => onNavigateToContent && onNavigateToContent(linkedSection.resourceId || sourceId || null, sectionId)}
                    title={onNavigateToContent ? 'Open in library' : undefined}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '20px', fontSize: '12px', border: `1px solid ${C.border}`, color: C.textM, background: `${C.border}33`, cursor: onNavigateToContent ? 'pointer' : 'default' }}>
                    <span style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.textM }}>Section</span>
                    {linkedSection.content}
                    {linkedSource && <span style={{ color: C.textM, opacity: 0.6 }}>· {linkedSource.title}</span>}
                  </span>
                )}
                {!linkedAppt && !linkedSection && linkedSource && (
                  <span
                    onClick={() => onNavigateToContent && onNavigateToContent(sourceId || null, null)}
                    title={onNavigateToContent ? 'Open in library' : undefined}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '20px', fontSize: '12px', border: `1px solid ${C.accent}44`, color: C.accent, background: C.accentSoft, cursor: onNavigateToContent ? 'pointer' : 'default' }}>
                    <span style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Source</span>
                    {linkedSource.title}
                  </span>
                )}
                {!locked && (
                  <>
                    <button onClick={() => setShowLinkPicker(true)} style={{ fontSize: '11px', padding: '3px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}>Change</button>
                    <button onClick={() => handleLinkSelect(null)} style={{ fontSize: '11px', color: C.textM, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Clear</button>
                  </>
                )}
              </div>
            ) : (
              !locked && (
                <button onClick={() => setShowLinkPicker(true)} style={{ fontSize: '12px', padding: '5px 14px', borderRadius: '8px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}>
                  + Link source or section
                </button>
              )
            )}
          </div>
        </div>

        {/* Shared sticky toolbar — hidden when locked or unfocused */}
        {!locked && (
          <div style={{ position: 'sticky', top: 0, zIndex: 1, background: C.surface, paddingBottom: '8px', marginBottom: '8px', borderBottom: `1px solid ${C.border}`, opacity: hasActiveFocus ? 1 : 0.45, transition: 'opacity 0.2s' }}>
            <WysiwygToolbar
              editorRef={activeEditorRef}
              C={C}
              onLinkInsert={handleLinkInsert}
              onToggleInsert={handleToggleInsert}
              onHighlight={handleHighlight}
            />
          </div>
        )}

        {/* Correction rows */}
        {rows.map((row, i) => (
          <div key={row.id} style={{ border: `1px solid ${C.border}`, borderRadius: '10px', padding: '12px', marginBottom: '10px', background: C.raised }}>
            {/* Top zone: Topic/Vocab + delete */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <input value={row.topic} onChange={e => updateRow(i, 'topic', e.target.value)}
                placeholder="Topic / Vocab…" readOnly={locked}
                style={{ ...S.formInput, flex: 1, fontSize: '12px', fontWeight: 600, margin: 0, background: locked ? C.bg : undefined }} />
              {!locked && rows.length > 1 && (
                <button onClick={() => removeRow(i)} style={{ color: C.textM, fontSize: '18px', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, padding: '0 2px', lineHeight: 1 }}>×</button>
              )}
            </div>
            {/* Bottom zone: Original | Corrected */}
            <div style={{ display: 'flex', gap: '10px' }}>
              {[['original', 'Original'], ['corrected', 'Corrected']].map(([fieldName, label]) => (
                <div key={fieldName} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM }}>{label}</span>
                  <div
                    ref={el => seedField(el, row[fieldName])}
                    contentEditable={!DEMO && !locked}
                    suppressContentEditableWarning
                    className="avi-editor"
                    style={{ ...fieldStyle, background: locked ? C.bg : undefined, cursor: locked ? 'default' : 'text' }}
                    onFocus={e => handleFieldFocus(e.currentTarget, i, fieldName)}
                    onBlur={handleFieldBlur}
                    onInput={e => updateRow(i, fieldName, e.currentTarget.innerHTML)}
                    onCompositionEnd={e => updateRow(i, fieldName, e.currentTarget.innerHTML)}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}

        {!locked && (
          <button onClick={addRow} style={{ ...S.btnGhost, marginTop: '4px', fontSize: '12px' }}>+ Add row</button>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '14px 20px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: '8px', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>{!isNew && !locked && <button style={S.btnDanger} onClick={() => setShowDelete(true)}>Delete</button>}</div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button style={S.btnGhost} onClick={onClose}>Cancel</button>
          {!locked && (
            <button style={{ ...S.btnPrimary, ...S.btnMetallic, opacity: (!title.trim() || saving) ? 0.6 : 1 }}
              onClick={handleCorrectionsSave} disabled={!title.trim() || saving}>
              {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {showDelete && (
        <DeleteConfirm C={C} S={S}
          onCancel={() => setShowDelete(false)}
          onConfirm={() => { setShowDelete(false); onDelete(session.id); }} />
      )}
      {showLinkPicker && (
        <CorrectionLinkPickerModal
          sources={sources} sections={sections || []}
          appointments={appointments}
          currentSourceId={sourceId} currentSectionId={sectionId}
          currentApptId={linkedApptId}
          onSelect={handleLinkSelect} onClose={() => setShowLinkPicker(false)}
          C={C} S={S}
        />
      )}
    </div>
  );
}

// ── Corrections list card — editable title ────────────────────
function CorrectionCard({ session, active, onClick, onRename, C }) {
  const [editing,  setEditing]  = useState(false);
  const [draft,    setDraft]    = useState(session.title || '');
  const inputRef = useRef(null);

  const rowCount = (session.rows || []).filter(r => r.original || r.corrected).length;

  const startEdit = (e) => {
    e.stopPropagation();
    setDraft(session.title || '');
    setEditing(true);
  };

  const commitEdit = (e) => {
    e?.stopPropagation();
    const val = draft.trim();
    if (val && val !== session.title) onRename(session.id, val);
    setEditing(false);
  };

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  return (
    <div
      onClick={() => !editing && onClick()}
      style={{ padding: '13px 16px', borderBottom: `1px solid ${C.border}`, background: active ? C.accentSoft : 'transparent', cursor: editing ? 'default' : 'pointer', transition: 'background 0.15s' }}
      className="task-row"
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => { if (e.key === 'Enter') commitEdit(e); if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }}
          onClick={e => e.stopPropagation()}
          style={{
            ...{ fontSize: '13.5px', fontWeight: 500, color: C.text, width: '100%', padding: '2px 6px', borderRadius: '6px', border: `1px solid ${C.accent}`, background: C.bg, outline: 'none', marginBottom: '4px' },
          }}
        />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
          <span style={{ fontSize: '13.5px', fontWeight: 500, color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {session.title}
          </span>
          <span
            onClick={startEdit}
            title="Rename"
            style={{ fontSize: '10px', color: C.textM, cursor: 'pointer', opacity: 0, flexShrink: 0, lineHeight: 1, transition: 'opacity 0.15s' }}
            className="edit-pencil"
          >✎</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: '10px', fontSize: '11px', color: C.textM }}>
        <span>{formatDate(session.updatedAt || session.createdAt)}</span>
        <span>{rowCount} entr{rowCount !== 1 ? 'ies' : 'y'}</span>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────
export function NotesPage({
  defaultOpenNoteId, defaultCorrectionSourceId, defaultOpenCorrectionId,
  onNavigateToGrammar, onNavigateToContent,
  // Embedded mode props (passed from ContentLibraryPage)
  embedded,
  preLinkedData, onPreLinkConsumed,
  initNotes, initCorrections, initGrammarEntries, initSources, initSections,
  onNoteCreated, onNoteUpdated, onNoteDeleted,
  appointments,
}) {
  const { C, S } = useAppTheme();

  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem(TAB_KEY) || 'notes'; } catch { return 'notes'; }
  });
  const switchTab = (t) => {
    setTab(t);
    try { localStorage.setItem(TAB_KEY, t); } catch {}
    setSelected(null);
    setShowNew(false);
    setAnsweredFilter('all');
  };

  const [notes,          setNotes]          = useState([]);
  const [corrections,    setCorrections]    = useState([]);
  const [grammarEntries, setGrammarEntries] = useState([]);
  const [sources,        setSources]        = useState([]);
  const [sections,       setSections]       = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [search,            setSearch]            = useState('');
  const [corrSessionSearch, setCorrSessionSearch] = useState('');
  const [answeredFilter, setAnsweredFilter] = useState('all'); // 'all' | 'open' | 'answered'
  const [selected,                 setSelected]                 = useState(null);
  const [showNew,                  setShowNew]                  = useState(false);
  const [pendingCorrectionSourceId,  setPendingCorrectionSourceId]  = useState(null);
  const [pendingCorrectionSectionId, setPendingCorrectionSectionId] = useState(null);
  const [pendingCorrectionApptId,    setPendingCorrectionApptId]    = useState(null);
  const [pendingNoteSourceId,        setPendingNoteSourceId]        = useState(null);
  const [pendingNoteSectionId,       setPendingNoteSectionId]       = useState(null);
  const [pendingNoteApptId,          setPendingNoteApptId]          = useState(null);
  const [sortMode,                   setSortMode]                   = useState('date');
  const lastPreLinkedKeyRef = useRef(null);

  const uid = auth.currentUser?.uid;

  useEffect(() => {
    if (!uid) return;
    if (embedded && initNotes !== null && initNotes !== undefined) {
      // Embedded: use pre-loaded data from ContentLibraryPage; only load importedCorr ourselves
      setNotes(initNotes || []);
      setCorrections(initCorrections || []);
      setGrammarEntries(initGrammarEntries || []);
      setSources((initSources || []).slice().sort((a, b) => (a.title || '').localeCompare(b.title || '')));
      setSections(initSections || []);
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const [notesSnap, grammarSnap, srcSnap, secSnap] = await Promise.all([
          getDocs(collection(db, 'users', uid, 'notes')),
          getDocs(collection(db, 'users', uid, 'grammar_entries')),
          getDocs(collection(db, 'users', uid, 'content_sources')),
          getDocs(collection(db, 'users', uid, 'content_sections')),
        ]);
        const allNotes = notesSnap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.updatedAt || b.createdAt || '') > (a.updatedAt || a.createdAt || '') ? 1 : -1);
        setNotes(allNotes.filter(n => n.type !== 'correction'));
        setCorrections(allNotes.filter(n => n.type === 'correction'));
        setGrammarEntries(grammarSnap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.entryNumber || 0) - (b.entryNumber || 0)));
        setSources(srcSnap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.title || '').localeCompare(b.title || '')));
        setSections(secSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      } catch (e) {
        console.error('Notes: load failed', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [uid]);

  useEffect(() => {
    if (!defaultOpenNoteId || loading) return;
    const found = notes.find(n => n.id === defaultOpenNoteId);
    if (found) { setTab((found.tags || []).includes('question') ? 'questions' : 'notes'); setSelected(found); }
  }, [defaultOpenNoteId, notes, loading]);

// Open a new corrections session pre-filled with a source when arriving from Content Library
  useEffect(() => {
    if (!defaultCorrectionSourceId || loading) return;
    switchTab('corrections');
    setSelected(null);
    // Store the sourceId so CorrectionsEditor can pick it up via showNew
    setShowNew(true);
    setPendingCorrectionSourceId(defaultCorrectionSourceId);
  }, [defaultCorrectionSourceId, loading]);

useEffect(() => {
    if (!defaultOpenCorrectionId || loading) return;
    const found = corrections.find(c => c.id === defaultOpenCorrectionId);
    if (found) { switchTab('corrections'); setSelected(found); setShowNew(false); }
  }, [defaultOpenCorrectionId, corrections, loading]);

  // Consume preLinkedData from CL section-row buttons — open new note/correction form pre-linked
  useEffect(() => {
    if (!preLinkedData || preLinkedData.key === lastPreLinkedKeyRef.current) return;
    lastPreLinkedKeyRef.current = preLinkedData.key;
    if (preLinkedData.mode === 'note') {
      switchTab('notes');
      setShowNew(true);
      setPendingNoteSourceId(preLinkedData.sourceId || null);
      setPendingNoteSectionId(preLinkedData.sectionId || null);
      setPendingNoteApptId(preLinkedData.apptId || null);
    } else if (preLinkedData.mode === 'correction') {
      switchTab('corrections');
      setShowNew(true);
      setPendingCorrectionSourceId(preLinkedData.sourceId || null);
      setPendingCorrectionSectionId(preLinkedData.sectionId || null);
      setPendingCorrectionApptId(preLinkedData.apptId || null);
    }
    onPreLinkConsumed?.();
  }, [preLinkedData]);

  const handleSave = useCallback(async (data) => {
    if (DEMO) return; // demo: Notes are read-only (7C addendum)
    if (!uid) return;
    const now = new Date().toISOString();
    if (data.id) {
      const updates = { ...data, updatedAt: now };
      await updateDoc(doc(db, 'users', uid, 'notes', data.id), updates);
      if (data.type === 'correction') {
        setCorrections(prev => prev.map(n => n.id === data.id ? { ...n, ...updates } : n));
      } else {
        setNotes(prev => prev.map(n => n.id === data.id ? { ...n, ...updates } : n));
      }
      setSelected({ ...data, updatedAt: now });
    onNoteUpdated?.({ id: data.id, ...updates });
    } else {
      const payload = { ...data, createdAt: now, updatedAt: now };
      const ref = await addDoc(collection(db, 'users', uid, 'notes'), payload);
      const newItem = { id: ref.id, ...payload };
      if (data.type === 'correction') {
        setCorrections(prev => [newItem, ...prev]);
      } else {
        setNotes(prev => [newItem, ...prev]);
      }
      setShowNew(false);
      setSelected(newItem);
      onNoteCreated?.(newItem);
      // Bidirectional section link when created from a section row
      if (data.linkedSectionId) {
        const sec = sections.find(s => s.id === data.linkedSectionId);
        if (sec && uid) {
          const newIds = [...(sec.linkedNoteIds || []), newItem.id];
          setSections(prev => prev.map(s => s.id === data.linkedSectionId ? { ...s, linkedNoteIds: newIds } : s));
          updateDoc(doc(db, 'users', uid, 'content_sections', data.linkedSectionId), { linkedNoteIds: newIds }).catch(() => {});
        }
      }
    }
  }, [uid, sections, onNoteCreated, onNoteUpdated]);

  const handleDelete = useCallback(async (id) => {
    if (DEMO) return; // demo: Notes are read-only (7C addendum)
    if (!uid) return;
    await deleteDoc(doc(db, 'users', uid, 'notes', id));
    setNotes(prev => prev.filter(n => n.id !== id));
    setCorrections(prev => prev.filter(n => n.id !== id));
    setSelected(null);
    setShowNew(false);
    onNoteDeleted?.(id);
  }, [uid, onNoteDeleted]);

  // Inline rename for correction sessions
  const handleRename = useCallback(async (id, newTitle) => {
    if (DEMO) return; // demo: Notes are read-only (7C addendum)
    if (!uid) return;
    setCorrections(prev => prev.map(n => n.id === id ? { ...n, title: newTitle } : n));
    if (selected?.id === id) setSelected(prev => ({ ...prev, title: newTitle }));
    try {
      await updateDoc(doc(db, 'users', uid, 'notes', id), { title: newTitle });
    } catch (e) {
      console.error('Rename failed:', e);
    }
  }, [uid, selected]);

const closeEditor = () => { setSelected(null); setShowNew(false); };

  // Link/unlink a note to a content section bidirectionally.
  const handleLinkNoteToSection = useCallback(async (sectionId, noteId, add) => {
    if (DEMO) return; // demo: Notes are read-only (7C addendum)
    if (!uid) return;
    const sec = sections.find(s => s.id === sectionId);
    if (!sec) return;
    const current = sec.linkedNoteIds || [];
    const next = add
      ? (current.includes(noteId) ? current : [...current, noteId])
      : current.filter(id => id !== noteId);
    setSections(prev => prev.map(s => s.id === sectionId ? { ...s, linkedNoteIds: next } : s));
    try {
      await updateDoc(doc(db, 'users', uid, 'content_sections', sectionId), { linkedNoteIds: next });
    } catch (e) {
      console.error('Note-section link failed:', e);
    }
  }, [uid, sections]);

  const visibleNotes = useMemo(() => {
    let list = tab === 'questions'
      ? notes.filter(n => (n.tags || []).includes('question'))
      : notes.filter(n => !(n.tags || []).includes('question')); // Notes tab excludes questions
    if (tab === 'questions' && answeredFilter !== 'all') {
      list = list.filter(n => answeredFilter === 'answered' ? !!n.answered : !n.answered);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(n =>
        n.title?.toLowerCase().includes(q) ||
        (n.bodyHtml ? n.bodyHtml.replace(/<[^>]+>/g, ' ') : (n.body || '')).toLowerCase().includes(q) ||
        (n.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    if (sortMode === 'source') {
      list = [...list].sort((a, b) => {
        const srcA = sources.find(s => s.id === a.linkedSourceId)?.title || '\uFFFF';
        const srcB = sources.find(s => s.id === b.linkedSourceId)?.title || '\uFFFF';
        if (srcA !== srcB) return srcA.localeCompare(srcB);
        return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
      });
    } else {
      list = [...list].sort((a, b) =>
        (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')
      );
    }
    return list;
  }, [notes, tab, search, answeredFilter, sortMode, sources]);

  const visibleCorrections = useMemo(() => {
    const q = corrSessionSearch.trim().toLowerCase();
    if (!q) return corrections;
    return corrections.filter(c => {
      if (c.title?.toLowerCase().includes(q)) return true;
      const srcTitle = sources.find(s => s.id === c.sourceId)?.title || '';
      if (srcTitle.toLowerCase().includes(q)) return true;
      if ((c.rows || []).some(r => r.topic?.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [corrections, corrSessionSearch, sources]);

  const TABS = [
    { id: 'notes',       label: 'Notes',       count: notes.filter(n => !n.tags?.includes('question')).length },
    { id: 'questions',   label: 'Questions',   count: notes.filter(n => (n.tags || []).includes('question')).length },
    { id: 'corrections', label: 'Corrections', count: corrections.length },
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', color: C.textM, fontSize: '13px' }}>
        Loading notes…
      </div>
    );
  }

  const showEditor = showNew || !!selected;

  return (
    <>
      <style>{`
        .correction-card:hover .edit-pencil { opacity: 0.5 !important; }
        .edit-pencil:hover { opacity: 1 !important; }
        @keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
        .cl-mobile-overlay { animation: slideInRight 0.22s ease both; }
      `}</style>
      <div style={embedded
        ? { display: 'flex', height: '100%', overflow: 'hidden', flex: 1 }
        : { display: 'flex', height: 'calc(100% + 56px)', overflow: 'hidden', margin: '-28px', position: 'relative' }}>
        {/* Left: list */}
        <div style={{ width: isMobile ? '100%' : '420px', minWidth: isMobile ? 0 : '420px', flexShrink: isMobile ? 1 : 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Toolbar */}
          <div style={{ padding: '24px 28px 0', flexShrink: 0 }}>
            {!embedded && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                <h1 style={{ fontFamily: SH.fd, fontSize: '24px', color: C.text }}>Notes</h1>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {DEMO ? (
                    <span style={{ fontSize: '12px', color: C.textM, alignSelf: 'center' }}>Read-only in demo</span>
                  ) : (
                    <>
                      <button style={S.btnPrimary} onClick={() => { switchTab('notes'); setSelected(null); setShowNew(true); }}>+ Note</button>
                      <button style={S.btnPrimary} onClick={() => { switchTab('corrections'); setSelected(null); setShowNew(true); }}>+ Corrections</button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Tabs */}
<div style={{ display: 'flex', gap: '4px', marginBottom: '16px', background: C.cardBg || C.surface, border: `1px solid ${C.border}`, padding: '4px', borderRadius: '12px', width: 'fit-content', ...(isMobile ? { marginLeft: 'auto', marginRight: 'auto' } : {}) }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => switchTab(t.id)}
                  style={{
                    padding: '6px 14px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 500,
                    color: tab === t.id ? C.text : C.textS, cursor: 'pointer', transition: 'all 0.15s',
                    background: tab === t.id ? C.raised : 'transparent',
                    boxShadow: tab === t.id ? '0 1px 4px rgba(0,0,0,0.2)' : 'none',
                    border: 'none',
                  }}>
                  {t.label}
                  {t.count > 0 && <span style={{ marginLeft: '5px', fontSize: '11px', opacity: 0.6 }}>{t.count}</span>}
                </button>
              ))}
            </div>

            {tab === 'corrections' ? (
              <div style={{ marginBottom: '16px' }}>
                <input type="text" placeholder="Search sessions…" value={corrSessionSearch}
                  onChange={e => setCorrSessionSearch(e.target.value)}
                  style={{ ...S.formInput, width: '100%', margin: 0, fontSize: '13px' }} />
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: tab === 'questions' ? '10px' : '16px' }}>
                <input type="text" placeholder="Search notes…" value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ ...S.formInput, flex: 1, margin: 0, fontSize: '13px' }} />
                <button onClick={() => setSortMode(m => m === 'date' ? 'source' : 'date')}
                  style={{ fontSize: '11px', padding: '0 10px', height: '34px', borderRadius: '8px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer', flexShrink: 0 }}>
                  {sortMode === 'date' ? 'Date' : 'Source'}
                </button>
              </div>
            )}

            {tab === 'questions' && (
              <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
                {[
                  { id: 'all',      label: 'All' },
                  { id: 'open',     label: 'Open' },
                  { id: 'answered', label: 'Answered' },
                ].map(f => {
                  const active = answeredFilter === f.id;
                  return (
                    <button key={f.id} onClick={() => setAnsweredFilter(f.id)} style={{
                      padding: '3px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500,
                      border: `1px solid ${active ? C.accent : C.border}`,
                      background: active ? C.accentSoft : 'transparent',
                      color: active ? C.accent : C.textS,
                      cursor: 'pointer', transition: 'all 0.15s',
                    }}>{f.label}</button>
                  );
                })}
              </div>
            )}

            <div style={{ paddingBottom: '16px', borderBottom: `1px solid ${C.border}` }} />
          </div>

          {/* List content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: `0 28px ${isMobile ? '80px' : '28px'}` }}>

            {(tab === 'notes' || tab === 'questions') && (
              visibleNotes.length === 0 ? (
                <div style={{ ...S.emptyState, marginTop: '40px' }}>
                  {notes.length === 0
                    ? <><div style={{ marginBottom: '8px' }}>No notes yet.</div><button style={S.btnPrimary} onClick={() => setShowNew(true)}>Create your first note</button></>
                    : 'No notes match your search.'
                  }
                </div>
              ) : (
                <div style={{ border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden', marginTop: '4px' }}>
                  {visibleNotes.map(note => (
                    <NoteCard key={note.id} note={note}
                      active={selected?.id === note.id}
                      onClick={() => { setShowNew(false); setSelected(note); }}
                      C={C} grammarEntries={grammarEntries}
                      onNavigateToGrammar={onNavigateToGrammar}
                      sourceTitle={note.linkedSourceId ? sources.find(s => s.id === note.linkedSourceId)?.title : null} />
                  ))}
                </div>
              )
            )}

            {tab === 'corrections' && (
              <div style={{ marginTop: '4px' }}>
                {corrections.length > 0 && (
                  <div style={{ marginBottom: '24px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>
                      My Sessions
                    </div>
                    {visibleCorrections.length > 0 ? (
                      <div style={{ border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden' }}>
                        {visibleCorrections.map(s => (
                          <CorrectionCard key={s.id} session={s}
                            active={selected?.id === s.id}
                            onClick={() => { setShowNew(false); setSelected(s); }}
                            onRename={handleRename}
                            C={C} />
                        ))}
                      </div>
                    ) : (
                      <div style={{ ...S.emptyState }}>No sessions match your search.</div>
                    )}
                  </div>
                )}

                {corrections.length === 0 && (
                  <div style={{ ...S.emptyState, marginTop: '40px' }}>
                    <div style={{ marginBottom: '8px' }}>No corrections yet.</div>
                    {!DEMO && <button style={S.btnPrimary} onClick={() => setShowNew(true)}>New corrections session</button>}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Center: decorative image — notes tab only, hidden on narrow viewports */}
        {tab === 'notes' && typeof window !== 'undefined' && window.innerWidth >= 1460 && (
          <div style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
            flexShrink: 1,
            pointerEvents: 'none',
          }}>
            {decoDividerSrc ? (
              <img
                src={decoDividerSrc}
                alt=""
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 0, left: 0, right: 0, bottom: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: 'center center',
                  opacity: 0.88,
                }}
              />
            ) : (
              <div style={{ ...decoBlockStyle(C), position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.5 }} />
            )}
          </div>
        )}

        {/* Right: editor slot — always rendered */}
        {showEditor && tab === 'corrections' && (
          <CorrectionsEditor
            session={showNew ? null : selected}
            defaultSourceId={showNew ? pendingCorrectionSourceId : null}
            defaultSectionId={showNew ? pendingCorrectionSectionId : null}
            defaultApptId={showNew ? pendingCorrectionApptId : null}
            sources={sources}
            sections={sections}
            appointments={appointments}
            onSave={handleSave}
            onDelete={handleDelete}
            onClose={() => { setPendingCorrectionSourceId(null); setPendingCorrectionSectionId(null); setPendingCorrectionApptId(null); closeEditor(); }}
            onNavigateToContent={onNavigateToContent}
            wide={true}
            isOverlay={isMobile}
            C={C} S={S} />
        )}
        {showEditor && tab !== 'corrections' && (
          <NoteEditor
            key={showNew ? '__new__' : selected?.id}
            note={showNew ? null : selected}
            initialTags={showNew && tab === 'questions' ? ['question'] : []}
            initialSourceId={showNew ? pendingNoteSourceId : null}
            initialSectionId={showNew ? pendingNoteSectionId : null}
            initialApptId={showNew ? pendingNoteApptId : null}
            grammarEntries={grammarEntries}
            sections={sections}
            sources={sources}
            appointments={appointments}
            onSave={handleSave}
            onDelete={handleDelete}
            onClose={closeEditor}
            onNavigateToGrammar={onNavigateToGrammar}
            onNavigateToContent={onNavigateToContent}
            onLinkNoteToSection={handleLinkNoteToSection}
            wide={tab === 'questions'}
            isOverlay={isMobile}
            C={C} S={S} />
        )}
        {!showEditor && !isMobile && (
          <div style={{ ...(tab === 'notes' ? { width: '700px', minWidth: '700px' } : { flex: 1, minWidth: '700px' }), borderLeft: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
            <span style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', textAlign: 'center', lineHeight: 1.6 }}>
              Select a note, question, or corrections session to view details.
            </span>
          </div>
        )}
      </div>
    </>
  );
}