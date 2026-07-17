import { useState, useEffect, useRef } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { RecurrenceSelector } from './RecurrenceSelector.jsx';
import { Icons } from './Icons.jsx';
import { CATEGORIES } from '../constants.js';
import { playSound } from '../utils/soundEngine.js';
import { toDateStr, getLogicalToday, parseDate, fmtDate } from '../utils/dateUtils.js';
import { APPOINTMENT_TYPES } from '../constants.js';
import { DatePicker } from './DatePicker.jsx';

export function AddTaskModal({ open, onClose, onSave, defaultCategory, appointments = [], saveAppointment, settings = {} }) {
  const { C, S } = useAppTheme();
  const dsh = settings?.dayStartHour ?? 3;
  const [title, setTitle]               = useState('');
  const [category, setCategory]         = useState(defaultCategory || 'lang');
  const [priority, setPriority]         = useState('med');
  const [date, setDate]                 = useState(toDateStr(getLogicalToday(dsh)));
  const [multiDates, setMultiDates]     = useState([]);
  const [time, setTime]                 = useState('');
  const [recur, setRecur]               = useState({ type: 'none' });
  const [notes, setNotes]               = useState('');
  const [keepRecord, setKeepRecord]     = useState(false);
  const [persistent, setPersistent]     = useState(false);
  const [push, setPush]                 = useState(false);
  const [isApptTask,     setIsApptTask]     = useState(false);
  const [apptMode,       setApptMode]       = useState('new');
  const [selectedApptId, setSelectedApptId] = useState('');
  const [apptType,       setApptType]       = useState('');
  const [apptProvider,   setApptProvider]   = useState('');
  const titleRef = useRef(null);
  const notesRef  = useRef(null);

  useEffect(() => {
    if (open) {
      setTitle(''); setNotes(''); setRecur({ type: 'none' }); setKeepRecord(false);
      setPersistent(false); setPush(false); setLinkedListIds([]); setListSectionOpen(false);
      setDate(toDateStr(getLogicalToday(dsh))); setTime(''); setMultiDates([]);
      setIsApptTask(false); setApptMode('new'); setSelectedApptId(''); setApptType(''); setApptProvider('');
      setTimeout(() => titleRef.current?.focus(), 80);
    }
  }, [open]);

  useEffect(() => {
    if (defaultCategory) setCategory(defaultCategory);
  }, [defaultCategory]);

  useEffect(() => {
    if (!isApptTask || apptMode !== 'existing' || !selectedApptId) return;
    const appt = appointments.find(a => a.id === selectedApptId);
    if (appt) {
      if (appt.date) setDate(appt.date);
      setTime(appt.time || '');
    }
  }, [apptMode, selectedApptId, appointments, isApptTask]);

  useEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, 630);
    el.style.height = h + 'px';
    el.style.overflowY = el.scrollHeight > 630 ? 'auto' : 'hidden';
  }, [notes]);

  const handleSave = () => {
    if (isApptTask) {
      if (apptMode === 'existing') {
        if (!selectedApptId) return;
        const appt = appointments.find(a => a.id === selectedApptId);
        if (!appt) return;
        const taskId = uid();
        onSave({
          id: taskId,
          title: `Appt: ${appt.type}`,
          category: appt.category || category,
          priority,
          date: appt.date || null,
          time: appt.time || null,
          recurrence: { type: 'none' },
          notes: appt.results || '',
          keepRecord: false,
          completed: false,
          persistent: false,
          push: false,
          activeToday: false,
          activatedOn: null,
          created: new Date().toISOString(),
          isAppointmentTask: true,
          appointmentId: appt.id,
          apptProvider: appt.provider || '',
        });
        saveAppointment({ ...appt, taskId });
      } else {
        if (!apptType) return;
        const taskId = uid();
        const apptId = uid();
        onSave({
          id: taskId,
          title: `Appt: ${apptType}`,
          category,
          priority,
          date: date || null,
          time: time || null,
          recurrence: { type: 'none' },
          notes: '',
          keepRecord: false,
          completed: false,
          persistent: false,
          push: false,
          activeToday: false,
          activatedOn: null,
          created: new Date().toISOString(),
          isAppointmentTask: true,
          appointmentId: apptId,
          apptProvider: apptProvider.trim(),
        });
        saveAppointment({
          id: apptId,
          type: apptType,
          provider: apptProvider.trim(),
          date: date || null,
          time: time || null,
          category,
          summary: '',
          results: '',
          followUpQueue: [],
          taskId,
          created: new Date().toISOString(),
        });
      }
      onClose();
      return;
    }
    if (!title.trim()) return;
    const finalDates = multiDates.length > 1 ? multiDates : null;
    onSave({
      title: title.trim(), category, priority,
      date: finalDates ? finalDates[0] : (multiDates.length === 1 ? multiDates[0] : (date || null)),
      time: time || null,
      recurrence: recur, notes: notes.trim(), keepRecord,
      completed: false,
      persistent, push: finalDates ? false : push, activeToday: false, activatedOn: null,
      created: new Date().toISOString(),
      ...(finalDates ? { dates: finalDates } : {}),
    });
    onClose();
  };

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

  const rawCustom  = settings.customApptTypes;  const customFlat = Array.isArray(rawCustom)
    ? rawCustom
    : Object.values(rawCustom || {}).flat();
  const allApptTypes = [...new Set([...Object.values(APPOINTMENT_TYPES).flat(), ...customFlat])];  const apptPreviewTitle = isApptTask
    ? (apptMode === 'new'
        ? (apptType ? `Appt: ${apptType}` : '')
        : (selectedApptId ? `Appt: ${(appointments.find(a => a.id === selectedApptId))?.type || ''}` : ''))
    : '';

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      playSound('mouse_click');
      handleSave();
    }
  };

  if (!open) return null;
  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()} onKeyDown={handleKeyDown}>
      <div style={S.modal} className="slide-up">
        <div style={S.modalHeader}>
          <span style={S.modalTitle}>New Task</span>
          <button style={{ fontSize: '22px', color: C.textM }} onClick={onClose}>{Icons.x}</button>
        </div>

        {!isApptTask ? (
          <div style={S.formGroup}>
            <label style={S.formLabel}>Task Title</label>
            <input ref={titleRef} style={S.formInput} value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="What needs to be done?" />
          </div>
        ) : (
          <div style={S.formGroup}>
            <label style={S.formLabel}>Task Title</label>
            <div style={{ ...S.formInput, color: apptPreviewTitle ? C.text : C.textM, userSelect: 'none' }}>
              {apptPreviewTitle || 'Select type or appointment below'}
            </div>
          </div>
        )}

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

        {!isApptTask && !persistent && recur.type === 'none' && (
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

        {!isApptTask && !multiLock && <div style={S.formGroup}>
          <label style={S.formLabel}>Recurrence</label>
          <RecurrenceSelector value={recur} onChange={val => { setRecur(val); if (val.type !== 'none') { setPush(false); setMultiDates([]); } }} />
        </div>}

{!isApptTask && recur.type !== 'none' && (
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

        {!isApptTask && <div style={{ ...S.formGroup, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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

        {!isApptTask && <div style={{ ...S.formGroup, display: 'flex', alignItems: 'center', justifyContent: 'space-between', opacity: (recur.type !== 'none' || multiLock) ? 0.4 : 1 }}>
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

        {!isApptTask && <div style={S.formGroup}>
          <label style={S.formLabel}>Notes (optional)</label>
          <textarea
            ref={notesRef}
            style={{ ...S.formInput, resize: 'vertical', minHeight: '80px', overflow: 'hidden' }}
            value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Additional details..." />
        </div>}

        {/* ── Appointment Task Toggle ───────────────────────── */}
        <div style={{ ...S.formGroup, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <label style={S.formLabel}>Appointment Task</label>
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '2px' }}>
              Link this task to an appointment record
            </div>
          </div>
          <div
            onClick={() => setIsApptTask(v => !v)}
            style={{
              width: '36px', height: '20px', borderRadius: '10px', flexShrink: 0,
              background: isApptTask ? C.accent : C.border,
              cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
            }}
          >
            <div style={{
              position: 'absolute', top: '3px',
              left: isApptTask ? '19px' : '3px',
              width: '14px', height: '14px', borderRadius: '50%',
              background: '#fff', transition: 'left 0.2s',
            }} />
          </div>
        </div>

        {/* ── Appointment sub-form ─────────────────────────── */}
        {isApptTask && (
          <div style={{ ...S.formGroup, background: C.surface, borderRadius: '10px', padding: '12px 14px', border: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
              {[{ id: 'new', label: 'Create new' }, { id: 'existing', label: 'Link existing' }].map(m => (
                <button
                  key={m.id}
                  onClick={() => setApptMode(m.id)}
                  style={{
                    padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 500,
                    border: `1.5px solid ${apptMode === m.id ? C.accent : C.border}`,
                    background: apptMode === m.id ? C.accentSoft : 'transparent',
                    color: apptMode === m.id ? C.accent : C.textS,
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {apptMode === 'new' && (
              <div style={S.formRow}>
                <div style={S.formGroup}>
                  <label style={S.formLabel}>Type</label>
                  <select style={S.formSelect} value={apptType} onChange={e => setApptType(e.target.value)}>
                    <option value="">Select type...</option>
                    {allApptTypes.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div style={S.formGroup}>
                  <label style={S.formLabel}>Provider (optional)</label>
                  <input
                    style={S.formInput}
                    value={apptProvider}
                    onChange={e => setApptProvider(e.target.value)}
                    placeholder="Dr. Smith..."
                  />
                </div>
              </div>
            )}

            {apptMode === 'existing' && (
              <div style={S.formGroup}>
                <label style={S.formLabel}>Appointment</label>
                <select
                  style={S.formSelect}
                  value={selectedApptId}
                  onChange={e => setSelectedApptId(e.target.value)}
                >
                  <option value="">Select an appointment...</option>
                  {appointments
                    .filter(a => !a.taskId)
                    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
                    .map(a => (
                      <option key={a.id} value={a.id}>
                        {a.type}{a.provider ? ` — ${a.provider}` : ''}{a.date ? ` — ${a.date}` : ''}
                      </option>
                    ))
                  }
                </select>
                {selectedApptId && (
                  <div style={{ fontSize: '11px', color: C.textM, marginTop: '6px' }}>
                    Date and time will be pulled from this appointment.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div style={S.formActions}>
          <button style={S.btnGhost} className="btn-ghost" onClick={onClose}>Cancel</button>
          <button style={{ ...S.btnPrimary, ...S.btnMetallic }} className="btn-primary"
            onClick={() => { playSound('mouse_click'); handleSave(); }}>
            {isApptTask ? 'Save Appointment Task' : 'Save Task'}
          </button>
        </div>
      </div>
    </div>
  );
}