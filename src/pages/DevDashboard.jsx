// src/pages/DevDashboard.jsx
// Accessed via window.location.hash === '#dev'
// Not linked from main app's navigation UI

import { useState, useEffect, useMemo, useRef, Children } from 'react';
import {
  collection, getDocs, getDoc, addDoc, updateDoc, deleteDoc, setDoc,
  doc, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { recomputeReviewStats } from '../utils/reviewStatsEngine.js';
import { normalizeLemma } from '../utils/aviUtils.js';
import { planIsEmpty, applyCardDedupe } from '../utils/cardDedupe.js';
import { planNuanceCleanup } from '../utils/nuanceCleanup.js';
import { regenerateLemmaAudio, wordAudioMatches } from '../utils/ttsUtils.js';
import { spokenLemma, needsSpokenRefresh } from '../utils/spokenText.js';

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

// ── Gazette plate pool — discovered from the filesystem at build time, not
// listed by hand. Aliases live in Firestore instead, edited below; new
// images become available just by dropping the file in and deploying, no
// code change needed either way. ──────────────────────────────────────────
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
// Ledger-style tag: small caps on a tinted ground (also the action kind tag).
function Badge({ label, color }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: '10.5px', fontWeight: 500, padding: '1px 7px', borderRadius: '4px',
      letterSpacing: '0.06em', textTransform: 'uppercase', color,
      background: `${color}1f`, fontFamily: SH.fm, whiteSpace: 'nowrap', lineHeight: 1.6,
    }}>{label}</span>
  );
}

// ── Dev Dash layout pieces ────────────────────────────────────
// Shared by both tabs: a Poiret One heading over a fading accent rule, and
// ledger rows (name, kind tag, description and last run on the left,
// controls on the right, results underneath).
const ACTION_NAMES = {
  aviScan: 'Scan AVI data', aviNfc: 'NFC repair', aviDef2: 'Def2 resync',
  aviNuance: '동의어 cleanup', aviRetag: 'Source and section re-tag',
  reviewStats: 'Recompute review stats', cardAudio: 'Update card audio',
  grammarCheck: 'Grammar Index check', grammarDeadLinks: 'Remove dead links',
};
const KIND_LABEL = { read: 'Read-only', write: 'Writes', audio: 'Re-records audio' };
const kindColor  = (kind, C) => ({ read: C.success, write: C.warning, audio: C.accent2 || C.tL }[kind] || C.textM);

function fmtRunDate(iso, withTime = true) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  const day = d.toLocaleDateString('en-US', opts);
  return withTime ? `${day}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : day;
}

function SectionHead({ title, count, note, right, size = 22, C }) {
  return (
    <div style={{ marginBottom: '4px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontFamily: SH.fp, fontSize: `${size}px`, color: C.text, letterSpacing: '0.02em', lineHeight: 1.2 }}>{title}</div>
        {count != null && <span style={{ fontFamily: SH.fm, fontSize: '11px', color: C.textM }}>{count}</span>}
        {right && <div style={{ marginLeft: 'auto', alignSelf: 'center' }}>{right}</div>}
      </div>
      <div style={{ height: '1px', background: `linear-gradient(90deg, ${C.accent}, transparent)`, margin: '6px 0 8px' }} />
      {note && <div style={{ fontSize: '12.5px', color: C.textS, lineHeight: 1.55, maxWidth: '68ch', marginBottom: '4px' }}>{note}</div>}
    </div>
  );
}

// lastRun: undefined hides the line (untracked); null shows "no run recorded".
function ActionRow({ name, kind, desc, lastRun, controls, children, C }) {
  const when = fmtRunDate(lastRun);
  const kids = Children.toArray(children);
  return (
    <div style={{ padding: '14px 0', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '14px', fontWeight: 600, color: C.text }}>{name}</span>
            {kind && <Badge label={KIND_LABEL[kind] || kind} color={kindColor(kind, C)} />}
          </div>
          {desc && <div style={{ fontSize: '12.5px', color: C.textS, lineHeight: 1.55, marginTop: '3px', maxWidth: '68ch' }}>{desc}</div>}
          {lastRun !== undefined && (
            <div style={{ fontSize: '11px', fontFamily: SH.fm, color: C.textM, marginTop: '5px' }}>
              {when ? `Last run ${when}` : 'No run recorded yet'}
            </div>
          )}
        </div>
        {controls && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
            {controls}
          </div>
        )}
      </div>
      {kids.length > 0 && <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>{kids}</div>}
    </div>
  );
}

function ResultBox({ C, children }) {
  return (
    <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {children}
    </div>
  );
}

function ActionGroup({ title, note, open = true, onToggle, C, children }) {
  return (
    <section>
      <SectionHead
        title={title}
        note={open ? note : null}
        right={onToggle && (
          <button onClick={onToggle} style={{
            fontSize: '12px', padding: '3px 10px', borderRadius: '5px', cursor: 'pointer',
            border: `1px solid ${C.border}`, background: 'transparent', color: C.textS,
          }}>{open ? 'Hide' : 'Show'}</button>
        )}
        C={C}
      />
      {open && <div style={{ borderTop: `1px solid ${C.border}` }}>{children}</div>}
    </section>
  );
}

function StatStrip({ stats, C }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', margin: '20px 0 4px' }}>
      {stats.map(s => (
        <div key={s.label} style={{ borderTop: `2px solid ${C.accent}`, paddingTop: '8px', minWidth: 0 }}>
          <b style={{ display: 'block', fontFamily: SH.fm, fontSize: '22px', fontWeight: 500, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{s.value}</b>
          <span style={{ fontSize: '12.5px', color: C.textM }}>{s.label}</span>
        </div>
      ))}
    </div>
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

// ── DevRow (list view ledger line) ────────────────────────────
// Score column on the left (G × N, with the two parts underneath), title,
// tags and notes in the middle, Edit / Delete on the right.
function DevRow({ item, C, onEdit, onDelete }) {
  const s      = calcScore(item);
  const isDone = item.status === 'done';
  const smallBtn = (col) => ({
    fontSize: '11.5px', color: col, padding: '3px 9px', borderRadius: '5px',
    border: `1px solid ${col === C.danger ? C.danger + '44' : C.border}`, background: 'transparent', cursor: 'pointer',
  });
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '48px minmax(0, 1fr) auto', gap: '12px',
      padding: '12px 0', borderBottom: `1px solid ${C.border}`, alignItems: 'start',
      opacity: isDone ? 0.45 : 1,
    }}>
      <div style={{ fontFamily: SH.fm, paddingTop: '1px' }}>
        <div style={{ fontSize: '16px', color: s === null ? C.textM : C.text, lineHeight: 1.2 }}>{s === null ? '—' : s}</div>
        {s !== null && (
          <div style={{ fontSize: '10px', color: C.textM, marginTop: '2px', whiteSpace: 'nowrap' }}>G{item.gratification} · N{item.necessity}</div>
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: '14px', fontWeight: 600, color: C.text, lineHeight: 1.4, wordBreak: 'break-word',
          textDecoration: isDone ? 'line-through' : 'none',
        }}>{item.title}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '5px', alignItems: 'center' }}>
          {item.category && <Badge label={item.category} color={catColor(item.category, C)} />}
          {item.type     && <Badge label={item.type}     color={typeColor(item.type, C)} />}
          {item.effort   && <Badge label={item.effort}   color={effColor(item.effort, C)} />}
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
          {item.subcategory && <span style={{ fontSize: '11.5px', color: C.textM, fontStyle: 'italic' }}>{item.subcategory}</span>}
        </div>
        {item.blockedBy && (
          <div style={{ marginTop: '5px', fontSize: '12px', color: C.danger }}>Blocked by: {item.blockedBy}</div>
        )}
        {item.notes && (
          <div style={{
            marginTop: '5px', fontSize: '12.5px', color: C.textS, lineHeight: 1.5,
            overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          }}>{item.notes}</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: '5px' }}>
        <button onClick={() => onEdit(item)} style={smallBtn(C.textS)}>Edit</button>
        <button onClick={() => onDelete(item)} style={smallBtn(C.danger)}>Delete</button>
      </div>
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
    <button onClick={onClick} aria-pressed={!!active} style={{
      padding: '3px 10px', borderRadius: '99px', fontSize: '12.5px',
      fontWeight: active ? 500 : 400,
      background: active ? C.text : 'transparent',
      color: active ? C.bg : C.textS,
      border: `1px solid ${active ? C.text : C.border}`,
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
      {groups.map(group => (
        <section key={group.id}>
          <SectionHead title={group.label} count={group.items.length} size={19} C={C} />

          {/* Draggable rows — drag to reorder within a group */}
          <div
            onDragOver={e => e.preventDefault()}
            onDrop={() => handleDrop(group.items)}
            style={{ borderTop: `1px solid ${C.border}` }}
          >
            {group.items.map(item => (
              <div
                key={item.id}
                draggable
                onDragStart={e => { setDragId(item.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={e => { e.preventDefault(); if (item.id !== dragId) setDragOverId(item.id); }}
                onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                style={{
                  boxShadow: dragOverId === item.id ? `inset 0 2px 0 ${C.accent}` : 'none',
                  opacity: dragId === item.id ? 0.35 : 1,
                  transition: 'opacity 0.12s',
                  cursor: 'grab',
                }}
              >
                <DevRow item={item} C={C} onEdit={onEdit} onDelete={onDelete} />
              </div>
            ))}
          </div>
        </section>
      ))}

      {groups.length === 0 && (
        <div style={{ textAlign: 'center', color: C.textM, paddingTop: '40px', fontSize: '14px' }}>
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
    <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start', overflowX: 'auto', paddingBottom: '12px' }}>
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
            borderTop: `2px solid ${colAccent(col.id)}`,
            borderRadius: '8px',
            padding: '12px 14px 14px',
            minHeight: '200px',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '12px' }}>
              <span style={{ fontFamily: SH.fp, fontSize: '18px', color: C.text, letterSpacing: '0.02em' }}>{col.label}</span>
              <span style={{ fontSize: '11px', fontFamily: SH.fm, color: C.textM }}>
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
      <div>
        <div style={{ fontFamily: SH.fb, fontWeight: 700, fontSize: '13px', color: C.text, marginBottom: '4px' }}>
          Library plates — {libraryAdFiles.length} file{libraryAdFiles.length === 1 ? '' : 's'}
        </div>
        <div style={{ fontSize: '11px', color: C.textM, marginBottom: '10px' }}>
          Comma-separated aliases, matched against source titles leniently (case/punctuation/whitespace don't need to match exactly). Untagged files still appear in random rotation.
        </div>
        {libraryAdFiles.length === 0 ? (
          <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>No files in src/assets/gazette-plates/library/ yet.</div>
        ) : libraryAdFiles.map(f => (
          <AdAliasRow key={f.filename} file={f} value={adAliases[f.filename]} onSave={onSaveAlias} saved={savedFlash === f.filename} C={C} />
        ))}
      </div>
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
//   4. 동의어 cleanup (bug sweep R1, R2) — relation ids pointing at deleted
//      Lemma Master entries are removed; a word left with no synonym loses
//      its 동의어 row, and its card leaves the 동의어 deck (deleted when
//      that was its only deck). Words deleted from Lemma Master keep their
//      cards, as the delete promised.
// S4: AVIPage saves rows field by field (a repair is no longer written back
// over) and re-reads them once the main app has been away for a minute or
// more; reload the main app to see a repair right away.
function AVIMaintenancePanel({ uid, C, runs, markRun }) {
  const [status,   setStatus]   = useState('idle'); // idle | scanning | ready | applying
  const [report,   setReport]   = useState(null);
  const [applyMsg, setApplyMsg] = useState('');
  const [msgKey,   setMsgKey]   = useState('');   // which row the message belongs to

  const btnSt = (disabled) => ({
    padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 400,
    border: `1px solid ${C.border}`, background: 'transparent',
    color: C.textS, cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  });

  const scan = async () => {
    if (status === 'scanning' || status === 'applying') return;
    setStatus('scanning'); setApplyMsg(''); setMsgKey('scan');
    try {
      const [lmSnap, wSnap, sSnap, cardSnap, srcSnap, secSnap, deckSnap] = await Promise.all([
        getDocs(collection(db, 'users', uid, 'lemmaMaster')),
        getDocs(collection(db, 'users', uid, 'wordInputs')),
        getDocs(collection(db, 'users', uid, 'sentenceInputs')),
        getDocs(collection(db, 'users', uid, 'flashcards')),
        getDocs(collection(db, 'users', uid, 'content_sources')),
        getDocs(collection(db, 'users', uid, 'content_sections')),
        getDocs(collection(db, 'users', uid, 'decks')),
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
      // D1: with duplicate entries, use the one Flashcards Cleanup's resync
      // uses — an entry with a def2 over one without, then the most recently
      // updated — so the two tools never push different definitions.
      const lmEntryByNorm = {};
      for (const { data } of lm) {
        const k = normalizeLemma(data.lemma || '');
        if (!k) continue;
        const cur = lmEntryByNorm[k];
        const better = !cur ||
          (!!data.def2 && !cur.def2) ||
          (!!data.def2 === !!cur.def2 && (data.lastUpdated || '') > (cur.lastUpdated || ''));
        if (better) lmEntryByNorm[k] = data;
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

      // 4. 동의어 cleanup (R1, R2)
      const nuance = planNuanceCleanup({
        lm, words,
        cards: cards.map(({ ref, data }) => ({ id: ref.id, ...data })),
        decks: deckSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      });

      setReport({
        counts: { lm: lm.length, words: words.length, sents: sents.length, cards: cards.length },
        nfcUpdates, lmDuplicates, def2Updates, def2NoCanon, cardBackUpdates, sentBackReview,
        sectionGroups: Object.values(sectionGroups),
        sectionsBySrc, nuance,
      });
      setStatus('ready');
      markRun('aviScan');
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
    setStatus('applying'); setMsgKey('nfc');
    try {
      await applyBatch(report.nfcUpdates);
      setApplyMsg(`NFC repair: ${report.nfcUpdates.length} doc${report.nfcUpdates.length === 1 ? '' : 's'} updated. Reload the main app before further AVI edits.`);
      setReport(r => ({ ...r, nfcUpdates: [] }));
      markRun('aviNfc');
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
    setStatus('applying'); setMsgKey('def2');
    try {
      await applyBatch(updates);
      setApplyMsg(`Def2 resync: ${report.def2Updates.length} row${report.def2Updates.length === 1 ? '' : 's'}, ${report.cardBackUpdates.length} card back${report.cardBackUpdates.length === 1 ? '' : 's'} updated. Reload the main app before further AVI edits.`);
      setReport(r => ({ ...r, def2Updates: [], cardBackUpdates: [] }));
      markRun('aviDef2');
    } catch (e) {
      console.error('Def2 resync failed', e);
      setApplyMsg('Def2 resync failed — check console.');
    }
    setStatus('ready');
  };

  const applyNuance = async () => {
    if (!report || status === 'applying' || nuanceCount(report.nuance) === 0) return;
    setStatus('applying'); setMsgKey('nuance');
    const n = report.nuance;
    try {
      await applyBatch(n.relationUpdates);
      let batch = writeBatch(db);
      let ops = 0;
      for (const { ref } of n.rowDeletes) {
        batch.delete(ref);
        ops++;
        if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0; }
      }
      if (ops > 0) await batch.commit();
      await applyCardDedupe({ uid, plan: n.cardPlan });
      setApplyMsg(`동의어 cleanup: ${n.relationUpdates.length} lemma${n.relationUpdates.length === 1 ? '' : 's'}, ${n.rowDeletes.length} row${n.rowDeletes.length === 1 ? '' : 's'}, ${n.cardPlan.deletes.length + n.cardPlan.deckUpdates.length} card${n.cardPlan.deletes.length + n.cardPlan.deckUpdates.length === 1 ? '' : 's'}. Reload the main app before further AVI edits.`);
      setReport(r => ({ ...r, nuance: { ...r.nuance, relationUpdates: [], rowDeletes: [], cardPlan: { deletes: [], deckUpdates: [], decrements: new Map(), keeps: [] }, cardLabels: [] } }));
      markRun('aviNuance');
    } catch (e) {
      console.error('동의어 cleanup failed', e);
      setApplyMsg('동의어 cleanup failed — check console.');
    }
    setStatus('ready');
  };

const applyRetag = async (group, choice) => {
    if (!report || status === 'applying') return;
    setStatus('applying'); setMsgKey('retag');
    try {
      const fields = group.missingSource
        ? { source: 'Sourceless', section: null }
        : { section: choice === '__CLEAR__' ? null : choice };
      await applyBatch(group.refs.map(ref => ({ ref, fields })));
      setApplyMsg(`Re-tagged ${group.refs.length} row${group.refs.length === 1 ? '' : 's'}. Reload the main app before further AVI edits.`);
      setReport(r => ({ ...r, sectionGroups: r.sectionGroups.filter(x => x !== group) }));
      markRun('aviRetag');
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
  const busy   = status === 'scanning' || status === 'applying';
  const msgFor = (k) => applyMsg && msgKey === k
    ? <div style={{ fontSize: '11.5px', color: C.textM }}>{applyMsg}</div>
    : null;
  const nNfc    = report ? report.nfcUpdates.length : 0;
  const nDef2   = report ? report.def2Updates.length + report.cardBackUpdates.length : 0;
  const nNuance = report ? nuanceCount(report.nuance) : 0;
  const allClean = report &&
    report.nfcUpdates.length === 0 && report.lmDuplicates.length === 0 &&
    report.def2Updates.length === 0 && report.def2NoCanon.length === 0 &&
    report.cardBackUpdates.length === 0 && nuanceCount(report.nuance) === 0 &&
    report.sentBackReview.length === 0 && report.sectionGroups.length === 0;

  return (
    <>
      <ActionRow
        name="Scan AVI data" kind="read" lastRun={runs.aviScan ?? null} C={C}
        desc="Reads every Lemma Master entry, word row, sentence row and card, and works out what each repair below would change. Nothing is written."
        controls={
          <button onClick={scan} disabled={busy} style={btnSt(busy)}>
            {status === 'scanning' ? 'Scanning…' : 'Scan AVI data'}
          </button>
        }
      >
        {report && (
          <ResultBox C={C}>
            <div style={lineSt}>
              Scanned <span style={numSt}>{report.counts.lm}</span> lemmas, <span style={numSt}>{report.counts.words}</span> word rows, <span style={numSt}>{report.counts.sents}</span> sentence rows, <span style={numSt}>{report.counts.cards}</span> cards.
            </div>
            {allClean && <div style={{ ...lineSt, color: C.success || C.textS }}>All clean — nothing to repair.</div>}
          </ResultBox>
        )}
        {msgFor('scan')}
      </ActionRow>

      <ActionRow
        name="NFC repair" kind="write" lastRun={runs.aviNfc ?? null} C={C}
        desc="Re-normalizes Korean text on lemmas, rows and cards and recomputes cleaned lemmas. Duplicate Lemma Master entries it turns up are listed for you to merge by hand, never merged automatically."
        controls={
          <button onClick={applyNfc} disabled={busy || nNfc === 0} style={btnSt(busy || nNfc === 0)}>
            Apply{report ? ` (${nNfc})` : ''}
          </button>
        }
      >
        {report && (
          <ResultBox C={C}>
            <div style={lineSt}>
              NFC repair needed: <span style={numSt}>{report.nfcUpdates.length}</span> doc{report.nfcUpdates.length === 1 ? '' : 's'}.
            </div>
            {report.lmDuplicates.length > 0 && (
              <div style={{ ...lineSt, color: C.warning || C.textS }}>
                Duplicate Lemma Master entries (merge manually in Lemma Master): {listPreview(report.lmDuplicates)}
              </div>
            )}
          </ResultBox>
        )}
        {msgFor('nfc')}
      </ActionRow>

      <ActionRow
        name="Def2 resync" kind="write" lastRun={runs.aviDef2 ?? null} C={C}
        desc="Word rows and card backs adopt their Lemma Master entry's def2 where they differ. Rows whose entry has no def2, and sentence card backs that look hand-edited, are listed but left alone."
        controls={
          <button onClick={applyDef2} disabled={busy || nDef2 === 0} style={btnSt(busy || nDef2 === 0)}>
            Apply{report ? ` (${nDef2})` : ''}
          </button>
        }
      >
        {report && (
          <ResultBox C={C}>
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
          </ResultBox>
        )}
        {msgFor('def2')}
      </ActionRow>

      <ActionRow
        name="동의어 cleanup" kind="write" lastRun={runs.aviNuance ?? null} C={C}
        desc="Removes synonym links that point at deleted Lemma Master entries, drops 동의어 rows left with no synonym, and takes their cards out of the 동의어 deck (a card is deleted only when that was its only deck)."
        controls={
          <button onClick={applyNuance} disabled={busy || nNuance === 0} style={btnSt(busy || nNuance === 0)}>
            Apply{report ? ` (${nNuance})` : ''}
          </button>
        }
      >
        {report && (
          <ResultBox C={C}>
            <div style={lineSt}>
              <span style={numSt}>{report.nuance.relationUpdates.length}</span> lemma{report.nuance.relationUpdates.length === 1 ? '' : 's'} linking to deleted entries
              {report.nuance.relationUpdates.length > 0 && <> — {listPreview(report.nuance.relationUpdates.map(u => u.label))}</>}
              ; <span style={numSt}>{report.nuance.rowDeletes.length}</span> row{report.nuance.rowDeletes.length === 1 ? '' : 's'} with no synonym left
              {report.nuance.rowDeletes.length > 0 && <> — {listPreview(report.nuance.rowDeletes.map(u => u.label))}</>}
              ; <span style={numSt}>{report.nuance.cardLabels.length}</span> card{report.nuance.cardLabels.length === 1 ? '' : 's'} to take out of the deck
              {report.nuance.cardLabels.length > 0 && <> — {listPreview(report.nuance.cardLabels)}</>}.
            </div>
          </ResultBox>
        )}
        {msgFor('nuance')}
      </ActionRow>

      <ActionRow
        name="Source and section re-tag" kind="write" lastRun={runs.aviRetag ?? null} C={C}
        desc="Fixes rows whose source or section no longer exists in the Content Library. Missing sources move to Sourceless; stale sections pick one of the source's current sections, or clear. Each group is applied on its own."
      >
        {report && (
          <ResultBox C={C}>
            {report.sectionGroups.length === 0 ? (
              <div style={lineSt}>No source or section issues.</div>
            ) : (
              <div style={lineSt}>
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
          </ResultBox>
        )}
        {msgFor('retag')}
      </ActionRow>
    </>
  );
}

const nuanceCount = (n) => !n ? 0
  : n.relationUpdates.length + n.rowDeletes.length + (planIsEmpty(n.cardPlan) ? 0 : n.cardPlan.deletes.length + n.cardPlan.deckUpdates.length);

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

// ── Card audio refresh (Echo X4, X-D16) ───────────────────────
// One-time: word and sentence cards whose word contains "(" or "/" were
// recorded saying it as written. This re-records their word audio in the
// spoken form ((주먹을) 날리다 → "주먹을 날리다"; 보장하다 / 보장되다 → both
// words). Grammar cards and sentence audio are untouched. Reload the main
// app afterwards so open pages pick up the new audio.
function CardAudioRefreshPanel({ uid, C, runs, markRun }) {
  const [status,  setStatus]  = useState('idle');   // idle | scanning | ready | running | done
  const [targets, setTargets] = useState([]);
  const [prog,    setProg]    = useState({ done: 0, failed: 0 });
  const stopRef = useRef(false);

  const btnSt = (disabled) => ({
    padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 400,
    border: `1px solid ${C.border}`, background: 'transparent',
    color: C.textS, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  });

  const scan = async () => {
    if (status === 'scanning' || status === 'running') return;
    setStatus('scanning');
    try {
      const snap = await getDocs(collection(db, 'users', uid, 'flashcards'));
      // A8: also cards whose audio was recorded for another word (renamed
      // before renames re-recorded audio): the clip's file name doesn't
      // match the word's spoken form.
      const all = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(c => c.type !== 'grammar')
        .map(c => ({ card: c, word: c.type === 'sentence' ? c.lemma : c.front }))
        .filter(t => t.word);
      const list = [];
      for (const t of all) {
        if (needsSpokenRefresh(t.word)) { list.push(t); continue; }
        if (await wordAudioMatches(t.card) === false) list.push({ ...t, renamed: true });
      }
      setTargets(list);
      setProg({ done: 0, failed: 0 });
      setStatus('ready');
    } catch (e) {
      console.error('Card audio scan failed', e);
      setStatus('idle');
    }
  };

  const run = async () => {
    if (status !== 'ready' || !targets.length) return;
    stopRef.current = false;
    setStatus('running');
    let done = 0, failed = 0;
    for (const t of targets) {
      if (stopRef.current) break;
      const url = await regenerateLemmaAudio({ card: t.card, uid });
      if (url) done++; else failed++;
      setProg({ done, failed });
      await new Promise(r => setTimeout(r, 150));   // same pacing as the audio backfill
    }
    setStatus('done');
    if (done > 0) markRun('cardAudio');
  };

  return (
    <ActionRow
      name="Update card audio" kind="audio" lastRun={runs.cardAudio ?? null} C={C}
      desc="Re-records the word audio on cards whose word has parentheses or a slash, so it says the spoken form, and on cards whose audio says a different word (renamed before renames re-recorded it). Scan first; reload the app afterwards."
      controls={
        <>
          <button onClick={scan} disabled={status === 'scanning' || status === 'running'} style={btnSt(status === 'scanning' || status === 'running')}>
            {status === 'scanning' ? 'Scanning…' : 'Scan cards'}
          </button>
          {status === 'ready' && targets.length > 0 && (
            <button onClick={run} style={btnSt(false)}>Update audio ({targets.length})</button>
          )}
          {status === 'running' && (
            <button onClick={() => { stopRef.current = true; }} style={btnSt(false)}>Stop</button>
          )}
        </>
      }
    >
      {status === 'ready' && (
        <div style={{ fontSize: '12px', color: C.textS }}>
          {targets.length === 0 ? 'No cards need updating.' : (
            <>
              <div style={{ marginBottom: '4px' }}>{targets.length} card{targets.length === 1 ? '' : 's'} to update, for example:</div>
              {targets.slice(0, 6).map(t => (
                <div key={t.card.id} style={{ fontFamily: SH.fk, color: C.textM }}>{t.renamed ? `${t.word} (audio said another word)` : `${t.word} → ${spokenLemma(t.word)}`}</div>
              ))}
            </>
          )}
        </div>
      )}
      {(status === 'running' || status === 'done') && (
        <div style={{ fontSize: '12px', color: C.textS }}>
          {status === 'running' ? 'Updating' : 'Updated'} {prog.done} of {targets.length}{prog.failed ? ` · ${prog.failed} failed` : ''}.
          {status === 'done' && ' Reload the app so open pages pick up the new audio.'}
        </div>
      )}
    </ActionRow>
  );
}

// ── Grammar Index check (G1, read-only) ───────────────────────
// Before the G1 fix, creating an entry could reuse the doc id of an existing
// entry and write over it (term, compare-to and mastery replaced, explanation
// and examples blanked) while a second grammar card was created for the same
// entry. The old card keeps the lost concept's term, compare-to, explanation
// and examples. This scan only reads: it lists entries with more than one
// card, cards whose entry is missing, entries with no card, and duplicate
// entry numbers. Nothing is changed.
// Bug sweep G2: it also lists grammar links on sections, section-less
// sources and notes that point at deleted entries (deletes left them before
// the fix); "Remove dead links" is the one write.
function GrammarCheckPanel({ uid, C, runs, markRun }) {
  const [status, setStatus] = useState('idle'); // idle | scanning | ready | fixing
  const [report, setReport] = useState(null);
  const [fixMsg, setFixMsg] = useState('');

  const btnSt = (disabled) => ({
    padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 400,
    border: `1px solid ${C.border}`, background: 'transparent',
    color: C.textS, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  });
  const clip = (s, n = 140) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  const scan = async () => {
    if (status === 'scanning' || status === 'fixing') return;
    setStatus('scanning');
    try {
      const [entrySnap, cardSnap, secSnap, srcSnap, noteSnap] = await Promise.all([
        getDocs(collection(db, 'users', uid, 'grammar_entries')),
        getDocs(collection(db, 'users', uid, 'flashcards')),
        getDocs(collection(db, 'users', uid, 'content_sections')),
        getDocs(collection(db, 'users', uid, 'content_sources')),
        getDocs(collection(db, 'users', uid, 'notes')),
      ]);
      const entries = entrySnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const byId    = new Map(entries.map(e => [e.id, e]));
      // G2: links to entries that no longer exist.
      const deadLinks = [];
      const collectDead = (snap, field, kind, labelOf) => snap.docs.forEach(d => {
        const ids  = d.data()[field] || [];
        const dead = ids.filter(id => !byId.has(id));
        if (dead.length) deadLinks.push({ ref: d.ref, field, kept: ids.filter(id => byId.has(id)), dead, label: `${kind} ${labelOf(d.data()) || d.id}` });
      });
      collectDead(secSnap,  'glossaryTermIds',  'section', x => x.content);
      collectDead(srcSnap,  'glossaryTermIds',  'source',  x => x.title);
      collectDead(noteSnap, 'linkedGrammarIds', 'note',    x => x.title);
      const cards   = cardSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.type === 'grammar');

      const cardsByEntry = new Map();
      const orphanCards  = [];
      for (const c of cards) {
        if (!c.linkedGrammarEntryId || !byId.has(c.linkedGrammarEntryId)) { orphanCards.push(c); continue; }
        if (!cardsByEntry.has(c.linkedGrammarEntryId)) cardsByEntry.set(c.linkedGrammarEntryId, []);
        cardsByEntry.get(c.linkedGrammarEntryId).push(c);
      }
      const shared = [...cardsByEntry.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([entryId, list]) => ({
          entry: byId.get(entryId),
          cards: [...list].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
        }));
      const noCard = entries.filter(e => !cardsByEntry.has(e.id));

      const byNumber = new Map();
      for (const e of entries) {
        const k = e.entryNumber ?? '(none)';
        if (!byNumber.has(k)) byNumber.set(k, []);
        byNumber.get(k).push(e);
      }
      const dupNumbers = [...byNumber.entries()].filter(([, list]) => list.length > 1);

      const idNums  = entries.map(e => /^grammar_(\d+)$/.exec(e.id)).filter(Boolean).map(m => Number(m[1]));
      const maxId   = idNums.length ? Math.max(...idNums) : null;
      const maxNum  = entries.reduce((m, e) => Math.max(m, e.entryNumber || 0), 0);

      setReport({ entryCount: entries.length, cardCount: cards.length, shared, orphanCards, noCard, dupNumbers, maxId, maxNum, deadLinks });
      setFixMsg('');
      setStatus('ready');
      markRun('grammarCheck');
    } catch (e) {
      console.error('Grammar check failed', e);
      setStatus('idle');
    }
  };

  const removeDeadLinks = async () => {
    if (!report || status !== 'ready' || !report.deadLinks.length) return;
    setStatus('fixing');
    try {
      let batch = writeBatch(db);
      let ops = 0;
      for (const l of report.deadLinks) {
        batch.update(l.ref, { [l.field]: l.kept });
        ops++;
        if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0; }
      }
      if (ops > 0) await batch.commit();
      setFixMsg(`Removed dead grammar links from ${report.deadLinks.length} item${report.deadLinks.length === 1 ? '' : 's'}. Reload the main app to see it.`);
      setReport(r => ({ ...r, deadLinks: [] }));
      markRun('grammarDeadLinks');
    } catch (e) {
      console.error('Removing dead grammar links failed', e);
      setFixMsg('Removing dead links failed — check console.');
    }
    setStatus('ready');
  };

  const lineSt = { fontSize: '12px', color: C.textS, lineHeight: 1.6 };
  const numSt  = { color: C.text, fontWeight: 600 };
  const cardSt = { paddingLeft: '12px', borderLeft: `2px solid ${C.border}`, margin: '4px 0 4px 4px', fontSize: '11.5px', color: C.textS, lineHeight: 1.55 };

  const cardLines = (c, entryTerm) => (
    <div key={c.id} style={cardSt}>
      <div>
        <span style={{ fontFamily: SH.fk, color: C.text, fontWeight: 600 }}>{c.front || '(no term)'}</span>
        {entryTerm != null && (c.front || '') !== (entryTerm || '') && (
          <span style={{ color: C.warning || C.accent }}> — differs from the entry; likely the overwritten concept</span>
        )}
      </div>
      <div style={{ color: C.textM }}>card {c.id} · created {String(c.createdAt || '?').slice(0, 10)} · reviews {c.reps || 0}</div>
      {c.back && <div>Compare to: {clip(c.back)}</div>}
      {(c.explanation || c.notes) && <div>Explanation: {clip(c.explanation || c.notes)}</div>}
      {c.examples && <div>Examples: {clip(c.examples)}</div>}
    </div>
  );

  const nDead = report ? report.deadLinks.length : 0;
  const busy  = status === 'scanning' || status === 'fixing';

  return (
    <>
      <ActionRow
        name="Grammar Index check" kind="read" lastRun={runs.grammarCheck ?? null} C={C}
        desc="Lists entries with more than one card (the older card usually holds a concept overwritten before the G1 fix), cards whose entry is missing, entries with no card, and entry numbers used twice."
        controls={
          <button onClick={scan} disabled={busy} style={btnSt(busy)}>
            {status === 'scanning' ? 'Scanning…' : 'Scan Grammar Index'}
          </button>
        }
      >
        {report && (
          <ResultBox C={C}>
            <div style={lineSt}>
              Scanned <span style={numSt}>{report.entryCount}</span> entries and <span style={numSt}>{report.cardCount}</span> grammar cards.
              {' '}Highest doc id number: <span style={numSt}>{report.maxId ?? '—'}</span>; highest entry number: <span style={numSt}>{report.maxNum}</span>.
            </div>
            <div style={lineSt}>
              Entries with more than one card: <span style={numSt}>{report.shared.length}</span>
              {report.shared.map(({ entry, cards }) => (
                <div key={entry.id} style={{ marginTop: '6px' }}>
                  — <span style={{ fontFamily: SH.fk, color: C.text }}>{entry.glossaryTerm || '(no term)'}</span>
                  <span style={{ color: C.textM }}> ({entry.id}, #{entry.entryNumber ?? '?'})</span>
                  {cards.map(c => cardLines(c, entry.glossaryTerm))}
                </div>
              ))}
            </div>
            <div style={lineSt}>
              Cards whose entry is missing: <span style={numSt}>{report.orphanCards.length}</span>
              {report.orphanCards.map(c => cardLines(c, null))}
            </div>
            <div style={lineSt}>
              Entries with no card: <span style={numSt}>{report.noCard.length}</span>
              {report.noCard.length > 0 && <> — {report.noCard.map(e => `${e.glossaryTerm || '(no term)'} (#${e.entryNumber ?? '?'})`).join(', ')}</>}
            </div>
            <div style={lineSt}>
              Entry numbers used more than once: <span style={numSt}>{report.dupNumbers.length}</span>
              {report.dupNumbers.length > 0 && <> — {report.dupNumbers.map(([n, list]) => `#${n}: ${list.map(e => e.glossaryTerm || e.id).join(' / ')}`).join('; ')}</>}
            </div>
          </ResultBox>
        )}
      </ActionRow>

      <ActionRow
        name="Remove dead links" kind="write" lastRun={runs.grammarDeadLinks ?? null} C={C}
        desc="Clears grammar links on content sections, section-less sources and notes that point at deleted entries. Uses the results of the check above."
        controls={
          <button onClick={removeDeadLinks} disabled={status !== 'ready' || nDead === 0} style={btnSt(status !== 'ready' || nDead === 0)}>
            {status === 'fixing' ? 'Removing…' : `Remove${report ? ` (${nDead})` : ''}`}
          </button>
        }
      >
        {report && (
          <ResultBox C={C}>
            <div style={lineSt}>
              Links to deleted entries: <span style={numSt}>{nDead}</span> item{nDead === 1 ? '' : 's'}
              {nDead > 0 && <> — {report.deadLinks.slice(0, 12).map(l => `${l.label} (${l.dead.length})`).join(', ')}{nDead > 12 ? ` … +${nDead - 12} more` : ''}</>}
            </div>
          </ResultBox>
        )}
        {fixMsg && <div style={{ fontSize: '11.5px', color: C.textM }}>{fixMsg}</div>}
      </ActionRow>
    </>
  );
}

export function DevDashboard({ user }) {
  const { C, G } = useAppTheme();

  const [todos,        setTodos]        = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [mode,         setMode]         = useState('actions'); // 'actions' | 'planning'
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
  const [runs,         setRuns]         = useState({});   // action key → ISO time of last successful run
  const [adsOpen,      setAdsOpen]      = useState(false);

  // Last-run record for each action: users/{uid}/settings/devActionRuns.
  // Written on success only; the boot load only reads settings/main, so
  // this doc never reaches the main app.
  useEffect(() => {
    getDoc(doc(db, 'users', user.uid, 'settings', 'devActionRuns'))
      .then(snap => setRuns(snap.exists() ? snap.data() : {}))
      .catch(e => console.error('devActionRuns load failed', e));
  }, [user.uid]);

  const markRun = (key) => {
    const at = new Date().toISOString();
    setRuns(prev => ({ ...prev, [key]: at }));
    setDoc(doc(db, 'users', user.uid, 'settings', 'devActionRuns'), { [key]: at }, { merge: true })
      .catch(e => console.error('devActionRuns save failed', e));
  };

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
      markRun('reviewStats');
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

  // ── Header stats ─────────────────────────────────────────────
  const countBy = (st) => todos.filter(i => i.status === st).length;
  const lastRunKey = Object.keys(runs)
    .filter(k => ACTION_NAMES[k] && fmtRunDate(runs[k]))
    .sort((a, b) => String(runs[b]).localeCompare(String(runs[a])))[0];
  const neverRun = Object.keys(ACTION_NAMES)
    .filter(k => !fmtRunDate(runs[k])).length;
  const stats = mode === 'actions'
    ? [
        { value: lastRunKey ? fmtRunDate(runs[lastRunKey], false) : '—', label: lastRunKey ? `Last action: ${ACTION_NAMES[lastRunKey]}` : 'No runs recorded yet' },
        { value: neverRun, label: neverRun === 1 ? 'action with no recorded run' : 'actions with no recorded run' },
      ]
    : [
        { value: countBy('inbox'),       label: 'Inbox' },
        { value: countBy('todo'),        label: 'Todo' },
        { value: countBy('in-progress'), label: 'In progress' },
        { value: countBy('blocked'),     label: 'Blocked' },
        { value: countBy('done'),        label: 'Done' },
      ];

  const colSt  = { maxWidth: '960px', margin: '0 auto', paddingLeft: '24px', paddingRight: '24px', boxSizing: 'border-box' };
  const wide   = mode === 'planning' && view === 'kanban';
  const btnSt  = (disabled) => ({
    padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 400,
    border: `1px solid ${C.border}`, background: 'transparent',
    color: C.textS, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
  });
  const filterLabel = (t) => (
    <span style={{ fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, whiteSpace: 'nowrap', marginRight: '2px' }}>{t}</span>
  );
  const filterGap = <div style={{ width: '1px', height: '16px', background: C.border, margin: '0 4px', flexShrink: 0 }} />;

  return (
    <>
      <style>{G}</style>
      <div style={{ height: '100vh', overflowY: 'auto', background: C.bg }}>

        {/* ── Header ── */}
        <header style={{ ...colSt, paddingTop: '28px' }}>
          <h1 style={{ fontFamily: SH.fp, fontWeight: 400, fontSize: 'clamp(30px, 6vw, 44px)', letterSpacing: '0.02em', color: C.text, margin: 0, lineHeight: 1.1 }}>
            Dev Dashboard
          </h1>
          <div style={{ height: '1px', background: `linear-gradient(90deg, ${C.accent}, transparent)`, margin: '10px 0 14px' }} />
          <p style={{ margin: 0, color: C.textS, fontSize: '14px', lineHeight: 1.55, maxWidth: '64ch' }}>
            {mode === 'actions'
              ? 'Maintenance and repair tools that run straight against Firestore. Rows tagged Read-only never change anything; the rest write, and say what they touch.'
              : 'The to-do pile, ranked by gratification times necessity. Drag rows to reorder within a group.'}
          </p>
          <StatStrip stats={stats} C={C} />
        </header>

        {/* ── Tabs ── */}
        <nav role="tablist" style={{ position: 'sticky', top: 0, zIndex: 5, background: C.bg, marginTop: '18px' }}>
          <div style={{ ...colSt, display: 'flex', gap: '4px', borderBottom: `1px solid ${C.border}`, paddingTop: '6px', overflowX: 'auto' }}>
            {[['actions', 'Actions'], ['planning', 'Planning']].map(([m, label]) => (
              <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} style={{
                font: 'inherit', fontSize: '13.5px', background: 'none', border: 'none',
                borderBottom: `2px solid ${mode === m ? C.accent : 'transparent'}`,
                color: mode === m ? C.text : C.textS, fontWeight: mode === m ? 600 : 400,
                padding: '8px 10px', cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: '-1px',
              }}>{label}</button>
            ))}
          </div>
        </nav>

        {/* ── Content ── */}
        {mode === 'actions' ? (
          <div style={{ ...colSt, padding: '24px 24px 64px', display: 'flex', flexDirection: 'column', gap: '36px' }}>

            <ActionGroup
              title="AVI Vocabulary"
              note="Scan first; each repair below unlocks with its count. The main app picks up repairs after it has been in the background for a minute or more, or reload it to see them right away."
              C={C}
            >
              <AVIMaintenancePanel uid={user.uid} C={C} runs={runs} markRun={markRun} />
            </ActionGroup>

            <ActionGroup title="Flashcards and Reviews" C={C}>
              <ActionRow
                name="Recompute review stats" kind="write" lastRun={runs.reviewStats ?? null} C={C}
                desc="Rebuilds total reviews, best day and streaks from the full review log. Safe to repeat whenever the numbers look off."
                controls={
                  <button onClick={handleRecomputeReviewStats} disabled={reviewStatsStatus === 'running'} style={btnSt(reviewStatsStatus === 'running')}>
                    {reviewStatsStatus === 'running' ? 'Running…' : 'Recompute'}
                  </button>
                }
              >
                {reviewStatsResult && <div style={{ fontSize: '11.5px', color: C.textM }}>{reviewStatsResult}</div>}
              </ActionRow>
              <CardAudioRefreshPanel uid={user.uid} C={C} runs={runs} markRun={markRun} />
            </ActionGroup>

            <ActionGroup title="Grammar Index" C={C}>
              <GrammarCheckPanel uid={user.uid} C={C} runs={runs} markRun={markRun} />
            </ActionGroup>

            <ActionGroup title="Gazette" C={C}>
              <ActionRow
                name="Ad aliases" kind="write" C={C}
                desc="Tag Library plate images with source titles so they appear on matching sources in the Gazette. Untagged plates rotate at random. Each field saves when you leave it."
                controls={
                  <button onClick={() => setAdsOpen(o => !o)} style={btnSt(false)}>
                    {adsOpen ? 'Hide' : `Show (${libraryAdFiles.length})`}
                  </button>
                }
              >
                {adsOpen && <GazetteAdsPanel adAliases={adAliases} onSaveAlias={handleSaveAlias} savedFlash={aliasSaveFlash} C={C} />}
              </ActionRow>
            </ActionGroup>
          </div>
        ) : (
          <div style={{ padding: '20px 0 64px' }}>
            {/* Toolbar + filters stay in the reading column */}
            <div style={colSt}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {['list', 'kanban'].map(v => (
                    <FilterPill key={v} label={v} active={view === v} onClick={() => setView(v)} C={C} />
                  ))}
                </div>
                {filterGap}
                <FilterPill label="Show archived" active={showArchived} onClick={() => setShowArchived(v => !v)} C={C} />
                <span style={{ fontSize: '12px', fontFamily: SH.fm, color: C.textM, marginLeft: '6px' }}>
                  {filteredTodos.filter(i => i.status !== 'done').length} active shown
                </span>
                <button
                  onClick={() => setAddOpen(true)}
                  style={{
                    marginLeft: 'auto', padding: '6px 14px', borderRadius: '6px', fontSize: '13px', fontWeight: 500,
                    background: C.accent, color: '#fff', border: `1px solid ${C.accent}`, cursor: 'pointer',
                  }}
                >+ Add item</button>
              </div>

              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '22px' }}>
                {filterLabel('Category')}
                {DEV_CATS.map(c => (
                  <FilterPill key={c} label={c} active={filters.category === c} onClick={() => toggleFilter('category', c)} C={C} />
                ))}
                {filterGap}
                {filterLabel('Type')}
                {DEV_TYPES.map(t => (
                  <FilterPill key={t} label={t} active={filters.type === t} onClick={() => toggleFilter('type', t)} C={C} />
                ))}
                {filterGap}
                {filterLabel('Effort')}
                {DEV_EFFORTS.map(e => (
                  <FilterPill key={e} label={e} active={filters.effort === e} onClick={() => toggleFilter('effort', e)} C={C} />
                ))}
                {filterGap}
                <FilterPill
                  label="Doc needed"
                  active={filters.docNeeded}
                  onClick={() => setFilters(p => ({ ...p, docNeeded: !p.docNeeded }))}
                  C={C}
                />
                {hasActiveFilters && (
                  <button
                    onClick={() => setFilters({ category: '', type: '', effort: '', docNeeded: false })}
                    style={{ fontSize: '12px', color: C.textS, background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', padding: '3px 6px' }}
                  >Clear</button>
                )}
              </div>

              {!wide && (
                <ListView
                  items={filteredTodos}
                  C={C}
                  onEdit={setEditItem}
                  onDelete={setDeleteItem}
                  onReorder={handleReorder}
                />
              )}
            </div>

            {/* Kanban breaks out of the column to use the full width */}
            {wide && (
              <div style={{ padding: '0 24px' }}>
                <KanbanView
                  items={filteredTodos}
                  C={C}
                  onEdit={setEditItem}
                  onDelete={setDeleteItem}
                  showArchived={showArchived}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Modals ── */}
      {addOpen     && <TodoForm item={null}      onSave={handleAdd}  onCancel={() => setAddOpen(false)} C={C} />}
      {editItem    && <TodoForm item={editItem}  onSave={handleSave} onCancel={() => setEditItem(null)} C={C} />}
      {deleteItem  && <DeleteConfirm item={deleteItem} onConfirm={handleDelete} onCancel={() => setDeleteItem(null)} C={C} />}
    </>
  );
}
