// src/components/AppointmentModal.jsx
// Stage 4 additions: source/section linking (lang category only),
// section done checkbox with auto-advance, provider placeholder by category.

import { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { uid, toDateStr, getLogicalToday } from '../utils/dateUtils.js';
import { DatePicker } from './DatePicker.jsx';
import { APPOINTMENT_TYPES } from '../constants.js';
import { getOrderedSectionsForSource } from '../utils/contentUtils.js';
import { playSound } from '../utils/soundEngine.js';

// ── Shared constants & helpers ────────────────────────────────

export const CURRENCIES      = ['KRW', 'USD', 'EUR'];
export const CATEGORY_LABELS = { lang: '한국어' };
export const CATEGORY_IDS    = ['lang'];

export function catColor(catId, C) {
  const m = { lang: C.tLa };
  return m[catId] || C.textM;
}

export function fmtApptDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch { return dateStr; }
}

export function fmtTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  const h    = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${mStr} ${ampm}`;
}

const PROVIDER_PLACEHOLDER = {
  lang:    'e.g. 태웅쌤, 서강',
};

// ── DeleteConfirm ─────────────────────────────────────────────

function DeleteConfirm({ label, hasLinkedTask, onConfirm, onCancel, C, S }) {
  return (
    <div style={S.confirmOverlay}>
      <div style={S.confirmBox} className="fade-up">
        <div style={S.confirmTitle}>Delete appointment?</div>
        <div style={S.confirmMsg}>
          "{label}" will be permanently removed. This cannot be undone.
          {hasLinkedTask && (
            <div style={{ marginTop: '6px' }}>
              Its linked calendar task will also be deleted.
            </div>
          )}
        </div>
        <div style={S.confirmActions}>
          <button style={S.btnGhost} className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button style={S.btnDanger} onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── Section picker ────────────────────────────────────────────

function SectionSelect({ value, onChange, allSections, placeholder, style }) {
  const queue    = allSections.filter(s => s.status !== 'Done' && s.status !== 'Skip');
  const done     = allSections.filter(s => s.status === 'Done');
  const skip     = allSections.filter(s => s.status === 'Skip');
  const previous = [...done, ...skip];
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value || null)} style={style}>
      <option value="">{placeholder || 'No section selected'}</option>
      {queue.length > 0 && (
        <optgroup label="Queue">
          {queue.map(s => <option key={s.id} value={s.id}>{s.content}</option>)}
        </optgroup>
      )}
      {previous.length > 0 && (
        <optgroup label="Previous">
          {previous.map(s => <option key={s.id} value={s.id}>{s.content}</option>)}
        </optgroup>
      )}
    </select>
  );
}

// ── SourceSearchPicker ────────────────────────────────────────

function SourceSearchPicker({ value, onChange, sources, placeholder, C, S }) {
  const [search, setSearch] = useState('');
  const [open, setOpen]     = useState(false);
  const ref = useRef(null);

  const selected = value ? (sources || []).find(s => s.id === value) : null;

  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q) return sources || [];
    return (sources || []).filter(s => s.title?.includes(q));
  }, [sources, search]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (selected) {
    return (
      <div style={{ ...S.formInput, display: 'flex', alignItems: 'center', gap: '6px', cursor: 'default' }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px', color: C.text }}>
          {selected.title}
        </span>
        <button
          onClick={() => onChange(null)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textM, fontSize: '16px', padding: 0, lineHeight: 1, flexShrink: 0 }}
        >×</button>
      </div>
    );
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        type="text"
        placeholder={placeholder || 'Search sources…'}
        value={search}
        onChange={e => { setSearch(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => setOpen(true)}
        style={S.formInput}
      />
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: '8px',
          maxHeight: '180px', overflowY: 'auto', marginTop: '3px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>
              No sources found.
            </div>
          ) : filtered.map(s => (
            <div
              key={s.id}
              onMouseDown={e => { e.preventDefault(); onChange(s.id); setOpen(false); setSearch(''); }}
              style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '13px', color: C.text, borderBottom: `1px solid ${C.border}` }}
              className="task-row"
            >
              {s.title}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── AppointmentModal ──────────────────────────────────────────
export function AppointmentModal({
  open, existing, onSave, onDelete, onClose,
  updateData, settings,
  sources, sections, onSectionComplete,
  tasks, onToggle, onDeleteTask,
  linkedNotes, onNavigateToNote, onNavigateToCorrection,
  onNavigateToNewNote, onNavigateToNewCorrection,
}) {
  const { C, S } = useAppTheme();
  const dsh = settings?.dayStartHour ?? 3;

  const [date,             setDate]             = useState('');
  const [time,             setTime]             = useState('');
  const [type,             setType]             = useState('Tutoring');
  const [provider,         setProvider]         = useState('');
  const [category,         setCategory]         = useState('lang');
  const [summary,          setSummary]          = useState('');
  const [results,          setResults]          = useState('');
  const [outcome,          setOutcome]          = useState(null);
  const [followUpQueue,    setFollowUpQueue]    = useState([]);
  const [newQueueDate,     setNewQueueDate]     = useState('');
  const [newQueueTime,     setNewQueueTime]     = useState('');
  const [clearConfirm,     setClearConfirm]     = useState(false);
  const [costs,            setCosts]            = useState([]);
  const [costsSectionOpen, setCostsSectionOpen] = useState(false);
  const [taskId,           setTaskId]           = useState(null);
  const [confirmOpen,      setConfirmOpen]      = useState(false);

  // Stage 6: reminder tasks
  const [reminderTaskIds,     setReminderTaskIds]     = useState([]);
  const [newReminders,        setNewReminders]        = useState([]);
  const [pendingUnlinks,      setPendingUnlinks]      = useState([]);
  const [pendingDeletes,      setPendingDeletes]      = useState([]);
  const [reminderSectionOpen, setReminderSectionOpen] = useState(false);
  const [addReminderOpen,     setAddReminderOpen]     = useState(false);
  const [newReminderTitle,    setNewReminderTitle]    = useState('');
  const [newReminderDate,     setNewReminderDate]     = useState('');
  const [newReminderNotes,    setNewReminderNotes]    = useState('');
  const [confirmRemoverId,    setConfirmRemoverId]    = useState(null);

  // Stage 4
  const [mainSourceId,       setMainSourceId]       = useState(null);
  const [mainSectionId,      setMainSectionId]      = useState(null);
  const [additionalSources,  setAdditionalSources]  = useState([]);
  const [sectionDoneEnabled, setSectionDoneEnabled] = useState(false);
  const [notesOpen,          setNotesOpen]          = useState(false);

  const summaryRef = useRef(null);

  const typeOptions = useMemo(() => {
    const base   = APPOINTMENT_TYPES[category] || [];
    const raw    = settings?.customApptTypes;
    const custom = Array.isArray(raw) ? raw : (raw?.[category] || []);
    return [...base, ...custom];
  }, [category, settings?.customApptTypes]);

  const isLessonType = type === 'Tutoring' || type === 'Class';

  const reminderTasks = useMemo(() =>
    (reminderTaskIds || [])
      .map(id => (tasks || []).find(t => t.id === id))
      .filter(Boolean)
      .filter(t => !pendingDeletes.includes(t.id) && !pendingUnlinks.includes(t.id)),
  [reminderTaskIds, tasks, pendingDeletes, pendingUnlinks]);

  const mainSourceSections = useMemo(() =>
    mainSourceId ? getOrderedSectionsForSource(sections || [], sources || [], mainSourceId) : [],
  [mainSourceId, sections, sources]);

  const mainSectionAlreadyDone = useMemo(() => {
    if (!mainSectionId) return false;
    return (sections || []).find(s => s.id === mainSectionId)?.status === 'Done';
  }, [mainSectionId, sections]);

  useEffect(() => {
    if (!open) return;
    if (existing) {
      setDate(existing.date || '');
      setTime(existing.time || '');
      setType(existing.type || 'Tutoring');
      setProvider(existing.provider || '');
      setCategory(existing.category || 'lang');
      setSummary(existing.summary || '');
      setResults(existing.results || '');
      setOutcome(existing.outcome || null);
      if (existing.followUpQueue) {
        setFollowUpQueue([...existing.followUpQueue].sort((a, b) => a.date.localeCompare(b.date)));
      } else if (existing.followUpDate) {
        setFollowUpQueue([{ date: existing.followUpDate, time: existing.followUpTime || '' }]);
      } else {
        setFollowUpQueue([]);
      }
      const existingCosts = existing.costs && existing.costs.length > 0
        ? existing.costs
        : existing.cost != null
          ? [{ id: uid(), label: 'Post', date: existing.date || toDateStr(getLogicalToday(dsh)), amount: String(existing.cost), currency: existing.costCurrency || 'KRW', notes: '' }]
          : [];
      setCosts(existingCosts);
      setCostsSectionOpen(existingCosts.length > 0);
      setListSectionOpen(linked.length > 0);
      setTaskId(existing.taskId || null);
      const hasSource = !!(existing.mainSourceId || (existing.additionalSources || []).length);
      setMainSourceId(existing.mainSourceId || null);
      setMainSectionId(existing.mainSectionId || null);
      setAdditionalSources((existing.additionalSources || []).map(a => ({ ...a, id: a.id || uid() })));
      if (existing.date) {
        const [y, m, d] = existing.date.split('-').map(Number);
        const now = new Date();
        if (!existing.time) {
          setSectionDoneEnabled(now >= new Date(y, m - 1, d));
        } else {
          const [h, min] = existing.time.split(':').map(Number);
          setSectionDoneEnabled(now >= new Date(y, m - 1, d, h, min));
        }
      } else {
        setSectionDoneEnabled(false);
      }
      const existingReminderIds = existing.reminderTaskIds || [];
      setReminderTaskIds(existingReminderIds);
      setReminderSectionOpen(existingReminderIds.length > 0);
    } else {
      setDate(toDateStr(getLogicalToday(dsh)));
      setTime('');
      setType(APPOINTMENT_TYPES.lang[0]);
      setProvider('');
      setCategory('lang');
      setSummary('');
      setResults('');
      setFollowUpQueue([]);
      setCosts([]);
      setCostsSectionOpen(false);
      setTaskId(null);
      setMainSourceId(null);
      setMainSectionId(null);
      setAdditionalSources([]);
      setSectionDoneEnabled(false);
      setReminderTaskIds([]);
      setReminderSectionOpen(false);
    }
    setConfirmOpen(false);
    setNewQueueDate('');
    setNewQueueTime('');
    setClearConfirm(false);
    setNewReminders([]);
    setPendingUnlinks([]);
    setPendingDeletes([]);
    setNewReminderTitle('');
    setNewReminderDate('');
    setNewReminderNotes('');
    setAddReminderOpen(false);
    setConfirmRemoverId(null);
  }, [open, existing]);

  // Resize summary textarea to fit pre-filled content when modal opens
  useEffect(() => {
    if (!open) return;
    const el = summaryRef.current;
    if (!el) return;
    setTimeout(() => {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }, 0);
  }, [open]);

  if (!open) return null;

  const handleCategoryChange = (newCat) => {
    setCategory(newCat);
    const base   = APPOINTMENT_TYPES[newCat] || [];
    const raw    = settings?.customApptTypes;
    const custom = Array.isArray(raw) ? raw : (raw?.[newCat] || []);
    if (![...base, ...custom].includes(type)) setType(base[0] || '');
    if (newCat !== 'lang') {
      setMainSourceId(null);
      setMainSectionId(null);
      setAdditionalSources([]);
    }
  };

  const handleMainSourceChange = (sourceId) => {
    setMainSourceId(sourceId || null);
    setMainSectionId(null);
  };

  const addCostEntry = () => setCosts(prev => [...prev, {
    id: uid(), label: 'Post', date: date || toDateStr(getLogicalToday(dsh)), amount: '', currency: 'KRW', notes: '',
  }]);
  const removeCostEntry = (idx) => setCosts(prev => prev.filter((_, i) => i !== idx));
  const updateCostEntry = (idx, patch) => setCosts(prev => prev.map((c, i) => i === idx ? { ...c, ...patch } : c));

  const addAdditionalSource    = () =>
    setAdditionalSources(prev => [...prev, { id: uid(), sourceId: null, sectionId: null, done: false }]);
  const removeAdditionalSource = (idx) =>
    setAdditionalSources(prev => prev.filter((_, i) => i !== idx));
  const updateAdditionalSource = (idx, patch) =>
    setAdditionalSources(prev => prev.map((a, i) => i === idx ? { ...a, ...patch } : a));

  const addToQueue = () => {
    if (!newQueueDate) return;
    setFollowUpQueue(prev =>
      [...prev, { date: newQueueDate, time: newQueueTime }]
        .sort((a, b) => a.date.localeCompare(b.date))
    );
    setNewQueueDate('');
    setNewQueueTime('');
  };

  const commitNewReminder = () => {
    if (!newReminderTitle.trim()) return;
    setNewReminders(prev => [...prev, {
      id: uid(), title: newReminderTitle.trim(),
      date: newReminderDate || null, notes: newReminderNotes.trim(),
    }]);
    setNewReminderTitle('');
    setNewReminderDate('');
    setNewReminderNotes('');
    setAddReminderOpen(false);
  };

  const handleSave = () => {
    if (!date.trim()) return;
    const apptId      = existing?.id || uid();
    const sortedQueue = [...followUpQueue].sort((a, b) => a.date.localeCompare(b.date));
    let finalTaskId   = taskId;
    if (!finalTaskId) {
      const newTaskId = uid();
      finalTaskId = newTaskId;
      updateData(prev => ({
        ...prev,
        tasks: [...prev.tasks, {
          id: newTaskId, title: `Appt: ${type}`, category,
          priority: 'med', date: date.trim() || null, time: time || null,
          recurrence: { type: 'none' }, notes: results.trim(),
          keepRecord: false,
          completed: false, persistent: false, push: false,
          activeToday: false, activatedOn: null,
          created: new Date().toISOString(),
          isAppointmentTask: true, appointmentId: apptId, apptProvider: provider.trim(),
        }],
      }));
    } else {
      // Rescheduling the appointment to a later date resurfaces its task as
      // open — the previous date's completion no longer applies.
      const rescheduledForward = !!existing?.date && !!date.trim() && date.trim() > existing.date;
      updateData(prev => ({
        ...prev,
        tasks: prev.tasks.map(t => t.id === finalTaskId ? {
          ...t, title: `Appt: ${type}`, date: date.trim() || null,
          time: time || null, category, apptProvider: provider.trim(), notes: results.trim(),
          ...(rescheduledForward ? { completed: false, completedAt: null } : {}),
        } : t),
      }));
    }
    // Process reminder changes
    const finalReminderIds = [
      ...(reminderTaskIds || []).filter(id => !pendingUnlinks.includes(id) && !pendingDeletes.includes(id)),
      ...newReminders.map(r => r.id),
    ];
    if (pendingUnlinks.length > 0 || newReminders.length > 0) {
      updateData(prev => {
        let ts = prev.tasks
          .filter(t => !pendingDeletes.includes(t.id))
          .map(t => pendingUnlinks.includes(t.id) ? { ...t, linkedApptId: null } : t);
        if (newReminders.length > 0) {
          ts = [...ts, ...newReminders.map(r => ({
            id: r.id, title: r.title, category,
            priority: 'high', date: r.date || null, time: null,
            recurrence: { type: 'none' }, notes: r.notes || '',
            keepRecord: false,
            completed: false, persistent: false, push: false,
            activeToday: false, activatedOn: null,
            created: new Date().toISOString(),
            isAppointmentTask: false, linkedApptId: apptId,
          }))];
        }
        return { ...prev, tasks: ts };
      });
    }
    pendingDeletes.forEach(id => onDeleteTask(id));

    onSave({
      id: apptId, date: date.trim(), time: time || '', type,
      provider: provider.trim(), category,
      summary: summary.trim(), results: results.trim(), outcome: outcome || null,
      followUpQueue: sortedQueue,
      cost: null, costCurrency: null,
      costs: costs.map(({ id, label, date: cDate, amount, currency: cur, notes }) => ({
        id, label, date: cDate, amount: parseFloat(amount) || 0, currency: cur, notes: notes || '',
      })),      taskId: finalTaskId,
      lastVisitDate: existing?.lastVisitDate || null,
      created: existing?.created || new Date().toISOString(),
      mainSourceId:  mainSourceId  || null,
      mainSectionId: mainSectionId || null,
      additionalSources: additionalSources.map(({ id, sourceId, sectionId, done }) => ({
        id, sourceId, sectionId: sectionId || null, done,
      })),
      reminderTaskIds: finalReminderIds,
    });
    onClose();
  };

  const isValid = !!date.trim();

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      playSound('mouse_click');
      handleSave();
    }
  };

  // Portaled to document.body — a `.fade-up` ancestor's persistent transform
  // would otherwise create a containing block that traps this fixed overlay
  // (the canonical portal pattern).
  return createPortal(
    <>
      <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={handleKeyDown}>
        <div style={{ ...S.modal, maxWidth: '540px' }} className="slide-up">

          <div style={S.modalHeader}>
            <span style={S.modalTitle}>{existing ? 'Edit Appointment' : 'Add Appointment'}</span>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '18px' }}>✕</button>
          </div>

          {/* Date + Time */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div style={S.formGroup}>
              <label style={S.formLabel}>Date</label>
              <DatePicker value={date} onChange={setDate} dsh={dsh} />
            </div>
            <div style={S.formGroup}>
              <label style={S.formLabel}>Time (optional)</label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} style={S.formInput} />
            </div>
          </div>

          {/* Category + Type */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            {CATEGORY_IDS.length > 1 && (
              <div style={S.formGroup}>
                <label style={S.formLabel}>Category</label>
                <select value={category} onChange={e => handleCategoryChange(e.target.value)} style={S.formSelect}>
                  {CATEGORY_IDS.map(id => <option key={id} value={id}>{CATEGORY_LABELS[id]}</option>)}
                </select>
              </div>
            )}
            <div style={S.formGroup}>
              <label style={S.formLabel}>Type</label>
              <select value={type} onChange={e => setType(e.target.value)} style={S.formSelect}>
                {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {/* Provider */}
          <div style={S.formGroup}>
            <label style={S.formLabel}>Provider (optional)</label>
            <input
              type="text"
              placeholder={PROVIDER_PLACEHOLDER[category] || 'e.g. Provider name'}
              value={provider}
              onChange={e => setProvider(e.target.value)}
              style={S.formInput}
            />
          </div>

          {/* ── Reminders ─────────────────────────────────────── */}
          <div style={S.formGroup}>
            <div
              onClick={() => setReminderSectionOpen(o => !o)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none', marginBottom: '6px' }}
            >
              <label style={{ ...S.formLabel, cursor: 'pointer', marginBottom: 0 }}>
                Reminders
                {(reminderTasks.length + newReminders.length) > 0 && (
                  <span style={{ fontSize: '10px', fontWeight: 400, color: C.textM, marginLeft: '6px' }}>
                    ({reminderTasks.length + newReminders.length})
                  </span>
                )}
              </label>
              <span style={{ fontSize: '10px', color: C.textM }}>{reminderSectionOpen ? '▲' : '▼'}</span>
            </div>

            {reminderSectionOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>

                {/* Existing linked reminder tasks */}
                {reminderTasks.map(task => (
                  <div key={task.id} style={{
                    display: 'flex', alignItems: 'flex-start', gap: '8px',
                    padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: '8px',
                  }}>
                    {confirmRemoverId === task.id ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '12px', color: C.textM }}>Remove this reminder?</span>
                        <button
                          onClick={() => { setPendingUnlinks(p => [...p, task.id]); setConfirmRemoverId(null); }}
                          style={{ fontSize: '11px', color: C.accent, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        >Unlink</button>
                        <button
                          onClick={() => { setPendingDeletes(p => [...p, task.id]); setConfirmRemoverId(null); }}
                          style={{ fontSize: '11px', color: C.danger || '#c0392b', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        >Delete</button>
                        <button
                          onClick={() => setConfirmRemoverId(null)}
                          style={{ fontSize: '11px', color: C.textM, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        >Cancel</button>
                      </div>
                    ) : (
                      <>
                        <div
                          onClick={() => onToggle(task.id)}
                          style={{
                            width: 15, height: 15, borderRadius: '3px', flexShrink: 0, marginTop: '1px',
                            border: task.completed ? 'none' : `1.5px solid ${C.borderB}`,
                            background: task.completed ? C.accent : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', transition: 'all 0.15s',
                          }}
                        >
                          {task.completed && (
                            <svg width="7" height="7" viewBox="0 0 8 8" fill="none">
                              <path d="M1 4l2 2.5 4-4.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: '13px', color: task.completed ? C.textM : C.text,
                            textDecoration: task.completed ? 'line-through' : 'none',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {task.title}
                          </div>
                          {task.date && (
                            <div style={{ fontSize: '10px', color: C.textM, fontFamily: SH.fm, marginTop: '2px' }}>
                              {task.date}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => setConfirmRemoverId(task.id)}
                          style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '16px', flexShrink: 0, lineHeight: 1, opacity: 0.5 }}
                        >×</button>
                      </>
                    )}
                  </div>
                ))}

                {/* Buffered new reminders — pending save */}
                {newReminders.map((r, idx) => (
                  <div key={r.id} style={{
                    display: 'flex', alignItems: 'flex-start', gap: '8px',
                    padding: '8px 10px', border: `1px dashed ${C.border}`, borderRadius: '8px',
                    opacity: 0.7,
                  }}>
                    <div style={{
                      width: 15, height: 15, borderRadius: '3px', flexShrink: 0, marginTop: '1px',
                      border: `1.5px dashed ${C.borderB}`,
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '13px', color: C.text, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.title}
                      </div>
                      {r.date && (
                        <div style={{ fontSize: '10px', color: C.textM, fontFamily: SH.fm, marginTop: '2px' }}>{r.date}</div>
                      )}
                    </div>
                    <button
                      onClick={() => setNewReminders(prev => prev.filter((_, i) => i !== idx))}
                      style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '16px', flexShrink: 0, lineHeight: 1, opacity: 0.5 }}
                    >×</button>
                  </div>
                ))}

                {/* Add reminder form */}
                {addReminderOpen ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: '8px' }}>
                    <input
                      autoFocus
                      placeholder="Reminder title"
                      value={newReminderTitle}
                      onChange={e => setNewReminderTitle(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Escape') { setAddReminderOpen(false); setNewReminderTitle(''); setNewReminderDate(''); setNewReminderNotes(''); }
                        if (e.key === 'Enter') { e.stopPropagation(); commitNewReminder(); }
                      }}
                      style={S.formInput}
                    />
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <DatePicker value={newReminderDate} onChange={setNewReminderDate} dsh={dsh} />
                      <input
                        placeholder="Notes (optional)"
                        value={newReminderNotes}
                        onChange={e => setNewReminderNotes(e.target.value)}
                        style={S.formInput}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={commitNewReminder}
                        disabled={!newReminderTitle.trim()}
                        style={{ ...S.btnPrimary, ...S.btnMetallic, fontSize: '12px', padding: '6px 14px', opacity: newReminderTitle.trim() ? 1 : 0.45 }}
                        className="btn-primary"
                      >
                        Add
                      </button>
                      <button
                        onClick={() => { setAddReminderOpen(false); setNewReminderTitle(''); setNewReminderDate(''); setNewReminderNotes(''); }}
                        style={S.btnGhost}
                        className="btn-ghost"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setAddReminderOpen(true)}
                    style={{ fontSize: '11px', color: C.accent, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}
                  >
                    + Add reminder
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Summary */}
          <div style={S.formGroup}>
            <label style={S.formLabel}>Summary</label>
            <textarea
              ref={summaryRef}
              placeholder="Reason, what was discussed…"
              value={summary}
              onChange={e => {
                setSummary(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = e.target.scrollHeight + 'px';
              }}
              rows={1}
              style={{ ...S.formInput, resize: 'none', overflow: 'hidden' }}
            />
          </div>

          {/* ── Sources (lang only, above Lesson Log) ──────────── */}
          {category === 'lang' && (
            <div style={S.formGroup}>
              <label style={S.formLabel}>
                Sources
                {(mainSourceId || additionalSources.length > 0) && (
                  <span style={{ fontSize: '10px', fontWeight: 400, color: C.textM, marginLeft: '6px' }}>
                    ({[mainSourceId, ...additionalSources.map(a => a.sourceId)].filter(Boolean).length} linked)
                  </span>
                )}
              </label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

                {/* Main source + section: 2-column */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span style={{ fontSize: '11px', color: C.textM, fontWeight: 500 }}>Main source</span>
                    <SourceSearchPicker
                      value={mainSourceId}
                      onChange={id => handleMainSourceChange(id || '')}
                      sources={sources || []}
                      placeholder="Search sources…"
                      C={C}
                      S={S}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span style={{ fontSize: '11px', color: C.textM, fontWeight: 500 }}>Section</span>
                    <SectionSelect
                      value={mainSectionId}
                      onChange={setMainSectionId}
                      allSections={mainSourceSections}
                      style={{ ...S.formSelect, opacity: mainSourceId ? 1 : 0.4 }}
                    />
                  </div>
                </div>

                {/* Section done checkbox */}
                {sectionDoneEnabled && mainSourceId && mainSectionId && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      id="main-section-done"
                      checked={mainSectionAlreadyDone}
                      disabled={mainSectionAlreadyDone}
                      onChange={() => {
                        if (!mainSectionAlreadyDone && onSectionComplete)
                          onSectionComplete(mainSectionId, mainSourceId, existing?.id);
                      }}
                      style={{ width: 14, height: 14, accentColor: C.accent, cursor: mainSectionAlreadyDone ? 'default' : 'pointer' }}
                    />
                    <label
                      htmlFor="main-section-done"
                      style={{
                        fontSize: '12px', cursor: mainSectionAlreadyDone ? 'default' : 'pointer',
                        color: mainSectionAlreadyDone ? C.accent : C.textM,
                        fontWeight: mainSectionAlreadyDone ? 500 : 400,
                      }}
                    >
                      {mainSectionAlreadyDone ? 'Section complete' : 'Mark section complete'}
                    </label>
                  </div>
                )}

                {/* Additional sources */}
                {additionalSources.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <span style={{ fontSize: '11px', color: C.textM, fontWeight: 500 }}>Additional sources</span>
                    {additionalSources.map((entry, idx) => {
                      const entrySecs = entry.sourceId
                        ? getOrderedSectionsForSource(sections || [], sources || [], entry.sourceId)
                        : [];
                      return (
                        <div key={entry.id} style={{
                          display: 'flex', flexDirection: 'column', gap: '6px',
                          padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: '8px',
                        }}>
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <SourceSearchPicker
                                value={entry.sourceId || null}
                                onChange={id => updateAdditionalSource(idx, { sourceId: id || null, sectionId: null })}
                                sources={sources || []}
                                placeholder="Search sources…"
                                C={C}
                                S={S}
                              />
                            </div>
                            <button
                              onClick={() => removeAdditionalSource(idx)}
                              style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '18px', flexShrink: 0, lineHeight: 1 }}
                            >×</button>
                          </div>
                          {entry.sourceId && (
                            <SectionSelect
                              value={entry.sectionId}
                              onChange={val => updateAdditionalSource(idx, { sectionId: val })}
                              allSections={entrySecs}
                              style={S.formSelect}
                            />
                          )}
                          {sectionDoneEnabled && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <input
                                type="checkbox"
                                checked={entry.done}
                                disabled={entry.done}
                                onChange={() => { if (!entry.done) updateAdditionalSource(idx, { done: true }); }}
                                style={{ width: 14, height: 14, accentColor: C.accent, cursor: entry.done ? 'default' : 'pointer' }}
                              />
                              <span style={{ fontSize: '12px', color: entry.done ? C.accent : C.textM, fontWeight: entry.done ? 500 : 400 }}>
                                {entry.done ? 'Section complete' : 'Mark section complete'}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <button
                  onClick={addAdditionalSource}
                  style={{ fontSize: '11px', color: C.accent, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}
                >
                  + Add additional source
                </button>
              </div>
            </div>
          )}

          {/* Lesson Log / Results / Notes */}
          <div style={S.formGroup}>
            <label style={S.formLabel}>{isLessonType ? 'Lesson Log' : 'Results / Notes'}</label>
            <textarea
              placeholder={isLessonType
                ? 'Lesson content, topics covered, homework…'
                : 'Details, next steps…'}
              value={results}
              onChange={e => setResults(e.target.value)}
              rows={9}
              style={{ ...S.formInput, resize: 'vertical' }}
            />
          </div>

          {/* Follow-up Queue */}
          <div style={S.formGroup}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <label style={{ ...S.formLabel, marginBottom: 0 }}>
                Follow-up Queue
                {followUpQueue.length > 0 && (
                  <span style={{ fontSize: '10px', color: C.textM, fontWeight: 400, marginLeft: '6px' }}>
                    ({followUpQueue.length} scheduled)
                  </span>
                )}
              </label>
              {followUpQueue.length > 1 && (
                clearConfirm ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '11px', color: C.textM }}>Clear all?</span>
                    <button onClick={() => { setFollowUpQueue([]); setClearConfirm(false); }} style={{ fontSize: '11px', color: C.danger || '#c0392b', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Yes</button>
                    <button onClick={() => setClearConfirm(false)} style={{ fontSize: '11px', color: C.textM, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setClearConfirm(true)} style={{ fontSize: '11px', color: C.textM, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Clear all</button>
                )
              )}
            </div>
            {followUpQueue.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
                {followUpQueue.map((item, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ flex: 1, padding: '6px 10px', borderRadius: '8px', border: `1px solid ${C.border}`, background: C.surface, fontSize: '12px', color: C.text, fontFamily: SH.fm }}>
                      {fmtApptDate(item.date)}{item.time ? ` · ${fmtTime(item.time)}` : ''}
                    </div>
                    <button onClick={() => setFollowUpQueue(prev => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textM, fontSize: '16px', padding: '0 4px', lineHeight: 1 }}>×</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '8px', alignItems: 'flex-end' }}>
              <div>
                <label style={{ ...S.formLabel, fontSize: '10px', marginBottom: '3px' }}>Date</label>
                <DatePicker value={newQueueDate} onChange={setNewQueueDate} dsh={dsh} />
              </div>
              <div>
                <label style={{ ...S.formLabel, fontSize: '10px', marginBottom: '3px' }}>Time (optional)</label>
                <input type="time" value={newQueueTime} onChange={e => setNewQueueTime(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); addToQueue(); } }} style={S.formInput} />
              </div>
              <button onClick={addToQueue} disabled={!newQueueDate} style={{ ...S.btnGhost, padding: '8px 12px', fontSize: '12px', opacity: newQueueDate ? 1 : 0.4 }} className="btn-ghost">Add</button>
            </div>
          </div>

          {/* Cost records */}
          <div style={S.formGroup}>
            <div
              onClick={() => setCostsSectionOpen(o => !o)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none', marginBottom: '6px' }}
            >
              <label style={{ ...S.formLabel, cursor: 'pointer', marginBottom: 0 }}>
                Costs
                {costs.length > 0 && (
                  <span style={{ fontSize: '10px', fontWeight: 400, color: C.textM, marginLeft: '6px' }}>
                    ({costs.length} {costs.length === 1 ? 'entry' : 'entries'})
                  </span>
                )}
              </label>
              <span style={{ fontSize: '10px', color: C.textM }}>{costsSectionOpen ? '▲' : '▼'}</span>
            </div>

            {costsSectionOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {costs.map((entry, idx) => (
                  <div key={entry.id} style={{
                    display: 'flex', flexDirection: 'column', gap: '8px',
                    padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: '8px',
                  }}>
                    {/* Row 1: Label + Date + remove */}
                    <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr auto', gap: '8px', alignItems: 'center' }}>
                      <select
                        value={entry.label}
                        onChange={e => updateCostEntry(idx, { label: e.target.value })}
                        style={S.formSelect}
                      >
                        <option value="Pre">Pre</option>
                        <option value="Post">Post</option>
                        <option value="Other">Other</option>
                      </select>
                      <DatePicker value={entry.date} onChange={val => updateCostEntry(idx, { date: val })} dsh={dsh} />
                      <button
                        onClick={() => removeCostEntry(idx)}
                        style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}
                      >×</button>
                    </div>
                    {/* Row 2: Amount + Currency */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: '8px' }}>
                      <input
                        type="number"
                        min="0"
                        step="100"
                        placeholder="0"
                        value={entry.amount}
                        onChange={e => updateCostEntry(idx, { amount: e.target.value })}
                        style={S.formInput}
                      />
                      <select
                        value={entry.currency}
                        onChange={e => updateCostEntry(idx, { currency: e.target.value })}
                        style={S.formSelect}
                      >
                        {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    {/* Row 3: Notes */}
                    <input
                      type="text"
                      placeholder="Notes (optional)"
                      value={entry.notes}
                      onChange={e => updateCostEntry(idx, { notes: e.target.value })}
                      style={S.formInput}
                    />
                  </div>
                ))}
                <button
                  onClick={addCostEntry}
                  style={{ fontSize: '11px', color: C.accent, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}
                >
                  + Add cost entry
                </button>
              </div>
            )}
          </div>

          {/* Notes / Corrections — existing appointments only */}
          {existing && (onNavigateToNote || onNavigateToNewNote) && (
            <div style={S.formGroup}>
              <div
                onClick={() => setNotesOpen(o => !o)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none', marginBottom: '6px' }}
              >
                <label style={{ ...S.formLabel, cursor: 'pointer', marginBottom: 0 }}>
                  Notes / Corrections
                  {(linkedNotes || []).length > 0 && (
                    <span style={{ fontSize: '10px', fontWeight: 400, color: C.textM, marginLeft: '6px' }}>({(linkedNotes || []).length})</span>
                  )}
                </label>
                <span style={{ fontSize: '10px', color: C.textM }}>{notesOpen ? '▲' : '▼'}</span>
              </div>
              {notesOpen && (
                <div>
                  {(linkedNotes || []).length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '10px' }}>
                      {(linkedNotes || []).map(n => (
                        <span
                          key={n.id}
                          onClick={() => n.type === 'correction' ? onNavigateToCorrection?.(n.id) : onNavigateToNote?.(n.id)}
                          style={{
                            padding: '2px 9px', borderRadius: '12px', fontSize: '11px', cursor: 'pointer',
                            border: `1px solid ${C.border}`, color: C.text, background: C.bg,
                            display: 'inline-flex', alignItems: 'center', gap: '5px',
                          }}
                        >
                          {n.type === 'correction' && (
                            <span style={{ fontSize: '9px', fontWeight: 700, color: C.textM, letterSpacing: '0.05em', textTransform: 'uppercase' }}>corr</span>
                          )}
                          {n.title || 'Untitled'}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', marginBottom: '10px' }}>No notes or corrections linked yet.</div>
                  )}
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => { handleSave(); onNavigateToNewNote?.(existing.id); }}
                      style={{ fontSize: '11px', padding: '3px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}
                    >+ Note</button>
                    <button
                      onClick={() => { handleSave(); onNavigateToNewCorrection?.(existing.id); }}
                      style={{ fontSize: '11px', padding: '3px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}
                    >+ Correction</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div style={{ ...S.formActions, justifyContent: 'space-between' }}>
            <div>
              {existing && (
                <button onClick={() => setConfirmOpen(true)} style={{ ...S.btnDanger, padding: '7px 14px', fontSize: '12px' }}>Delete</button>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={onClose} style={S.btnGhost} className="btn-ghost">Cancel</button>
              <button onClick={() => { playSound('mouse_click'); handleSave(); }} disabled={!isValid} style={{ ...S.btnPrimary, ...S.btnMetallic, opacity: isValid ? 1 : 0.45 }} className="btn-primary">Save</button>
            </div>
          </div>
        </div>
      </div>

      {confirmOpen && (
        <DeleteConfirm
          label={existing ? `${existing.type}${existing.provider ? ` — ${existing.provider}` : ''}` : ''}
          hasLinkedTask={!!existing?.taskId}
          onConfirm={() => { onDelete(existing.id); onClose(); }}
          onCancel={() => setConfirmOpen(false)}
          C={C} S={S}
        />
      )}
    </>,
    document.body
  );
}
