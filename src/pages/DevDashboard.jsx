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
import { normalizeLemma } from '../utils/aviUtils.js';

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

// ── AVI Maintenance ───────────────────────────────────────────
// Standing repair tools for the AVI collections, run directly against
// Firestore (same standalone pattern as Recompute Review Stats):
//   1. NFC repair — re-normalizes identity/text fields on lemmaMaster,
//      wordInputs, sentenceInputs, and flashcards; recomputes cleanedLemma
//      with the current normalizeLemma. Duplicate Lemma Master entries that
//      normalization reveals are listed for manual merge, never auto-merged.
//   2. Def2 resync — word rows and non-grammar card backs adopt their
//      Lemma Master entry's def2 where they differ.
//   3. Section / source audit — informational: rows whose stored source or
//      section no longer exists in Content Library, and sentence rows whose
//      cardBack matches neither def2 nor def1 (possibly hand-edited).
// Run with no AVI edits in flight elsewhere, and reload the main app after
// applying — AVIPage keeps an in-memory copy, and its whole-doc diff sync
// could otherwise write stale rows back over a repair.
function AVIMaintenancePanel({ uid, C }) {
  const [status,   setStatus]   = useState('idle'); // idle | scanning | ready | applying
  const [report,   setReport]   = useState(null);
  const [applyMsg, setApplyMsg] = useState('');

  const btnSt = (disabled) => ({
    padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 400,
    border: `1px solid ${C.border}`, background: 'transparent',
    color: C.textS, cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  });

  const scan = async () => {
    if (status === 'scanning' || status === 'applying') return;
    setStatus('scanning'); setApplyMsg('');
    try {
      const [lmSnap, wSnap, sSnap, cardSnap, srcSnap, secSnap] = await Promise.all([
        getDocs(collection(db, 'users', uid, 'lemmaMaster')),
        getDocs(collection(db, 'users', uid, 'wordInputs')),
        getDocs(collection(db, 'users', uid, 'sentenceInputs')),
        getDocs(collection(db, 'users', uid, 'flashcards')),
        getDocs(collection(db, 'users', uid, 'content_sources')),
        getDocs(collection(db, 'users', uid, 'content_sections')),
      ]);
      const load  = (snap) => snap.docs.map(d => ({ ref: d.ref, data: d.data() }));
      const lm    = load(lmSnap), words = load(wSnap), sents = load(sSnap), cards = load(cardSnap);
      const sources  = srcSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const sections = secSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const nfc = (v) => (typeof v === 'string' ? v.normalize('NFC') : v);

      // 1. NFC repair plan — field-level updates only where bytes change
      const nfcUpdates = [];
      const planFields = (ref, data, fieldNames) => {
        const fields = {};
        for (const f of fieldNames) {
          if (data[f] && nfc(data[f]) !== data[f]) fields[f] = nfc(data[f]);
        }
        return { ref, data, fields };
      };
      for (const { ref, data } of lm) {
        const plan  = planFields(ref, data, ['lemma']);
        const clean = normalizeLemma(plan.fields.lemma || data.lemma || '');
        if ((data.cleanedLemma || '') !== clean) plan.fields.cleanedLemma = clean;
        if (Object.keys(plan.fields).length) nfcUpdates.push(plan);
      }
      for (const { ref, data } of words) {
        const plan = planFields(ref, data, ['lemma', 'input']);
        if (Object.keys(plan.fields).length) nfcUpdates.push(plan);
      }
      for (const { ref, data } of sents) {
        const plan = planFields(ref, data, ['targetWord', 'sentence', 'cardFront']);
        if (Object.keys(plan.fields).length) nfcUpdates.push(plan);
      }
      for (const { ref, data } of cards) {
        const plan = planFields(ref, data, ['lemma', 'front']);
        if (Object.keys(plan.fields).length) nfcUpdates.push(plan);
      }

      // Duplicate Lemma Master entries once normalization is applied
      const byNorm = {};
      for (const { data } of lm) {
        const k = normalizeLemma(data.lemma || '');
        if (!k) continue;
        (byNorm[k] = byNorm[k] || []).push(data.lemma || '');
      }
      const lmDuplicates = Object.entries(byNorm)
        .filter(([, arr]) => arr.length > 1)
        .map(([norm, arr]) => `${norm} (${arr.length} entries)`);

      // 2. Def2 resync plan — Lemma Master is canonical
      const lmEntryByNorm = {};
      for (const { data } of lm) {
        const k = normalizeLemma(data.lemma || '');
        if (k && !lmEntryByNorm[k]) lmEntryByNorm[k] = data;
      }
      const def2Updates = [];
      const def2NoCanon = []; // row has a def2 but its LM entry has none — never auto-erased
      for (const { ref, data } of words) {
        const entry = lmEntryByNorm[normalizeLemma(data.lemma || '')];
        if (!entry) continue;
        if ((data.def2 || '') !== (entry.def2 || '')) {
          const label = `${data.lemma}${data.source ? ` (${data.source}${data.section ? ' §' + data.section : ''})` : ''}`;
          if (entry.def2) def2Updates.push({ ref, fields: { def2: entry.def2 }, label });
          else def2NoCanon.push(label);
        }
      }
      const cardBackUpdates = [];
      for (const { ref, data } of cards) {
        if (data.type === 'grammar') continue;
        const entry = data.linkedAVILemmaId
          ? lm.find(x => x.data.lemmaID === data.linkedAVILemmaId)?.data
          : lmEntryByNorm[normalizeLemma(data.lemma || '')];
        if (!entry || !entry.def2) continue;
        if ((data.back || '') !== entry.def2) {
          cardBackUpdates.push({ ref, fields: { back: entry.def2 }, label: data.lemma || '(no lemma)' });
        }
      }

      // 3. Informational: sentence cardBacks matching neither def2 nor def1
      const sentBackReview = [];
      for (const { data } of sents) {
        const entry = lmEntryByNorm[normalizeLemma(data.targetWord || '')];
        if (!entry) continue;
        const cb = data.cardBack || '';
        if (cb && cb !== (entry.def2 || '') && cb !== (entry.def1 || '')) {
          sentBackReview.push(data.targetWord || '');
        }
      }

      // 3b. Orphaned source / section values on rows — grouped with doc refs
      // so the re-tag controls in the report can batch-fix each group.
      const srcByTitle = Object.fromEntries(sources.map(x => [x.title, x]));
      const secsBySrcId = {};
      const sectionsBySrc = {};
      for (const sec of sections) {
        (secsBySrcId[sec.resourceId] = secsBySrcId[sec.resourceId] || new Set()).add(String(sec.content));
        (sectionsBySrc[sec.resourceId] = sectionsBySrc[sec.resourceId] || []).push(String(sec.content));
      }
      const sectionGroups = {};
      const noteRow = (ref, r) => {
        if (!r.source) return;
        const src = srcByTitle[r.source];
        if (!src) {
          const k = `missing|${r.source}`;
          (sectionGroups[k] = sectionGroups[k] || {
            source: r.source, storedSection: null, missingSource: true, srcId: null, refs: [],
          }).refs.push(ref);
          return;
        }
        if (r.section == null || r.section === '') return;
        const set = secsBySrcId[src.id];
        if (!set || !set.has(String(r.section))) {
          const k = `sec|${r.source}|${r.section}`;
          (sectionGroups[k] = sectionGroups[k] || {
            source: r.source, storedSection: String(r.section), missingSource: false, srcId: src.id, refs: [],
          }).refs.push(ref);
        }
      };
      words.forEach(({ ref, data }) => noteRow(ref, data));
      sents.forEach(({ ref, data }) => noteRow(ref, data));

      setReport({
        counts: { lm: lm.length, words: words.length, sents: sents.length, cards: cards.length },
        nfcUpdates, lmDuplicates, def2Updates, def2NoCanon, cardBackUpdates, sentBackReview,
        sectionGroups: Object.values(sectionGroups),
        sectionsBySrc,
      });
      setStatus('ready');
    } catch (e) {
      console.error('AVI maintenance scan failed', e);
      setApplyMsg('Scan failed — check console.');
      setStatus('idle');
    }
  };

  const applyBatch = async (updates) => {
    let batch = writeBatch(db);
    let ops = 0;
    for (const u of updates) {
      batch.update(u.ref, u.fields);
      ops++;
      if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0; }
    }
    if (ops > 0) await batch.commit();
  };

  const applyNfc = async () => {
    if (!report || status === 'applying' || report.nfcUpdates.length === 0) return;
    setStatus('applying');
    try {
      await applyBatch(report.nfcUpdates);
      setApplyMsg(`NFC repair: ${report.nfcUpdates.length} doc${report.nfcUpdates.length === 1 ? '' : 's'} updated. Reload the main app before further AVI edits.`);
      setReport(r => ({ ...r, nfcUpdates: [] }));
    } catch (e) {
      console.error('NFC repair failed', e);
      setApplyMsg('NFC repair failed — check console.');
    }
    setStatus('ready');
  };

  const applyDef2 = async () => {
    if (!report || status === 'applying') return;
    const updates = [...report.def2Updates, ...report.cardBackUpdates];
    if (updates.length === 0) return;
    setStatus('applying');
    try {
      await applyBatch(updates);
      setApplyMsg(`Def2 resync: ${report.def2Updates.length} row${report.def2Updates.length === 1 ? '' : 's'}, ${report.cardBackUpdates.length} card back${report.cardBackUpdates.length === 1 ? '' : 's'} updated. Reload the main app before further AVI edits.`);
      setReport(r => ({ ...r, def2Updates: [], cardBackUpdates: [] }));
    } catch (e) {
      console.error('Def2 resync failed', e);
      setApplyMsg('Def2 resync failed — check console.');
    }
    setStatus('ready');
  };

const applyRetag = async (group, choice) => {
    if (!report || status === 'applying') return;
    setStatus('applying');
    try {
      const fields = group.missingSource
        ? { source: 'Sourceless', section: null }
        : { section: choice === '__CLEAR__' ? null : choice };
      await applyBatch(group.refs.map(ref => ({ ref, fields })));
      setApplyMsg(`Re-tagged ${group.refs.length} row${group.refs.length === 1 ? '' : 's'}. Reload the main app before further AVI edits.`);
      setReport(r => ({ ...r, sectionGroups: r.sectionGroups.filter(x => x !== group) }));
    } catch (e) {
      console.error('Section re-tag failed', e);
      setApplyMsg('Re-tag failed — check console.');
    }
    setStatus('ready');
  };

  const listPreview = (arr, max = 12) => {
    if (!arr.length) return null;
    const shown = arr.slice(0, max);
    return shown.join(', ') + (arr.length > max ? ` … +${arr.length - max} more` : '');
  };

  const lineSt = { fontSize: '12px', color: C.textS, lineHeight: 1.6 };
  const numSt  = { color: C.text, fontWeight: 600 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '760px' }}>
      <div style={{ fontSize: '11.5px', color: C.textM, lineHeight: 1.6 }}>
        Scan is read-only. Apply buttons write field-level repairs to Firestore.
        Run with no AVI edits open in another tab, and reload the main app after applying.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <button onClick={scan} disabled={status === 'scanning' || status === 'applying'} style={btnSt(status === 'scanning' || status === 'applying')}>
          {status === 'scanning' ? 'Scanning…' : 'Scan AVI Data'}
        </button>
        {report && (
          <>
            <button onClick={applyNfc} disabled={status === 'applying' || report.nfcUpdates.length === 0} style={btnSt(status === 'applying' || report.nfcUpdates.length === 0)}>
              Apply NFC Repair ({report.nfcUpdates.length})
            </button>
            <button onClick={applyDef2} disabled={status === 'applying' || (report.def2Updates.length + report.cardBackUpdates.length === 0)} style={btnSt(status === 'applying' || (report.def2Updates.length + report.cardBackUpdates.length === 0))}>
              Apply Def2 Resync ({report.def2Updates.length + report.cardBackUpdates.length})
            </button>
          </>
        )}
        {applyMsg && <span style={{ fontSize: '11px', color: C.textM }}>{applyMsg}</span>}
      </div>
      {report && (
        <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={lineSt}>
            Scanned <span style={numSt}>{report.counts.lm}</span> lemmas, <span style={numSt}>{report.counts.words}</span> word rows, <span style={numSt}>{report.counts.sents}</span> sentence rows, <span style={numSt}>{report.counts.cards}</span> cards.
          </div>
          <div style={lineSt}>
            NFC repair needed: <span style={numSt}>{report.nfcUpdates.length}</span> doc{report.nfcUpdates.length === 1 ? '' : 's'}.
          </div>
          {report.lmDuplicates.length > 0 && (
            <div style={{ ...lineSt, color: C.warning || C.textS }}>
              Duplicate Lemma Master entries (merge manually in Lemma Master): {listPreview(report.lmDuplicates)}
            </div>
          )}
          <div style={lineSt}>
            Def2 out of sync: <span style={numSt}>{report.def2Updates.length}</span> word row{report.def2Updates.length === 1 ? '' : 's'}
            {report.def2Updates.length > 0 && <> — {listPreview(report.def2Updates.map(u => u.label))}</>}
            ; <span style={numSt}>{report.cardBackUpdates.length}</span> card back{report.cardBackUpdates.length === 1 ? '' : 's'}
            {report.cardBackUpdates.length > 0 && <> — {listPreview(report.cardBackUpdates.map(u => u.label))}</>}.
          </div>
          {report.def2NoCanon.length > 0 && (
            <div style={lineSt}>
              Rows with a def2 whose Lemma Master entry has none (not auto-erased — re-enter the def2 on the row to restore the cascade): {listPreview(report.def2NoCanon)}
            </div>
          )}
          {report.sentBackReview.length > 0 && (
            <div style={lineSt}>
              Sentence card backs matching neither def2 nor def1 (possibly hand-edited, not auto-fixed): {listPreview(report.sentBackReview)}
            </div>
          )}
          {report.sectionGroups.length > 0 && (
            <div style={lineSt}>
              Source / section issues:
              {report.sectionGroups.map(g => (
                <SectionRetagRow
                  key={`${g.missingSource ? 'missing' : 'sec'}|${g.source}|${g.storedSection || ''}`}
                  group={g}
                  sectionsBySrc={report.sectionsBySrc}
                  onApply={applyRetag}
                  busy={status === 'applying'}
                  C={C}
                />
              ))}
            </div>
          )}
          {report.nfcUpdates.length === 0 && report.lmDuplicates.length === 0 &&
           report.def2Updates.length === 0 && report.def2NoCanon.length === 0 &&
           report.cardBackUpdates.length === 0 &&
           report.sentBackReview.length === 0 && report.sectionGroups.length === 0 && (
            <div style={{ ...lineSt, color: C.success || C.textS }}>All clean — nothing to repair.</div>
          )}
        </div>
      )}
    </div>
  );
}

// One orphaned source/section group with its fix control: missing sources
// get a "move to Sourceless" action; stale section values get a dropdown of
// the source's current sections (or clear). Field-level batch updates only.
function SectionRetagRow({ group, sectionsBySrc, onApply, busy, C }) {
  const [choice, setChoice] = useState('');
  const options = group.srcId ? (sectionsBySrc[group.srcId] || []) : [];
  const n = group.refs.length;

  const selSt = {
    fontSize: '11px', padding: '3px 8px', borderRadius: '5px',
    border: `1px solid ${C.border}`, background: C.bg, color: C.text, outline: 'none',
  };
  const applySt = (disabled) => ({
    fontSize: '11px', padding: '3px 10px', borderRadius: '5px',
    border: `1px solid ${C.border}`, background: 'transparent',
    color: C.textS, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  });

  if (group.missingSource) {
    return (
      <div style={{ paddingLeft: '12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
        <span>— source "{group.source}" no longer exists: <span style={{ color: C.text, fontWeight: 600 }}>{n}</span> row{n === 1 ? '' : 's'}</span>
        <button style={applySt(busy)} disabled={busy} onClick={() => onApply(group, null)}>
          Move to Sourceless
        </button>
      </div>
    );
  }

  return (
    <div style={{ paddingLeft: '12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
      <span>— {group.source} — stored §{group.storedSection} not among current sections: <span style={{ color: C.text, fontWeight: 600 }}>{n}</span> row{n === 1 ? '' : 's'}</span>
      <select value={choice} onChange={e => setChoice(e.target.value)} style={selSt} disabled={busy}>
        <option value="">Re-tag as…</option>
        {options.map(c => <option key={c} value={c}>§{c}</option>)}
        <option value="__CLEAR__">(clear section)</option>
      </select>
      <button style={applySt(busy || !choice)} disabled={busy || !choice} onClick={() => onApply(group, choice)}>
        Apply
      </button>
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
              <div>
                <div style={{ fontFamily: SH.fb, fontWeight: 700, fontSize: '15px', color: C.text, marginBottom: '14px' }}>AVI Maintenance</div>
                <AVIMaintenancePanel uid={user.uid} C={C} />
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
