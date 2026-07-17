// src/pages/AppointmentsPage.jsx
// Full-page appointments view.
// Layout: 2/3 content left, 1/3 spacer right (image rendered at App level).
// core list, search/filter, add/edit modal, source + section linking, 
// cost records, reminder tasks

import { useState, useMemo, useEffect, useRef } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { toDateStr, getLogicalToday } from '../utils/dateUtils.js';
import { Icons } from '../components/Icons.jsx';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db, auth } from '../firebase.js';import {
  AppointmentModal,
  catColor, fmtApptDate, fmtTime, CATEGORY_LABELS,
} from '../components/AppointmentModal.jsx';

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

// ── AppointmentRow ────────────────────────────────────────────

export function AppointmentRow({ appt, isUpcoming, isDualStatus, sources, noteCount, onClick, C, S }) {

  const displayDate    = (!isUpcoming && isDualStatus && appt.lastVisitDate) ? appt.lastVisitDate : appt.date;
  const formattedDate  = fmtApptDate(displayDate);
  const isAlsoUpcoming = !isUpcoming && isDualStatus;
  const col            = catColor(appt.category || 'lang', C);

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: '12px',
        padding: '13px 16px',
        borderBottom: `1px solid ${C.border}`,
        borderLeft: isUpcoming ? `3px solid ${C.accent}` : '3px solid transparent',
        cursor: 'pointer',
        transition: 'background 0.15s',
        background: 'transparent',
        overflow: 'hidden',
      }}
      className="task-row"
    >
      {/* Date column */}
      <div style={{
        flexShrink: 0, width: '88px',
        fontSize: '11px', fontFamily: SH.fm,
        color: isUpcoming ? C.accent : C.textM,
        paddingTop: '1px',
      }}>
        {formattedDate}
        {isUpcoming && (
          <div style={{ fontSize: '10px', color: C.accent, fontWeight: 500, marginTop: '2px' }}>
            Upcoming
          </div>
        )}
        {isAlsoUpcoming && (
          <div style={{ fontSize: '10px', color: C.accent, fontWeight: 500, marginTop: '2px' }}>
            Next: {fmtApptDate(appt.date)}
          </div>
        )}
      </div>

      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '13.5px', color: C.text, fontWeight: 500, marginBottom: '3px' }}>
          {appt.provider || appt.type}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* Type badge — colored by appointment category */}
          <span style={{
            fontSize: '10px', fontWeight: 500, padding: '2px 7px',
            borderRadius: '10px', letterSpacing: '0.04em', textTransform: 'uppercase',
            color: col, background: `${col}22`,
          }}>
            {appt.type}
          </span>

          {/* Category badge — always shown, muted style for visual hierarchy */}
          <span style={{
            fontSize: '10px', padding: '2px 7px', borderRadius: '10px',
            color: C.textM, background: C.raised, border: `1px solid ${C.border}`,
          }}>
            {CATEGORY_LABELS[appt.category || 'lang'] || appt.category}
          </span>

          {/* Time */}
          {appt.time && (
            <span style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm }}>
              {fmtTime(appt.time)}
            </span>
          )}

          {/* Cost — most recent entry */}
          {(() => {
            const arr = (appt.costs || []).filter(c => c.amount > 0);
            const legacy = !arr.length && appt.cost != null;
            if (!arr.length && !legacy) return null;
            const entry = legacy
              ? { amount: appt.cost, currency: appt.costCurrency || 'KRW' }
              : [...arr].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
            const sym = entry.currency === 'KRW' ? '₩' : entry.currency === 'USD' ? '$' : '€';
            return (
              <span style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm }}>
                {sym}{Number(entry.amount).toLocaleString()}
                {arr.length > 1 && (
                  <span style={{ marginLeft: '3px', opacity: 0.6 }}>+{arr.length - 1}</span>
                )}
              </span>
            );
          })()}

          {/* Main source */}
          {appt.mainSourceId && (() => {
            const src = (sources || []).find(s => s.id === appt.mainSourceId);
            return src ? (
              <span style={{ fontSize: '10px', color: C.textM, display: 'flex', alignItems: 'center', gap: '3px' }}>
                {Icons.bookClosed} {src.title}
              </span>
            ) : null;
          })()}

          {/* Linked notes/corrections count */}
          {noteCount > 0 && (
            <span style={{ fontSize: '10px', color: C.textM, display: 'flex', alignItems: 'center', gap: '3px' }}>
              {Icons.note} {noteCount}
            </span>
          )}

          {/* Follow-up queue count */}
          {isUpcoming && (appt.followUpQueue || []).length > 0 && (
            <span style={{ fontSize: '10px', color: C.textM }}>
              +{appt.followUpQueue.length} follow-up{appt.followUpQueue.length > 1 ? 's' : ''} queued
            </span>
          )}
        </div>

        {/* Summary preview */}
        {appt.summary && (
          <div style={{
            fontSize: '11px', color: C.textM, marginTop: '4px',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {appt.summary}
          </div>
        )}
      </div>
    </div>
  );
}

// ── AppointmentsPage ──────────────────────────────────────────

export function AppointmentsPage({
  appointments, saveAppointment, deleteAppointment,
  dsh, settings, updateData,
  aviSources, aviSections, onSectionComplete,
  tasks, onToggle, onDeleteTask,
  onNavigateToNote, onNavigateToCorrection,
  onNavigateToNewNote, onNavigateToNewCorrection,
}) {
  const { C, S } = useAppTheme();
  const [modalOpen,  setModalOpen]  = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [linkedNotes, setLinkedNotes] = useState([]);
  const linkedNotesUnsub = useRef(null);

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    linkedNotesUnsub.current?.();
    linkedNotesUnsub.current = onSnapshot(
      query(collection(db, 'users', uid, 'notes'), where('linkedApptId', '!=', null)),
      snap => setLinkedNotes(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    return () => linkedNotesUnsub.current?.();
  }, []);

  const noteCountByAppt = useMemo(() => {
    const map = {};
    linkedNotes.forEach(n => { if (n.linkedApptId) map[n.linkedApptId] = (map[n.linkedApptId] || 0) + 1; });
    return map;
  }, [linkedNotes]);

  const [searchKeyword,  setSearchKeyword]  = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterType,     setFilterType]     = useState('');
  const [filterProvider, setFilterProvider] = useState('');

  const today = toDateStr(getLogicalToday(dsh || 3));

  // Sources available in the picker — Tutor type excluded (lives in Appointments natively)
  const pickerSources = useMemo(() =>
    (aviSources || []).filter(s => s.type !== 'Tutor'),
  [aviSources]);

  // Filter dropdown options derived from actual appointment data
  const typeOptions = useMemo(() =>
    [...new Set((appointments || []).map(a => a.type).filter(Boolean))].sort(),
  [appointments]);

  const providerOptions = useMemo(() =>
    [...new Set((appointments || []).map(a => a.provider).filter(Boolean))].sort(),
  [appointments]);

  const categoryOptions = useMemo(() =>
    [...new Set((appointments || []).map(a => a.category || 'lang'))].sort(),
  [appointments]);

  // Split into upcoming and past
  const { upcoming, past, upcomingIds } = useMemo(() => {
    const all = appointments || [];

    const up = all
      .filter(a => a.date && a.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));

    const upIds = new Set(up.map(a => a.id));

    const ps = all
      .filter(a => (a.date && a.date < today) || !!a.lastVisitDate)
      .sort((a, b) => {
        const da = a.lastVisitDate ?? a.date ?? '';
        const db = b.lastVisitDate ?? b.date ?? '';
        return db.localeCompare(da);
      });

    return { upcoming: up, past: ps, upcomingIds: upIds };
  }, [appointments, today]);

  const matchesFilters = (appt) => {
    if (filterCategory && (appt.category || 'lang') !== filterCategory) return false;
    if (filterType     && appt.type !== filterType)                        return false;
    if (filterProvider && (appt.provider || '') !== filterProvider)         return false;
    if (searchKeyword) {
      const kw = searchKeyword.toLowerCase();
      if (
        !(appt.summary || '').toLowerCase().includes(kw) &&
        !(appt.results || '').toLowerCase().includes(kw)
      ) return false;
    }
    return true;
  };

  const filteredUpcoming = upcoming.filter(matchesFilters);
  const filteredPast     = past.filter(matchesFilters);
  const hasActiveFilters = !!(searchKeyword || filterCategory || filterType || filterProvider);
  const noResults        = hasActiveFilters && filteredUpcoming.length === 0 && filteredPast.length === 0;
  const totalCount       = (appointments || []).length;

  const openAdd  = () => { setEditTarget(null); setModalOpen(true); };
  const openEdit = (a) => { setEditTarget(a);   setModalOpen(true); };
  const clearFilters = () => {
    setSearchKeyword('');
    setFilterCategory('');
    setFilterType('');
    setFilterProvider('');
  };

  return (
    <>
      <div className="fade-up" style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr',
        gap: '24px',
        alignItems: 'start',
      }}>

        {/* LEFT — appointment list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', minWidth: 0 }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: '12px', color: C.textM }}>
              {upcoming.length > 0
                ? `${upcoming.length} upcoming · ${past.length} past`
                : `${totalCount} appointment${totalCount !== 1 ? 's' : ''} recorded`}
            </div>
            <button
              onClick={openAdd}
              style={{ ...S.btnPrimary, ...S.btnMetallic, padding: '6px 14px', fontSize: '12px' }}
              className="btn-primary"
            >
              + Add
            </button>
          </div>

          {/* Search + filters */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <input
              type="text"
              placeholder="Search summary and notes…"
              value={searchKeyword}
              onChange={e => setSearchKeyword(e.target.value)}
              style={{ ...S.formInput, fontSize: '13px' }}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
              <select
                value={filterCategory}
                onChange={e => setFilterCategory(e.target.value)}
                style={{ ...S.formSelect, fontSize: '12px' }}
              >
                <option value="">All Categories</option>
                {categoryOptions.map(c => (
                  <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>
                ))}
              </select>
              <select
                value={filterType}
                onChange={e => setFilterType(e.target.value)}
                style={{ ...S.formSelect, fontSize: '12px' }}
              >
                <option value="">All Types</option>
                {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <select
                value={filterProvider}
                onChange={e => setFilterProvider(e.target.value)}
                style={{ ...S.formSelect, fontSize: '12px' }}
              >
                <option value="">All Providers</option>
                {providerOptions.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                style={{
                  fontSize: '11px', color: C.textM, background: 'none', border: 'none',
                  cursor: 'pointer', padding: 0, alignSelf: 'flex-start', textDecoration: 'underline',
                }}
              >
                Clear filters
              </button>
            )}
          </div>

          {/* Upcoming */}
          {filteredUpcoming.length > 0 && (
            <div>
              <div style={{
                fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: C.accent, marginBottom: '8px',
              }}>
                Upcoming
              </div>
              <div style={S.card}>
                {filteredUpcoming.map(a => (
                  <AppointmentRow
                    key={a.id}
                    appt={a}
                    isUpcoming={true}
                    isDualStatus={false}
                    sources={aviSources || []}
                    noteCount={noteCountByAppt[a.id] || 0}
                    onClick={() => openEdit(a)}
                    C={C}
                    S={S}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Past */}
          {filteredPast.length > 0 && (
            <div>
              <div style={{
                fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: C.textM, marginBottom: '8px',
              }}>
                Past
              </div>
              <div style={S.card}>
                {filteredPast.map(a => (
                  <AppointmentRow
                    key={`past-${a.id}`}
                    appt={a}
                    isUpcoming={false}
                    isDualStatus={upcomingIds.has(a.id)}
                    sources={aviSources || []}
                    noteCount={noteCountByAppt[a.id] || 0}
                    onClick={() => openEdit(a)}
                    C={C}
                    S={S}
                  />
                ))}
              </div>
            </div>
          )}

          {/* No results after filtering */}
          {noResults && (
            <div style={{ ...S.emptyState, fontSize: '13px', color: C.textM }}>
              No appointments match your search.
            </div>
          )}

          {/* Empty state */}
          {totalCount === 0 && (
            <div style={S.emptyState}>
              No appointments recorded yet.
            </div>
          )}

        </div>

        {/* RIGHT — invisible spacer so the grid reserves space for the fixed image */}
        {!isMobile && <div style={{ visibility: 'hidden', pointerEvents: 'none' }} aria-hidden="true" />}

      </div>

      {/* Modal rendered outside the grid to avoid layout constraints */}
      <AppointmentModal
        open={modalOpen}
        existing={editTarget}
        onSave={saveAppointment}
        onDelete={deleteAppointment}
        onClose={() => { setModalOpen(false); setEditTarget(null); }}
        updateData={updateData}
        settings={settings}
        sources={pickerSources}
        sections={aviSections || []}
        onSectionComplete={onSectionComplete}
        tasks={tasks}
        onToggle={onToggle}
        onDeleteTask={onDeleteTask}
        linkedNotes={editTarget ? linkedNotes.filter(n => n.linkedApptId === editTarget.id) : []}
        onNavigateToNote={onNavigateToNote}
        onNavigateToCorrection={onNavigateToCorrection}
        onNavigateToNewNote={onNavigateToNewNote}
        onNavigateToNewCorrection={onNavigateToNewCorrection}
      />
    </>
  );
}
