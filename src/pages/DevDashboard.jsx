// src/pages/DevDashboard.jsx
// Accessed via window.location.hash === '#dev'
// Not linked from main app's navigation UI

import { useState, useEffect, useMemo } from 'react';
import {
  collection, getDocs, getDoc, addDoc, updateDoc, deleteDoc, setDoc,
  doc, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { recomputeReviewStats } from '../utils/reviewStatsEngine.js';

// ── Constants ─────────────────────────────────────────────────
const DEV_CATS    = ['calendar', 'language', 'life'];
const DEV_TYPES   = ['bug', 'feature', 'polish', 'infrastructure', 'documentation'];
const DEV_EFFORTS = ['small', 'medium', 'large'];
const KANBAN_COLS = [
  { id: 'inbox',        label: 'Inbox'       },
  { id: 'todo',         label: 'Todo'        },
  { id: 'in-progress',  label: 'In Progress' },
  { id: 'blocked',      label: 'Blocked'     },
  { id: 'done',         label: 'Done'        },
];

// ── Gazette ad pools — discovered from the filesystem at build time, not
// listed by hand. Aliases (Library only) live in Firestore instead, edited
// below; new images become available just by dropping the file in and
// deploying, no code change needed either way. ─────────────────────────
const libraryAdModules = import.meta.glob('../assets/gazette-plates/library/*.{png,jpg,jpeg,PNG,JPG,JPEG}', { eager: true, query: '?url', import: 'default' });

function globToFileList(modules) {
  return Object.entries(modules)
    .map(([path, url]) => ({ filename: path.split('/').pop(), url }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
}
const libraryAdFiles = globToFileList(libraryAdModules);

// ── Score helpers ─────────────────────────────────────────────
function calcScore(item) {
  if (!item.gratification || !item.necessity) return null;
  return item.gratification * item.necessity;
}
function scoreTier(s) {
  if (s === null || s === undefined) return 'inbox';
  if (s >= 7) return 'high';
  if (s >= 4) return 'medium';
  return 'low';
}

// ── Color helpers ─────────────────────────────────────────────
const catColor  = (cat, C)    => ({ calendar: C.tL, language: C.tLa, life: C.accent2 || C.textS }[cat]    || C.textM);
const typeColor = (type, C)   => ({ bug: C.danger, feature: C.success, polish: C.warning, infrastructure: C.textS, documentation: C.accent2 || C.tL }[type] || C.textM);
const effColor  = (effort, C) => ({ small: C.success, medium: C.warning, large: C.danger }[effort] || C.textM);

// ── Local style helpers ───────────────────────────────────────
const labelSt = C => ({
  fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: C.textM, display: 'block', marginBottom: '6px', marginTop: '16px',
});
const inputSt = C => ({
  width: '100%', padding: '8px 11px', borderRadius: '7px',
  border: `1px solid ${C.border}`, background: C.bg,
  color: C.text, fontSize: '13.5px', outline: 'none',
  fontFamily: SH.fb,
});
const chipSt = (active, C, activeCol) => ({
  padding: '5px 11px', borderRadius: '6px', fontSize: '12px',
  fontWeight: active ? 600 : 400,
  background: active ? (activeCol || C.accent) : C.raised,
  color: active ? '#fff' : C.textS,
  border: `1px solid ${active ? (activeCol || C.accent) : C.border}`,
  cursor: 'pointer', textTransform: 'capitalize', transition: 'all 0.12s',
});
const scoreChipSt = (active, col) => ({
  width: '36px', height: '36px', borderRadius: '7px', fontSize: '15px', fontWeight: 700,
  background: active ? col : 'transparent',
  color: active ? '#fff' : col,
  border: `2px solid ${col}${active ? '' : '55'}`,
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  transition: 'all 0.12s',
});

// ── Badge ─────────────────────────────────────────────────────
function Badge({ label, color }) {
  return (
    <span style={{
      fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '10px',
      letterSpacing: '0.04em', textTransform: 'capitalize', color,
      background: `${color}22`, border: `1px solid ${color}44`,
      fontFamily: SH.fm, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// ── Score Pips ────────────────────────────────────────────────
function ScorePips({ g, n, C }) {
  const pip = (filled, col) => (
    <span style={{
      width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block',
      background: filled ? col : `${col}28`,
      border: `1px solid ${col}${filled ? 'bb' : '44'}`,
      transition: 'background 0.12s',
    }} />
  );
  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
        <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', color: C.textM, fontFamily: SH.fm, marginRight: '3px' }}>G</span>
        {[1, 2, 3].map(i => <span key={i}>{pip(g >= i, C.accent)}</span>)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
        <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', color: C.textM, fontFamily: SH.fm, marginRight: '3px' }}>N</span>
        {[1, 2, 3].map(i => <span key={i}>{pip(n >= i, C.accent2 || C.tL)}</span>)}
      </div>
    </div>
  );
}

// ── DevCard ───────────────────────────────────────────────────
function DevCard({ item, C, onEdit, onDelete }) {
  const s    = calcScore(item);
  const tier = scoreTier(s);
  const isDone = item.status === 'done';

  const topBorder = {
    high:   `3px solid ${C.accent}`,
    medium: `2px solid ${C.borderB}`,
    low:    `1px solid ${C.border}`,
    inbox:  `2px solid ${C.accent2 || C.tL}`,
  }[tier] || `1px solid ${C.border}`;

  const titleSize = tier === 'high' ? '15px' : tier === 'low' ? '12.5px' : '13.5px';
  const opacity   = isDone ? 0.28 : tier === 'low' ? 0.62 : 1;

  return (
    <div style={{
      background: C.raised,
      border: `1px solid ${C.border}`,
      borderTop: topBorder,
      borderRadius: '10px',
      padding: tier === 'high' ? '14px 16px' : '11px 14px',
      opacity,
      transition: 'opacity 0.15s',
    }}>
      {/* Title + actions */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' }}>
        <div style={{
          flex: 1, fontSize: titleSize,
          fontWeight: tier === 'high' ? 600 : 500,
          color: C.text,
          textDecoration: isDone ? 'line-through' : 'none',
          lineHeight: 1.35, wordBreak: 'break-word',
        }}>
          {item.title}
        </div>
        <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
          <button
            onClick={() => onEdit(item)}
            style={{
              fontSize: '11px', color: C.textS, padding: '2px 8px',
              borderRadius: '5px', border: `1px solid ${C.border}`,
              background: 'transparent', cursor: 'pointer',
            }}
          >Edit</button>
          <button
            onClick={() => onDelete(item)}
            style={{
              fontSize: '11px', color: C.danger, padding: '2px 8px',
              borderRadius: '5px', border: `1px solid ${C.danger}44`,
              background: 'transparent', cursor: 'pointer',
            }}
          >Delete</button>
        </div>
      </div>

      {/* Badges */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: s !== null ? '9px' : 0, alignItems: 'center' }}>
        {item.category    && <Badge label={item.category} color={catColor(item.category, C)} />}
        {item.type        && <Badge label={item.type}     color={typeColor(item.type, C)}     />}
        {item.effort      && <Badge label={item.effort}   color={effColor(item.effort, C)}    />}
        {item.status && !['inbox', 'todo'].includes(item.status) && (
          <Badge
            label={item.status}
            color={
              item.status === 'blocked'     ? C.danger  :
              item.status === 'done'        ? C.textM   :
              item.status === 'in-progress' ? C.warning : C.textS
            }
          />
        )}
        {item.docNeeded   && <Badge label="doc needed" color={C.accent2 || C.tL} />}
        {item.subcategory && (
          <span style={{ fontSize: '10px', color: C.textM, fontStyle: 'italic' }}>{item.subcategory}</span>
        )}
      </div>

      {/* Score pips */}
      {s !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ScorePips g={item.gratification} n={item.necessity} C={C} />
          <span style={{ fontSize: '10px', fontFamily: SH.fm, color: C.textM }}>{s}/9</span>
        </div>
      )}

      {/* Blocked by */}
      {item.blockedBy && (
        <div style={{ marginTop: '6px', fontSize: '11px', color: C.danger, fontStyle: 'italic' }}>
          Blocked by: {item.blockedBy}
        </div>
      )}

      {/* Notes preview */}
      {item.notes && (
        <div style={{
          marginTop: '6px', fontSize: '11px', color: C.textS, lineHeight: 1.45,
          overflow: 'hidden', display: '-webkit-box',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }}>{item.notes}</div>
      )}
    </div>
  );
}

// ── Delete Confirm ────────────────────────────────────────────
function DeleteConfirm({ item, onConfirm, onCancel, C }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: '12px', padding: '24px', maxWidth: '380px', width: '90%',
      }}>
        <div style={{ fontSize: '15px', fontWeight: 600, color: C.text, marginBottom: '8px' }}>
          Delete permanently?
        </div>
        <div style={{ fontSize: '13px', color: C.textS, marginBottom: '20px', lineHeight: 1.5 }}>
          "{item.title}" will be removed completely. To keep it out of view without losing it, set its status to Done instead.
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{ padding: '7px 14px', borderRadius: '6px', fontSize: '13px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textS, cursor: 'pointer' }}
          >Cancel</button>
          <button
            onClick={onConfirm}
            style={{ padding: '7px 14px', borderRadius: '6px', fontSize: '13px', background: C.danger, color: '#fff', border: 'none', cursor: 'pointer' }}
          >Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── Todo Form Modal ───────────────────────────────────────────
function TodoForm({ item, onSave, onCancel, C }) {
  const isNew = !item;
  const [form, setForm] = useState(() => item ? { ...item } : {
    title: '', status: 'inbox', category: '', subcategory: '',
    type: '', gratification: null, necessity: null, effort: '',
    blockedBy: '', notes: '', docNeeded: false,
  });

  const set     = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const toggle  = (k, v) => setForm(p => ({ ...p, [k]: p[k] === v ? (typeof v === 'number' ? null : '') : v }));
  const isInbox = form.status === 'inbox';
  const canSave = form.title.trim().length > 0;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      zIndex: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
    }}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: '14px', width: '100%', maxWidth: '520px',
        maxHeight: '90vh', overflowY: 'auto', padding: '24px',
      }}>
        <div style={{ fontFamily: SH.fd, fontSize: '18px', fontWeight: 600, color: C.text, marginBottom: '2px' }}>
          {isNew ? 'Add Item' : 'Edit Item'}
        </div>

        {/* Title */}
        <label style={labelSt(C)}>Title</label>
        <input
          value={form.title}
          onChange={e => set('title', e.target.value)}
          style={inputSt(C)}
          placeholder="What needs to be done?"
          autoFocus
        />

        {/* Status */}
        <label style={labelSt(C)}>Status</label>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {['inbox', 'todo', 'in-progress', 'blocked', 'done'].map(s => (
            <button key={s} onClick={() => set('status', s)} style={chipSt(form.status === s, C)}>
              {s}
            </button>
          ))}
        </div>

        {/* Category */}
        <label style={labelSt(C)}>Category</label>
        <div style={{ display: 'flex', gap: '6px' }}>
          {DEV_CATS.map(c => (
            <button key={c} onClick={() => toggle('category', c)} style={chipSt(form.category === c, C, catColor(c, C))}>
              {c}
            </button>
          ))}
        </div>

        {/* Subcategory */}
        <label style={labelSt(C)}>
          Subcategory
          <span style={{ color: C.textM, fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: '5px' }}>(optional)</span>
        </label>
        <input
          value={form.subcategory || ''}
          onChange={e => set('subcategory', e.target.value)}
          style={inputSt(C)}
          placeholder="e.g. flashcards, grammar, AVI, recurrence engine..."
        />

        {/* Type */}
        <label style={labelSt(C)}>Type</label>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {DEV_TYPES.map(t => (
            <button key={t} onClick={() => toggle('type', t)} style={chipSt(form.type === t, C, typeColor(t, C))}>
              {t}
            </button>
          ))}
        </div>

        {/* G / N / Effort — hidden when status is inbox */}
        {!isInbox && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
            {/* Gratification */}
            <div>
              <label style={labelSt(C)}>Gratification</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                {[1, 2, 3].map(v => (
                  <button key={v} onClick={() => toggle('gratification', v)} style={scoreChipSt(form.gratification === v, C.accent)}>
                    {v}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '10px', color: C.textM, marginTop: '5px', lineHeight: 1.4 }}>
                Relief when shipped
              </div>
            </div>
            {/* Necessity */}
            <div>
              <label style={labelSt(C)}>Necessity</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                {[1, 2, 3].map(v => (
                  <button key={v} onClick={() => toggle('necessity', v)} style={scoreChipSt(form.necessity === v, C.accent2 || C.tL)}>
                    {v}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '10px', color: C.textM, marginTop: '5px', lineHeight: 1.4 }}>
                Needed for completeness
              </div>
            </div>
            {/* Effort */}
            <div>
              <label style={labelSt(C)}>Effort</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                {DEV_EFFORTS.map(e => (
                  <button key={e} onClick={() => toggle('effort', e)} style={chipSt(form.effort === e, C, effColor(e, C))}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Blocked by — only when status is blocked */}
        {form.status === 'blocked' && (
          <>
            <label style={labelSt(C)}>Blocked by</label>
            <input
              value={form.blockedBy || ''}
              onChange={e => set('blockedBy', e.target.value)}
              style={inputSt(C)}
              placeholder="What is this waiting on?"
            />
          </>
        )}

        {/* Notes */}
        <label style={labelSt(C)}>
          Notes
          <span style={{ color: C.textM, fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: '5px' }}>(optional)</span>
        </label>
        <textarea
          value={form.notes || ''}
          onChange={e => set('notes', e.target.value)}
          style={{ ...inputSt(C), minHeight: '80px', resize: 'vertical' }}
          placeholder="Context, observations, dependencies..."
        />

        {/* Doc Needed */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '16px', marginBottom: '20px' }}>
          <input
            type="checkbox"
            id="docNeeded"
            checked={!!form.docNeeded}
            onChange={e => set('docNeeded', e.target.checked)}
            style={{ width: '15px', height: '15px', accentColor: C.accent, cursor: 'pointer', flexShrink: 0 }}
          />
          <label htmlFor="docNeeded" style={{ fontSize: '13px', color: C.textS, cursor: 'pointer', lineHeight: 1.4 }}>
            Documentation needed when this ships
          </label>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', borderTop: `1px solid ${C.border}`, paddingTop: '16px' }}>
          <button
            onClick={onCancel}
            style={{ padding: '7px 14px', borderRadius: '6px', fontSize: '13px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textS, cursor: 'pointer' }}
          >Cancel</button>
          <button
            onClick={() => canSave && onSave(form)}
            style={{
              padding: '7px 16px', borderRadius: '6px', fontSize: '13px', fontWeight: 500,
              background: canSave ? C.accent : C.border,
              color: canSave ? '#fff' : C.textM,
              border: 'none', cursor: canSave ? 'pointer' : 'default', transition: 'all 0.15s',
            }}
          >{isNew ? 'Add' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Filter Pill ───────────────────────────────────────────────
function FilterPill({ label, active, onClick, C }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 10px', borderRadius: '12px', fontSize: '11px',
      fontWeight: active ? 600 : 400,
      background: active ? C.accentSoft : 'transparent',
      color: active ? C.accent : C.textS,
      border: `1px solid ${active ? C.accent + '55' : C.border}`,
      cursor: 'pointer', textTransform: 'capitalize', transition: 'all 0.12s', whiteSpace: 'nowrap',
    }}>{label}</button>
  );
}

// ── List View ─────────────────────────────────────────────────
function ListView({ items, C, onEdit, onDelete, onReorder }) {
  const [dragId,     setDragId]     = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const { activeItems, doneItems } = useMemo(() => ({
    activeItems: items.filter(i => i.status !== 'done'),
    doneItems:   items.filter(i => i.status === 'done').sort((a, b) => (a.order || 0) - (b.order || 0)),
  }), [items]);

  const groups = useMemo(() => {
    const inbox  = activeItems.filter(i => calcScore(i) === null).sort((a, b) => (a.order || 0) - (b.order || 0));
    const scored = activeItems.filter(i => calcScore(i) !== null).sort((a, b) => {
      const diff = (calcScore(b) || 0) - (calcScore(a) || 0);
      return diff !== 0 ? diff : (a.order || 0) - (b.order || 0);
    });
    const high   = scored.filter(i => (calcScore(i) || 0) >= 7);
    const medium = scored.filter(i => { const s = calcScore(i) || 0; return s >= 4 && s < 7; });
    const low    = scored.filter(i => (calcScore(i) || 0) < 4);
    return [
      { id: 'inbox',  label: 'Inbox',           items: inbox,     tier: 'inbox'  },
      { id: 'high',   label: 'High Priority',   items: high,      tier: 'high'   },
      { id: 'medium', label: 'Medium Priority', items: medium,    tier: 'medium' },
      { id: 'low',    label: 'Low Priority',    items: low,       tier: 'low'    },
      { id: 'done',   label: 'Archived',        items: doneItems, tier: 'done'   },
    ].filter(g => g.items.length > 0);
  }, [activeItems, doneItems]);

  const tierAccent = { high: C.accent, medium: C.borderB, low: C.border, inbox: C.accent2 || C.tL, done: C.textM };

  function handleDrop(groupItems) {
    if (!dragId || !dragOverId || dragId === dragOverId) {
      setDragId(null); setDragOverId(null); return;
    }
    const fromIdx = groupItems.findIndex(i => i.id === dragId);
    const toIdx   = groupItems.findIndex(i => i.id === dragOverId);
    if (fromIdx === -1 || toIdx === -1) { setDragId(null); setDragOverId(null); return; }
    const reordered = [...groupItems];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    onReorder(reordered);
    setDragId(null); setDragOverId(null);
  }

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto' }}>
      {groups.map(group => (
        <div key={group.id} style={{ marginBottom: '28px' }}>
          {/* Group header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
            <div style={{
              width: '3px', height: '14px', borderRadius: '2px',
              background: tierAccent[group.tier] || C.textM, flexShrink: 0,
            }} />
            <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.textM }}>
              {group.label}
            </span>
            <span style={{ fontSize: '10px', fontFamily: SH.fm, color: C.textM, opacity: 0.5 }}>
              {group.items.length}
            </span>
            <div style={{ flex: 1, height: '1px', background: C.border }} />
          </div>

          {/* Draggable items */}
          <div onDragOver={e => e.preventDefault()} onDrop={() => handleDrop(group.items)}>
            {group.items.map(item => (
              <div
                key={item.id}
                draggable
                onDragStart={e => { setDragId(item.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={e => { e.preventDefault(); if (item.id !== dragId) setDragOverId(item.id); }}
                onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                style={{
                  outline: dragOverId === item.id ? `2px solid ${C.accent}66` : 'none',
                  borderRadius: '10px',
                  opacity: dragId === item.id ? 0.35 : 1,
                  transition: 'opacity 0.12s',
                  cursor: 'grab',
                  marginBottom: '8px',
                }}
              >
                <DevCard item={item} C={C} onEdit={onEdit} onDelete={onDelete} />
              </div>
            ))}
          </div>
        </div>
      ))}

      {groups.length === 0 && (
        <div style={{ textAlign: 'center', color: C.textM, paddingTop: '60px', fontSize: '14px' }}>
          No items match the current filters.
        </div>
      )}
    </div>
  );
}

// ── Kanban View ───────────────────────────────────────────────
function KanbanView({ items, C, onEdit, onDelete, showArchived }) {
  const cols = KANBAN_COLS.filter(col => showArchived || col.id !== 'done');

  const colAccent = (id) => ({
    inbox:       C.accent2 || C.tL,
    todo:        C.textS,
    'in-progress': C.warning,
    blocked:     C.danger,
    done:        C.textM,
  }[id] || C.textM);

  return (
    <div style={{ display: 'flex', gap: '14px', height: '100%', alignItems: 'flex-start' }}>
      {cols.map(col => {
        const colItems = items
          .filter(i => i.status === col.id)
          .sort((a, b) => {
            const sa = calcScore(a) || 0, sb = calcScore(b) || 0;
            return sb !== sa ? sb - sa : (a.order || 0) - (b.order || 0);
          });
        return (
          <div key={col.id} style={{
            flex: '0 0 270px',
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderTop: `3px solid ${colAccent(col.id)}`,
            borderRadius: '10px',
            padding: '14px',
            minHeight: '200px',
            maxHeight: 'calc(100vh - 160px)',
            overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <span style={{
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: colAccent(col.id),
              }}>{col.label}</span>
              <span style={{ fontSize: '10px', fontFamily: SH.fm, color: C.textM, opacity: 0.55 }}>
                {colItems.length}
              </span>
            </div>
            {colItems.length === 0 && (
              <div style={{ fontSize: '11px', color: C.textM, opacity: 0.35, textAlign: 'center', paddingTop: '20px' }}>
                Empty
              </div>
            )}
            {colItems.map(item => (
              <div key={item.id} style={{ marginBottom: '8px' }}>
                <DevCard item={item} C={C} onEdit={onEdit} onDelete={onDelete} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────
// ── Gazette ad alias row — one library file, comma-separated aliases,
// auto-saves on blur. Matching itself (lenient, whitespace/case-insensitive)
// lives in the ad-selection component built later in Stage 13, not here —
// this is purely the editing surface.
function AdAliasRow({ file, value, onSave, saved, C }) {
  const [draft, setDraft] = useState(value || '');
  useEffect(() => { setDraft(value || ''); }, [value]);
  const commit = () => { if (draft !== (value || '')) onSave(file.filename, draft); };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
      <img src={file.url} alt={file.filename}
        style={{ width: '40px', height: '56px', objectFit: 'cover', borderRadius: '4px', border: `1px solid ${C.border}`, flexShrink: 0 }} />
      <div title={file.filename} style={{
        width: '180px', fontSize: '12px', color: C.text, flexShrink: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{file.filename}</div>
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
        placeholder="Aliases, comma-separated…"
        style={{ flex: 1, fontSize: '12px', padding: '5px 8px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, outline: 'none' }}
      />
      <span style={{ fontSize: '10px', color: C.success || C.accent, width: '40px', flexShrink: 0, opacity: saved ? 1 : 0, transition: 'opacity 0.2s' }}>Saved</span>
    </div>
  );
}

function GazetteAdsPanel({ adAliases, onSaveAlias, savedFlash, C }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '720px' }}>
      </div>
  );
}

export function DevDashboard({ user }) {
  const { C, G } = useAppTheme();

  const [todos,        setTodos]        = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [mode,         setMode]         = useState('planning'); // 'planning' | 'actions'
  const [view,         setView]         = useState('list');
  const [showArchived, setShowArchived] = useState(false);
  const [filters,      setFilters]      = useState({ category: '', type: '', effort: '', docNeeded: false });
  const [addOpen,      setAddOpen]      = useState(false);
  const [editItem,     setEditItem]     = useState(null);
  const [deleteItem,   setDeleteItem]   = useState(null);
  const [reviewStatsStatus, setReviewStatsStatus] = useState('idle');
  const [reviewStatsResult, setReviewStatsResult] = useState('');
  const [adAliases,    setAdAliases]    = useState({});
  const [aliasSaveFlash, setAliasSaveFlash] = useState('');


  // ── Standing utility, not just a one-time migration: full recompute of
  // users/{uid}/settings/reviewStats from the entire reviewLog collection.
  // Seeds the doc the first time (FlashcardsPage reads it incrementally
  // after that), and doubles as an on-demand repair tool if the incremental
  // numbers are ever suspected to have drifted. dsh defaults to 3 here since
  // DevDashboard doesn't have the user's actual day-start-hour setting
  // wired in — only affects whether a streak still in progress reads as
  // "alive" at the moment of recompute, which self-corrects on the next
  // real review either way.
  const handleRecomputeReviewStats = async () => {
    if (!user?.uid || reviewStatsStatus === 'running') return;
    setReviewStatsStatus('running');
    setReviewStatsResult('');
    try {
      const stats = await recomputeReviewStats(user.uid, 3);
      setReviewStatsResult(`${stats.totalAllTime} reviews, best day ${stats.bestDay?.count ?? 0}, longest streak ${stats.longestStreak?.length ?? 0}d.`);
    } catch (e) {
      console.error('Review stats recompute failed', e);
      setReviewStatsResult('Failed — check console.');
    }
    setReviewStatsStatus('idle');
  };

  // Gazette ad aliases — real app data the live Gazette feature reads, so
  // this lives under users/{uid}/settings, not dev/{uid} (despite the
  // editing surface being here). Loaded once on mount, same as todos.
  useEffect(() => {
    getDoc(doc(db, 'users', user.uid, 'settings', 'gazetteAdAliases'))
      .then(snap => setAdAliases(snap.exists() ? snap.data() : {}))
      .catch(e => console.error('gazetteAdAliases load failed', e));
  }, [user.uid]);

  const handleSaveAlias = async (filename, value) => {
    setAdAliases(prev => ({ ...prev, [filename]: value }));
    try {
      await setDoc(doc(db, 'users', user.uid, 'settings', 'gazetteAdAliases'), { [filename]: value }, { merge: true });
      setAliasSaveFlash(filename);
      setTimeout(() => setAliasSaveFlash(f => f === filename ? '' : f), 1500);
    } catch (e) {
      console.error('gazetteAdAliases save failed', e);
    }
  };

  // ── Load from Firestore ──────────────────────────────────────
  useEffect(() => {
    getDocs(collection(db, 'dev', user.uid, 'todos'))
      .then(snap => {
        setTodos(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [user.uid]);

  // ── Filter ───────────────────────────────────────────────────
  const filteredTodos = useMemo(() => todos.filter(item => {
    if (!showArchived && item.status === 'done') return false;
    if (filters.category && item.category !== filters.category) return false;
    if (filters.type     && item.type     !== filters.type)     return false;
    if (filters.effort   && item.effort   !== filters.effort)   return false;
    if (filters.docNeeded && !item.docNeeded)                   return false;
    return true;
  }), [todos, showArchived, filters]);

  // ── Add ──────────────────────────────────────────────────────
  async function handleAdd(form) {
    const newDoc = {
      title:         form.title.trim(),
      status:        form.status        || 'inbox',
      category:      form.category      || '',
      subcategory:   form.subcategory   || '',
      type:          form.type          || '',
      effort:        form.effort        || '',
      gratification: form.gratification || null,
      necessity:     form.necessity     || null,
      blockedBy:     form.blockedBy     || '',
      notes:         form.notes         || '',
      docNeeded:     !!form.docNeeded,
      order:         Date.now(),
      createdAt:     serverTimestamp(),
    };
    const ref = await addDoc(collection(db, 'dev', user.uid, 'todos'), newDoc);
    setTodos(prev => [...prev, { ...newDoc, id: ref.id, createdAt: new Date() }]);
    setAddOpen(false);
  }

  // ── Save edit ────────────────────────────────────────────────
  async function handleSave(form) {
    if (!editItem) return;
    const updates = {
      title:         form.title.trim(),
      status:        form.status,
      category:      form.category      || '',
      subcategory:   form.subcategory   || '',
      type:          form.type          || '',
      effort:        form.effort        || '',
      gratification: form.gratification || null,
      necessity:     form.necessity     || null,
      blockedBy:     form.blockedBy     || '',
      notes:         form.notes         || '',
      docNeeded:     !!form.docNeeded,
    };
    await updateDoc(doc(db, 'dev', user.uid, 'todos', editItem.id), updates);
    setTodos(prev => prev.map(i => i.id === editItem.id ? { ...i, ...updates } : i));
    setEditItem(null);
  }

  // ── Delete ───────────────────────────────────────────────────
  async function handleDelete() {
    if (!deleteItem) return;
    await deleteDoc(doc(db, 'dev', user.uid, 'todos', deleteItem.id));
    setTodos(prev => prev.filter(i => i.id !== deleteItem.id));
    setDeleteItem(null);
  }

  // ── Reorder (within score group) ─────────────────────────────
  async function handleReorder(reorderedGroup) {
    const batch = writeBatch(db);
    reorderedGroup.forEach((item, i) => {
      batch.update(doc(db, 'dev', user.uid, 'todos', item.id), { order: (i + 1) * 10 });
    });
    await batch.commit();
    const orderMap = Object.fromEntries(reorderedGroup.map((item, i) => [item.id, (i + 1) * 10]));
    setTodos(prev => prev.map(i => orderMap[i.id] !== undefined ? { ...i, order: orderMap[i.id] } : i));
  }

  // ── Filter helpers ───────────────────────────────────────────
  const toggleFilter = (key, val) => setFilters(prev => ({ ...prev, [key]: prev[key] === val ? '' : val }));
  const hasActiveFilters = filters.category || filters.type || filters.effort || filters.docNeeded;

  // ── Loading ──────────────────────────────────────────────────
  if (loading) {
    return (
      <>
        <style>{G}</style>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: C.bg, color: C.textM, fontSize: '14px' }}>
          Loading...
        </div>
      </>
    );
  }

  return (
    <>
      <style>{G}</style>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, overflow: 'hidden' }}>

        {/* ── Header ── */}
        <div style={{
          background: C.surface, borderBottom: `1px solid ${C.border}`,
          padding: '0 24px', height: '64px',
          display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0,
        }}>
          <div style={{ fontFamily: SH.fd, fontSize: '20px', fontWeight: 600, color: C.logoText, letterSpacing: '-0.3px' }}>
            Dev Dashboard
          </div>

          {/* Top-level mode toggle */}
          <div style={{ display: 'flex', gap: '3px', background: C.raised, borderRadius: '8px', padding: '3px' }}>
            {[['planning', 'Planning'], ['actions', 'Actions']].map(([m, label]) => (
              <button key={m} onClick={() => setMode(m)} style={{
                padding: '5px 12px', borderRadius: '5px', fontSize: '12px', fontWeight: 500,
                background: mode === m ? C.accent : 'transparent',
                color: mode === m ? '#fff' : C.textS,
                border: 'none', cursor: 'pointer', transition: 'all 0.12s',
              }}>{label}</button>
            ))}
          </div>

          {mode === 'planning' && (
            <>
              {/* View toggle */}
              <div style={{ display: 'flex', gap: '3px', background: C.raised, borderRadius: '8px', padding: '3px' }}>
                {['list', 'kanban'].map(v => (
                  <button key={v} onClick={() => setView(v)} style={{
                    padding: '5px 12px', borderRadius: '5px', fontSize: '12px', fontWeight: 500,
                    background: view === v ? C.accent : 'transparent',
                    color: view === v ? '#fff' : C.textS,
                    border: 'none', cursor: 'pointer', textTransform: 'capitalize', transition: 'all 0.12s',
                  }}>{v}</button>
                ))}
              </div>

              <span style={{ fontSize: '11px', fontFamily: SH.fm, color: C.textM }}>
                {filteredTodos.filter(i => i.status !== 'done').length} active
              </span>
            </>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
            {mode === 'planning' && (
              <>
                <button
                  onClick={() => setShowArchived(v => !v)}
                  style={{
                    padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 400,
                    border: `1px solid ${showArchived ? C.accent + '55' : C.border}`,
                    background: showArchived ? C.accentSoft : 'transparent',
                    color: showArchived ? C.accent : C.textS,
                    cursor: 'pointer', transition: 'all 0.12s',
                  }}
                >{showArchived ? 'Archived: On' : 'Archived: Off'}</button>
                <button
                  onClick={() => setAddOpen(true)}
                  style={{
                    padding: '7px 14px', borderRadius: '6px', fontSize: '13px', fontWeight: 500,
                    background: C.accent, color: '#fff', border: 'none', cursor: 'pointer',
                  }}
                >+ Add Item</button>
              </>
            )}
          </div>
        </div>

        {/* ── Filter bar ── */}
        {mode === 'planning' && (
        <div style={{
          background: C.surface, borderBottom: `1px solid ${C.border}`,
          padding: '8px 24px', display: 'flex', gap: '6px',
          alignItems: 'center', flexWrap: 'wrap', flexShrink: 0,
        }}>
          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, whiteSpace: 'nowrap' }}>Cat</span>
          {DEV_CATS.map(c => (
            <FilterPill key={c} label={c} active={filters.category === c} onClick={() => toggleFilter('category', c)} C={C} />
          ))}

          <div style={{ width: '1px', height: '16px', background: C.border, margin: '0 2px', flexShrink: 0 }} />

          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, whiteSpace: 'nowrap' }}>Type</span>
          {DEV_TYPES.map(t => (
            <FilterPill key={t} label={t} active={filters.type === t} onClick={() => toggleFilter('type', t)} C={C} />
          ))}

          <div style={{ width: '1px', height: '16px', background: C.border, margin: '0 2px', flexShrink: 0 }} />

          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, whiteSpace: 'nowrap' }}>Effort</span>
          {DEV_EFFORTS.map(e => (
            <FilterPill key={e} label={e} active={filters.effort === e} onClick={() => toggleFilter('effort', e)} C={C} />
          ))}

          <div style={{ width: '1px', height: '16px', background: C.border, margin: '0 2px', flexShrink: 0 }} />

          <FilterPill
            label="Doc Needed"
            active={filters.docNeeded}
            onClick={() => setFilters(p => ({ ...p, docNeeded: !p.docNeeded }))}
            C={C}
          />

          {hasActiveFilters && (
            <button
              onClick={() => setFilters({ category: '', type: '', effort: '', docNeeded: false })}
              style={{
                padding: '4px 10px', borderRadius: '12px', fontSize: '11px',
                color: C.textM, border: `1px solid ${C.border}`,
                background: 'transparent', cursor: 'pointer',
              }}
            >Clear</button>
          )}
        </div>
        )}

        {/* ── Content ── */}
        <div style={{
          flex: 1,
          overflowY: mode === 'actions' || view === 'list' ? 'auto' : 'hidden',
          overflowX: mode === 'planning' && view === 'kanban' ? 'auto' : 'hidden',
          padding: '24px',
        }}>
          {mode === 'actions' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
              <div>
                <div style={{ fontFamily: SH.fb, fontWeight: 700, fontSize: '15px', color: C.text, marginBottom: '14px' }}>Gazette Ads</div>
                <GazetteAdsPanel adAliases={adAliases} onSaveAlias={handleSaveAlias} savedFlash={aliasSaveFlash} C={C} />
              </div>
              <div>
                <div style={{ fontFamily: SH.fb, fontWeight: 700, fontSize: '15px', color: C.text, marginBottom: '14px' }}>Review Stats</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    onClick={handleRecomputeReviewStats}
                    disabled={reviewStatsStatus === 'running'}
                    style={{
                      padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 400,
                      border: `1px solid ${C.border}`, background: 'transparent',
                      color: C.textS, cursor: reviewStatsStatus === 'running' ? 'default' : 'pointer',
                      opacity: reviewStatsStatus === 'running' ? 0.6 : 1,
                    }}
                  >{reviewStatsStatus === 'running' ? 'Running…' : 'Recompute Review Stats'}</button>
                  {reviewStatsResult && (
                    <span style={{ fontSize: '11px', color: C.textM }}>{reviewStatsResult}</span>
                  )}
                </div>
              </div>
            </div>
          ) : view === 'list' ? (
            <ListView
              items={filteredTodos}
              C={C}
              onEdit={setEditItem}
              onDelete={setDeleteItem}
              onReorder={handleReorder}
            />
          ) : (
            <KanbanView
              items={filteredTodos}
              C={C}
              onEdit={setEditItem}
              onDelete={setDeleteItem}
              showArchived={showArchived}
            />
         )}
        </div>
      </div>

      {/* ── Modals ── */}
      {addOpen     && <TodoForm item={null}      onSave={handleAdd}  onCancel={() => setAddOpen(false)} C={C} />}
      {editItem    && <TodoForm item={editItem}  onSave={handleSave} onCancel={() => setEditItem(null)} C={C} />}
      {deleteItem  && <DeleteConfirm item={deleteItem} onConfirm={handleDelete} onCancel={() => setDeleteItem(null)} C={C} />}
    </>
  );
}
