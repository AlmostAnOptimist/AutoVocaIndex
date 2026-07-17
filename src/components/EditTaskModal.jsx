import { useState, useEffect, useMemo, useRef } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { RecurrenceSelector } from './RecurrenceSelector.jsx';
import { Icons } from './Icons.jsx';
import { CATEGORIES } from '../constants.js';
import { playSound } from '../utils/soundEngine.js';
import { uid, parseDate, fmtDate } from '../utils/dateUtils.js';
import { DatePicker } from './DatePicker.jsx';
import { SH } from '../theme/buildStyles.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function catColor(catId, C) {
  const m = { life: C.tL, lang: C.tLa, health: C.tH, finance: C.tF };
  return m[catId] || C.textM;
}

// ── Inline item checkbox ──────────────────────────────────────────────────────

function DeleteConfirm({ task, onConfirm, onCancel }) {
  const { C, S } = useAppTheme();
  const isAppt = task?.isAppointmentTask === true;
  return (
    <div style={S.confirmOverlay}>
      <div style={S.confirmBox} className="fade-up">
        <div style={S.confirmTitle}>Delete task?</div>
        <div style={S.confirmMsg}>
          {isAppt
            ? 'Deleting this task will unlink it from its appointment. The appointment will not be deleted.'
            : `"${task?.title}" will be permanently removed. This cannot be undone.`
          }
        </div>
        <div style={S.confirmActions}>
          <button style={S.btnGhost} className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button style={S.btnDanger} onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── Main modal ──────────────────────────────────────────────────────────────

export function EditTaskModal({ task, open, onClose, onSave, onDelete, dsh = 3 }) {
  const { C, S } = useAppTheme();
  const [title, setTitle]             = useState('');
  const [category, setCategory]       = useState('lang');
  const [priority, setPriority]       = useState('med');
  const [date, setDate]               = useState('');
  const [multiDates, setMultiDates]   = useState([]);
  const [time, setTime]               = useState('');
  const [recur, setRecur]             = useState({ type: 'none' });
  const [notes, setNotes]             = useState('');
  const [keepRecord, setKeepRecord]   = useState(false);
  const [persistent, setPersistent]       = useState(false);
  const [push, setPush]                   = useState(false);
  const [confirmOpen, setConfirmOpen]     = useState(false);
  useEffect(() => {
    if (open && task) {
      setTitle(task.title || '');
      setCategory(task.category || 'lang');
      setPriority(task.priority || 'med');
      setDate(task.date || '');
      setMultiDates(Array.isArray(task.dates) && task.dates.length > 1 ? [...task.dates].sort() : []);
      setTime(task.time || '');
      setRecur(task.recurrence || { type: 'none' });
      setNotes(task.notes || '');
      setKeepRecord(task.keepRecord || false);
      setPersistent(task.persistent || false);
      setPush(task.push || false);
      setConfirmOpen(false);
    }
  }, [open, task]);

  const notesRef = useRef(null);
  useEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, 630);
    el.style.height = h + 'px';
    el.style.overflowY = el.scrollHeight > 630 ? 'auto' : 'hidden';
  }, [notes]);

  // ── Multi-date due dates (F1) ──
  const multiLock = multiDates.length > 1;
  const addDateChip = () => {
    if (!date) return;
    setMultiDates(prev => {
      const next = [...new Set([...prev, date])].sort();
      if (next.length > 1) setPush(false);
      return next;
    });
  };
  const removeDateChip = (ds) => setMultiDates(prev => prev.filter(x => x !== ds));

  const handleSave = () => {
    if (!title.trim()) return;
    const finalDates = multiDates.length > 1 ? multiDates : null;
    // Strip multi-date fields from the original, then re-add only if still
    // multi-date — the task sync writes whole docs, so omission removes them.
    const { dates: _dates, completedDates: _cd, ...taskRest } = task;
    onSave({
      ...taskRest,
      title: title.trim(), category, priority,
      date: finalDates ? finalDates[0] : (multiDates.length === 1 ? multiDates[0] : (date || null)),
      time: time || null,
      recurrence: recur, notes: notes.trim(), keepRecord,
      persistent, push: finalDates ? false : push,
      ...(finalDates ? {
        dates: finalDates,
        ...(Array.isArray(task.completedDates)
          ? { completedDates: task.completedDates.filter(ds => finalDates.includes(ds)) }
          : {}),
      } : {}),
    });
    onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      playSound('mouse_click');
      handleSave();
    }
  };

  if (!open || !task) return null;
  const isAppt = task.isAppointmentTask === true;
  return (
    <>
      <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()} onKeyDown={handleKeyDown}>
        <div style={S.modal} className="slide-up">
          <div style={S.modalHeader}>
            <span style={S.modalTitle}>{isAppt ? 'Edit Appointment Task' : 'Edit Task'}</span>
            <button style={{ fontSize: '22px', color: C.textM }} onClick={onClose}>{Icons.x}</button>
          </div>

          <div style={S.formGroup}>
            <label style={S.formLabel}>Task Title</label>
            {isAppt
              ? <div style={{ ...S.formInput, color: C.textM, userSelect: 'none' }}>{title}</div>
              : <input style={S.formInput} value={title}
                  onChange={e => setTitle(e.target.value)}
                  autoFocus />
            }
          </div>

          <div style={S.formRow}>
            {CATEGORIES.length > 1 && (
              <div style={S.formGroup}>
                <label style={S.formLabel}>Category</label>
                <select style={S.formSelect} value={category} onChange={e => setCategory(e.target.value)}>
                  {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>
            )}
            <div style={S.formGroup}>
              <label style={S.formLabel}>Priority</label>
              <select style={S.formSelect} value={priority} onChange={e => setPriority(e.target.value)}>
                <option value="high">High</option>
                <option value="med">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          <div style={S.formRow}>
            <div style={S.formGroup}>
              <label style={S.formLabel}>Due Date</label>
              <DatePicker value={date} onChange={setDate} dsh={dsh} />
            </div>
            <div style={S.formGroup}>
              <label style={S.formLabel}>Time (optional)</label>
              <input style={S.formInput} type="time" value={time} onChange={e => setTime(e.target.value)} />
            </div>
          </div>

          {!isAppt && !persistent && recur.type === 'none' && (
            <div style={S.formGroup}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <div onClick={addDateChip} style={{ ...S.recurChip(false), display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  {Icons.plus} Add date
                </div>
                {multiDates.map(ds => (
                  <div key={ds} onClick={() => removeDateChip(ds)} style={{ ...S.recurChip(true), display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    {fmtDate(parseDate(ds))} <span style={{ opacity: 0.7 }}>{Icons.x}</span>
                  </div>
                ))}
              </div>
              {multiLock && (
                <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>
                  Due on each date shown. Checking the final date completes the task.
                </div>
              )}
            </div>
          )}

          {!isAppt && !multiLock && <div style={S.formGroup}>
            <label style={S.formLabel}>Recurrence</label>
            <RecurrenceSelector value={recur} onChange={val => { setRecur(val); if (val.type !== 'none') { setPush(false); setMultiDates([]); } }} />
          </div>}

          {!isAppt && recur.type !== 'none' && (
            <div style={{ ...S.formGroup, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <label style={S.formLabel}>Keep Record</label>
                <div style={{ fontSize: '11px', color: C.textM, marginTop: '2px' }}>
                  Log the due date to notes each time this task completes
                </div>
              </div>
              <div
                onClick={() => setKeepRecord(r => !r)}
                style={{
                  width: '36px', height: '20px', borderRadius: '10px', flexShrink: 0,
                  background: keepRecord ? C.accent : C.border,
                  cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
                }}
              >
                <div style={{
                  position: 'absolute', top: '3px',
                  left: keepRecord ? '19px' : '3px',
                  width: '14px', height: '14px', borderRadius: '50%',
                  background: '#fff', transition: 'left 0.2s',
                }} />
              </div>
            </div>
          )}

{!isAppt && <div style={{ ...S.formGroup, display: 'flex', alignItems: 'center', justifyContent: 'space-between', opacity: recur.type !== 'none' ? 0.4 : 1 }}>
            <div>
              <label style={S.formLabel}>Always On</label>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '2px' }}>
                Always visible in Today — activate manually when needed
              </div>
            </div>
            <div
              onClick={() => setPersistent(p => { const n = !p; if (n) setMultiDates([]); return n; })}
              style={{
                width: '36px', height: '20px', borderRadius: '10px', flexShrink: 0,
                background: persistent ? C.accent : C.border,
                cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
              }}
            >
              <div style={{
                position: 'absolute', top: '3px',
                left: persistent ? '19px' : '3px',
                width: '14px', height: '14px', borderRadius: '50%',
                background: '#fff', transition: 'left 0.2s',
              }} />
            </div>
          </div>}

          {!isAppt && <div style={{ ...S.formGroup, display: 'flex', alignItems: 'center', justifyContent: 'space-between', opacity: (recur.type !== 'none' || multiLock) ? 0.4 : 1 }}>
            <div>
              <label style={S.formLabel}>Push</label>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '2px' }}>
                Automatically moves to today on each rollover until complete
              </div>
            </div>
            <div
              onClick={() => recur.type === 'none' && !multiLock && setPush(p => !p)}
              style={{
                width: '36px', height: '20px', borderRadius: '10px', flexShrink: 0,
                background: push ? C.accent : C.border,
                cursor: (recur.type !== 'none' || multiLock) ? 'not-allowed' : 'pointer',
                position: 'relative', transition: 'background 0.2s',
              }}
            >
              <div style={{
                position: 'absolute', top: '3px',
                left: push ? '19px' : '3px',
                width: '14px', height: '14px', borderRadius: '50%',
                background: '#fff', transition: 'left 0.2s',
              }} />
            </div>
          </div>}

          <div style={S.formGroup}>
            <label style={S.formLabel}>{isAppt ? 'Results / Notes' : 'Notes (optional)'}</label>
            <textarea
              ref={notesRef}
              style={{ ...S.formInput, resize: 'vertical', minHeight: '80px', overflow: 'hidden' }}
              value={notes} onChange={e => setNotes(e.target.value)} />
          </div>

          <div style={{ ...S.formActions, justifyContent: 'space-between' }}>
            <button style={S.btnDanger} onClick={() => setConfirmOpen(true)}>Delete</button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button style={S.btnGhost} className="btn-ghost" onClick={onClose}>Cancel</button>
              <button style={{ ...S.btnPrimary, ...S.btnMetallic }} className="btn-primary"
                onClick={() => { playSound('mouse_click'); handleSave(); }}>
                Save Changes
              </button>
            </div>
          </div>
        </div>
      </div>
      {confirmOpen && (
        <DeleteConfirm
          task={task}
          onConfirm={() => { onDelete(task.id); setConfirmOpen(false); onClose(); }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </>
  );
}