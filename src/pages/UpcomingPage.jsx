import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { isPassiveMediaExcluded } from '../utils/contentUtils.js';
import { TaskItem } from '../components/TaskItem.jsx';
import { parseDate, isThisWeek, fmtDate, getLogicalToday, toDateStr, getTaskDates, isDateDone } from '../utils/dateUtils.js';
import { SH, frameBevel, frameBevelFilled } from '../theme/buildStyles.js';
import { useDragSort } from '../hooks/useDragSort.js';
import { taskSortComparator } from '../utils/dragSort.js';
import { getNextOccurrence } from '../utils/recurrenceEngine.js';
import { CATEGORIES } from '../constants.js';

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

// ── Day detail popup (Phase E2 follow-up, mobile only) ──
// On mobile, MonthCalendar and Planner (unarmed) cells show tasks as
// priority dots rather than titles. Tapping a day opens this popup with the
// full list for that date. Portaled to document.body above the mobile nav
// tray (scrim 1500 / panel 1501), B-1 frame language. Tapping a row closes
// the popup and opens that task's edit modal (navigation wins). Virtual /
// projected occurrences are shown but not editable.
function DayDetailPopup({ dateStr, tasks, C, S, onClose, onEditTask }) {
  if (!dateStr) return null;
  const headDate = parseDate(dateStr);
  const headLabel = headDate
    ? headDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : dateStr;
  return createPortal(
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(0,0,0,0.35)', overscrollBehavior: 'contain', touchAction: 'none' }}
      />
      <div style={{
        position: 'fixed', bottom: '56px', left: '10px', right: '10px', zIndex: 1501,
        maxHeight: '60vh', display: 'flex', flexDirection: 'column',
        background: 'transparent', backgroundClip: 'padding-box',
        border: '8px solid transparent', borderRadius: 0,
        borderImageSource: frameBevelFilled(C.borderB, C.cardBg || C.surface),
        borderImageSlice: '6 fill', borderImageWidth: '8px', borderImageRepeat: 'stretch',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px 10px' }}>
          <span style={{ fontFamily: SH.fp, fontSize: '12px', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.textS }}>{headLabel}</span>
          <span onClick={onClose} style={{ fontFamily: SH.fp, fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', color: C.textM, cursor: 'pointer', padding: '2px 6px' }}>Close</span>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {tasks.length === 0 ? (
            <div style={{ padding: '14px 8px', fontStyle: 'italic', fontSize: '12px', color: C.textM }}>Nothing scheduled.</div>
          ) : tasks.map((t, idx) => {
            const editable = !t._virtual;
            const catLabel = CATEGORIES.find(c => c.id === t.category)?.label || t.category;
            return (
              <div
                key={`${t.id}-${idx}`}
                onClick={() => { if (editable) { onClose(); onEditTask(t); } }}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: '8px',
                  padding: '11px 8px', borderTop: idx === 0 ? 'none' : `1px solid ${C.border}`,
                  cursor: editable ? 'pointer' : 'default', opacity: t._virtual ? 0.6 : 1,
                }}
              >
                <span style={{ marginTop: '3px' }}><PriDot priority={t.priority} C={C} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', color: t._virtual ? C.textS : C.text, lineHeight: 1.35 }}>{t.title}</div>
                  <div style={{ marginTop: '3px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontFamily: SH.fp, fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM }}>{catLabel}</span>
                    {t._virtual && <span style={{ fontFamily: SH.fm, fontSize: '10px', color: C.textM }}>{t._followUp ? 'follow-up' : 'recurring'}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>,
    document.body
  );
}

// ── Projection generator ──────────────────────────────────────────────────────
// Generates ONLY virtual future projections beyond the task's real current date.
// The real occurrence is always handled separately as the actual task object.
function generateProjections(task, afterDate, endDate) {
  if (!task.recurrence || task.recurrence.type === 'none') return [];
  const results = [];
  let cursor = afterDate; // start generating from this date (exclusive)
  let iterations = 0;

  while (iterations < 60) {
    iterations++;
    const next = getNextOccurrence(task, cursor);
    const nextDate = parseDate(next);
    if (!nextDate || nextDate <= cursor) break;
    if (nextDate > endDate) break;
    results.push({
      date: next,
      task: { ...task, date: next, completed: false, _virtual: true },
    });
    cursor = nextDate;
  }

  return results;
}

// ── Priority dot ──────────────────────────────────────────────────────────────
function PriDot({ priority, C }) {
  const bg = priority === 'high' ? C.danger : priority === 'med' ? C.warning : C.textM;
  return (
    <span style={{
      display: 'inline-block', width: '5px', height: '5px',
      borderRadius: '50%', background: bg,
      opacity: priority === 'low' ? 0.4 : 1,
      flexShrink: 0, marginRight: '4px', verticalAlign: 'middle',
    }} />
  );
}

// ── Month calendar ────────────────────────────────────────────────────────────
function MonthCalendar({ tasks, dsh, C, S, onEdit }) {
  const [dayDetail, setDayDetail] = useState(null);
  const today    = getLogicalToday(dsh);
  const todayStr = toDateStr(today);

  const [viewYear,  setViewYear]  = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const isCurrentMonth = viewYear === today.getFullYear() && viewMonth === today.getMonth();

  const goNextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };
  const goPrevMonth = () => {
    if (isCurrentMonth) return;
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };

  const monthName = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric',
  });

  const tasksByDate = useMemo(() => {
    const monthStart = new Date(viewYear, viewMonth, 1);
    const monthEnd   = new Date(viewYear, viewMonth + 1, 0);
    const map = {};

    const add = (dateStr, taskObj) => {
      if (!map[dateStr]) map[dateStr] = [];
      // Deduplicate by id+date
      if (!map[dateStr].some(t => t.id === taskObj.id && t.date === dateStr)) {
        map[dateStr].push(taskObj);
      }
    };

    tasks.forEach(t => {
      if (t.persistent) return;

      if (t.recurrence && t.recurrence.type !== 'none') {
        // Determine the anchor for the real current occurrence
        if (t.completed) {
          // Done today: real occurrence is today (handled by Today page).
          // Show projections from nextDue onward.
          const anchor = t.recurrence.nextDue
            ? parseDate(t.recurrence.nextDue)
            : parseDate(t.date);
          if (!anchor) return;
          // If nextDue itself is within the month, add it as virtual
          // (it becomes real once the engine runs and advances date)
          const projs = generateProjections(
            t,
            new Date(anchor.getTime() - 86400000), // one day before anchor so anchor is included
            monthEnd
          );
          // Actually include anchor itself if in month
          if (anchor >= monthStart && anchor <= monthEnd) {
            const anchorStr = toDateStr(anchor);
            add(anchorStr, { ...t, date: anchorStr, completed: false, _virtual: true });
          }
          // Add projections beyond anchor
          projs.forEach(({ date, task }) => {
            if (parseDate(date) > anchor) add(date, task);
          });
        } else {
          const realDate = parseDate(t.date);
          if (!realDate) return;
          // Real occurrence: add as actual task if within month
          if (realDate >= monthStart && realDate <= monthEnd) {
            add(toDateStr(realDate), t);
          }
          // Virtual projections beyond the real date
          generateProjections(t, realDate, monthEnd)
            .forEach(({ date, task }) => add(date, task));
        }
      } else {
        // Non-recurring: show on every due date within the month that isn't done
        if (!t.completed) {
          const taskDates = getTaskDates(t);
          taskDates.forEach(ds => {
            if (isDateDone(t, ds)) return;
            const d = parseDate(ds);
            if (d && d.getFullYear() === viewYear && d.getMonth() === viewMonth) {
              add(ds, taskDates.length > 1 ? { ...t, date: ds, _dateOcc: true } : t);
            }
          });
        }
      }
    });

    return map;
  }, [tasks, viewYear, viewMonth]);

  const firstDay    = new Date(viewYear, viewMonth, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px' }}>
        <button
          onClick={goPrevMonth}
          disabled={isCurrentMonth}
          style={{
            background: 'none', border: 'none',
            cursor: isCurrentMonth ? 'default' : 'pointer',
            color: isCurrentMonth ? C.border : C.textM,
            fontSize: '16px', lineHeight: 1, padding: '2px 6px', borderRadius: '4px',
          }}
        >&#8249;</button>
        <div style={{
          flex: 1, textAlign: 'center', fontFamily: SH.fd, fontSize: '17px',
          color: C.textS,
        }}>
          {monthName}
        </div>
        <button
          onClick={goNextMonth}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: C.textM, fontSize: '16px', lineHeight: 1,
            padding: '2px 6px', borderRadius: '4px',
          }}
        >&#8250;</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '4px' }}>
        {WEEKDAYS.map(d => (
          <div key={d} style={{
            textAlign: 'center', fontSize: '10px', fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: C.textM, padding: '4px 0',
          }}>{d}</div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>
        {cells.map((day, i) => {
          if (!day) return <div key={`e-${i}`} style={{ minHeight: '60px' }} />;
          const dateStr  = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const dayTasks = tasksByDate[dateStr] || [];
          const isToday  = dateStr === todayStr;
          const isPast   = new Date(viewYear, viewMonth, day) < today;

          return (
          <div key={dateStr}
            onClick={isMobile ? () => setDayDetail(dateStr) : undefined}
            style={{
              minHeight: '60px',
              background: isToday ? C.accentSoft : (C.cardBg || C.raised),
              backgroundClip: 'padding-box',
              border: '4px solid transparent', borderRadius: 0,
              borderImageSource: frameBevel(isToday ? C.accent : C.border),
              borderImageSlice: 6, borderImageWidth: '5px', borderImageRepeat: 'stretch',
              padding: '1px 2px',
              opacity: isPast ? 0.6 : 1,
              overflow: 'hidden',
              minWidth: 0,
              cursor: isMobile ? 'pointer' : 'default',
            }}>
              <div style={{
                fontSize: '10px', fontFamily: SH.fm, fontWeight: 600,
                color: isToday ? C.accent : C.textM,
                marginBottom: dayTasks.length ? '4px' : 0, lineHeight: 1,
              }}>{day}</div>
              {isMobile ? (dayTasks.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', rowGap: '3px', padding: '1px 0' }}>
                  {dayTasks.map((t, idx) => (
                    <span key={`${t.id}-${idx}`} style={{ display: 'flex', opacity: t._virtual ? 0.5 : 1 }}>
                      <PriDot priority={t.priority} C={C} />
                    </span>
                  ))}
                </div>
              )) : dayTasks.map((t, idx) => (
                <div
                  key={`${t.id}-${idx}`}
                  onClick={() => !t._virtual && onEdit(t)}
                  title={t.title}
                  style={{
                    display: 'flex', alignItems: 'center',
                    fontSize: '9.5px', lineHeight: 1.35,
                    color: t._virtual ? C.textM : C.textS,
                    cursor: t._virtual ? 'default' : 'pointer',
                    marginBottom: '2px',
                    opacity: t._virtual ? 0.7 : 1,
                  }}
                >
                  <PriDot priority={t.priority} C={C} />
                  <span style={{ overflow: 'hidden', wordBreak: 'break-word', lineHeight: 1.3 }}>
                    {t.title}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {isMobile && dayDetail && (
        <DayDetailPopup dateStr={dayDetail} tasks={tasksByDate[dayDetail] || []} C={C} S={S} onClose={() => setDayDetail(null)} onEditTask={onEdit} />
      )}
    </div>
  );
}

// ── This Week view ────────────────────────────────────────────────────────────
// ── Planner (Phase F2, Stage 1) ───────────────────────────────
// Scheduling workspace: a To Schedule pool of Content Library sources and
// sections above a read-only month calendar of committed tasks. Placement
// drafting arrives in Stage 2; Save commit in Stage 3.
function PlannerView({ tasks, clSources, clSections, dsh, C, S, onEdit, onDirtyChange, onPlannerCommit }) {
  const [poolSourceIds, setPoolSourceIds] = useState(() => {
    try {
      const arr = JSON.parse(localStorage.getItem('avi_planner_pool'));
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  });
  const [poolSort,   setPoolSort]   = useState('source');
  const [pickerOpen, setPickerOpen] = useState(false);

  // ── Draft state (Stage 2) ─────────────────────────────────────
  // Map itemKey -> { kind, sourceId, sectionId?, taskId?, title, dates: [] }.
  // Session-local; placing schedules nothing until Save (Stage 3).
  const [draft, setDraft]   = useState({});
  const [armed, setArmed]   = useState(null); // itemKey currently armed, or null
  const dirty = Object.values(draft).some(d => d.dates.length > 0);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const toggleDateForArmed = (dateStr) => {
    if (!armed) return;
    setDraft(prev => {
      const cur = prev[armed];
      if (!cur) return prev;
      const has = cur.dates.includes(dateStr);
      const nextDates = has ? cur.dates.filter(d => d !== dateStr) : [...cur.dates, dateStr].sort();
      return { ...prev, [armed]: { ...cur, dates: nextDates } };
    });
  };

  const removeDraftDate = (itemKey, dateStr) => {
    setDraft(prev => {
      const cur = prev[itemKey];
      if (!cur) return prev;
      return { ...prev, [itemKey]: { ...cur, dates: cur.dates.filter(d => d !== dateStr) } };
    });
  };

  // ── Save commit (Stage 3) ──
  const [saving, setSaving] = useState(false);
  const placements = Object.values(draft).filter(d => d.dates.length > 0);
  const handleSave = async () => {
    if (!placements.length || saving || !onPlannerCommit) return;
    setSaving(true);
    const ok = await onPlannerCommit(placements);
    setSaving(false);
    if (ok) { setDraft({}); setArmed(null); }
  };

  const togglePoolSource = (id) => {
    setPoolSourceIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      try { localStorage.setItem('avi_planner_pool', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // Mirror CL visibility: only sources that would appear in the Active,
  // Adrift, or Queue areas — not complete, not archived, not passive-media
  // excluded. (CL's series gate is intentionally not replicated here.)
  const plannerEligible = (src) => {
    if (isPassiveMediaExcluded(src)) return false;
    const st = src.sourceStatus ?? src.watchStatus ?? 'Not started';
    if (st === 'Done' || st === 'Archived') return false;
    const allSecs = (clSections || []).filter(s => s.resourceId === src.id);
    if (allSecs.length > 0 && allSecs.every(s => s.status === 'Done')) return false;
    return true;
  };
  const sortedSources = useMemo(() =>
    [...(clSources || [])].filter(plannerEligible)
      .sort((a, b) => (a.title || '').localeCompare(b.title || '')),
  [clSources, clSections]);

  // One chip per placeable unit: every non-Done section of each chosen
  // source, or the source itself when it has no sections.
  const poolItems = useMemo(() => {
    const items = [];
    poolSourceIds.forEach(sid => {
      const src = (clSources || []).find(s => s.id === sid);
      if (!src || !plannerEligible(src)) return;
      const allSecs = (clSections || []).filter(s => s.resourceId === sid);
      const secs = allSecs.filter(s => s.status !== 'Done');
      if (allSecs.length === 0) {
        items.push({ key: `source:${sid}`, kind: 'source', sourceId: sid,
          title: src.title || 'Untitled', secNum: null, sourceTitle: src.title || '' });
      } else {
        secs.forEach(sec => {
          const num = parseInt(sec.content, 10);
          items.push({ key: `section:${sec.id}`, kind: 'section', sourceId: sid, sectionId: sec.id,
            title: `${src.title || 'Untitled'} — ${sec.content}`,
            secNum: Number.isFinite(num) ? num : null,
            sourceTitle: src.title || '', linkedTaskId: sec.linkedTaskId || null });
        });
      }
    });
    if (poolSort === 'source') {
      items.sort((a, b) =>
        a.sourceTitle.localeCompare(b.sourceTitle) ||
        ((a.secNum ?? -1) - (b.secNum ?? -1)) ||
        a.title.localeCompare(b.title));
    } else {
      // Section-number sort: section-less sources first, then 1, 2, 3...,
      // with non-numeric section names after the numbered ones.
      const rank = (i) => i.kind === 'source' ? -1 : (i.secNum == null ? Number.MAX_SAFE_INTEGER : i.secNum);
      items.sort((a, b) => (rank(a) - rank(b)) || a.sourceTitle.localeCompare(b.sourceTitle));
    }
    return items;
  }, [poolSourceIds, clSources, clSections, poolSort]);

  return (
    <div>
      <div style={S.sectionHeader}>
        <div style={S.sectionTitle}>
          <div style={S.sectionAccent(C.accent)} />
          To Schedule
        </div>
      </div>
      <div style={{ ...S.card, marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
          <div onClick={() => setPickerOpen(o => !o)} style={S.recurChip(pickerOpen)}>Choose sources</div>
          <div style={{ flex: 1 }} />
          <div onClick={() => setPoolSort('source')} style={S.recurChip(poolSort === 'source')}>By source</div>
          <div onClick={() => setPoolSort('section')} style={S.recurChip(poolSort === 'section')}>By section</div>
        </div>
        {pickerOpen && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {sortedSources.map(src => (
              <div key={src.id} onClick={() => togglePoolSource(src.id)} style={S.recurChip(poolSourceIds.includes(src.id))}>
                {src.title || 'Untitled'}
              </div>
            ))}
            {sortedSources.length === 0 && (
              <div style={{ fontSize: '12px', color: C.textM }}>No Content Library sources yet.</div>
            )}
          </div>
        )}
        {poolItems.length === 0
          ? <div style={S.emptyState}>Choose sources to build the scheduling pool.</div>
          : <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {poolItems.map(it => {
                const count = draft[it.key]?.dates.length || 0;
                const isArmed = armed === it.key;
                return (
                  <div
                    key={it.key}
                    onClick={() => {
                      setArmed(a => a === it.key ? null : it.key);
                      setDraft(prev => prev[it.key] ? prev : {
                        ...prev,
                        [it.key]: { kind: it.kind, sourceId: it.sourceId, sectionId: it.sectionId || null,
                          taskId: null, linkedTaskId: it.linkedTaskId || null, title: it.title, dates: [] },
                      });
                    }}
                    style={{ ...S.recurChip(isArmed), display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  >
                    {it.title}
                    {count > 0 && (
                      <span style={{ fontFamily: SH.fm, fontSize: '10px', fontWeight: 700,
                        color: isArmed ? C.accent : C.textM }}>{count}</span>
                    )}
                  </div>
                );
              })}
            </div>}
        {armed && (
          <div style={{ fontSize: '11px', color: C.textM, marginTop: '8px' }}>
            Tap calendar days to place this item. Tap it again to finish.
          </div>
        )}
      </div>
      {placements.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
          <button style={{ ...S.btnPrimary, opacity: saving ? 0.6 : 1 }} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving' : `Save ${placements.length} placement${placements.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
      <PlannerCalendar
        tasks={tasks} draft={draft} armed={armed} dsh={dsh} C={C} S={S}
        onEdit={onEdit} onDayTap={toggleDateForArmed} onRemoveDraftDate={removeDraftDate}
      />
    </div>
  );
}

// ── PlannerCalendar (Stage 2) ─────────────────────────────────
// Self-contained month grid mirroring MonthCalendar's layout and bevel cell
// styling, with day-cell tap-to-place and dashed unsaved draft chips. Kept
// separate so the read-only This Month calendar stays untouched.
function PlannerCalendar({ tasks, draft, armed, dsh, C, S, onEdit, onDayTap, onRemoveDraftDate }) {
  const [dayDetail, setDayDetail] = useState(null);
  const today    = getLogicalToday(dsh);
  const todayStr = toDateStr(today);
  const [viewYear,  setViewYear]  = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const isCurrentMonth = viewYear === today.getFullYear() && viewMonth === today.getMonth();
  const goNextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };
  const goPrevMonth = () => {
    if (isCurrentMonth) return;
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };
  const monthName = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Committed tasks by date (non-recurring occurrences + real recurring +
  // virtuals) reuse the same helper the read-only calendar uses.
  const committedByDate = useMemo(() => {
    const map = {};
    const monthStart = new Date(viewYear, viewMonth, 1);
    const monthEnd   = new Date(viewYear, viewMonth + 1, 0);
    const add = (ds, t) => {
      map[ds] = map[ds] || [];
      if (!map[ds].some(x => x.id === t.id && x.date === ds)) map[ds].push(t);
    };
    tasks.forEach(t => {
      if (t.persistent) return;
      if (t.recurrence && t.recurrence.type !== 'none') {
        if (t._virtual) return;
        const real = parseDate(t.date);
        if (real && real >= monthStart && real <= monthEnd && !t.completed) add(toDateStr(real), t);
        // Project future occurrences so recurring load is visible while
        // placing; projections render in the standard faded _virtual style.
        generateProjections(t, monthStart, monthEnd).forEach(({ date, task }) => {
          const pd = parseDate(date);
          if (pd && pd >= monthStart && pd <= monthEnd && (!real || pd > real)) add(date, task);
        });
        return;
      }
      if (t._virtual) { if (t.date) add(t.date, t); return; }
      if (t.completed) return;
      getTaskDates(t).forEach(ds => {
        if (isDateDone(t, ds)) return;
        const d = parseDate(ds);
        if (d && d.getFullYear() === viewYear && d.getMonth() === viewMonth) add(ds, t);
      });
    });
    return map;
  }, [tasks, viewYear, viewMonth]);

  // Draft placements by date: itemKey -> title, for cells this month.
  const draftByDate = useMemo(() => {
    const map = {};
    Object.entries(draft).forEach(([key, d]) => {
      d.dates.forEach(ds => { (map[ds] = map[ds] || []).push({ key, title: d.title }); });
    });
    return map;
  }, [draft]);

  const firstDay    = new Date(viewYear, viewMonth, 1).getDay();
  const offset      = (firstDay + 6) % 7; // Monday-first
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px' }}>
        <button onClick={goPrevMonth} disabled={isCurrentMonth} style={{ background: 'none', border: 'none', cursor: isCurrentMonth ? 'default' : 'pointer', color: isCurrentMonth ? C.border : C.textM, fontSize: '16px', lineHeight: 1, padding: '2px 6px', borderRadius: '4px' }}>&#8249;</button>
        <div style={{ flex: 1, textAlign: 'center', fontFamily: SH.fd, fontSize: '17px', color: C.textS }}>{monthName}</div>
        <button onClick={goNextMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textM, fontSize: '16px', lineHeight: 1, padding: '2px 6px', borderRadius: '4px' }}>&#8250;</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '4px' }}>
        {WEEKDAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, padding: '4px 0' }}>{d}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>
        {cells.map((day, i) => {
          if (!day) return <div key={`e-${i}`} style={{ minHeight: '60px' }} />;
          const dateStr  = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const committed = committedByDate[dateStr] || [];
          const drafts    = draftByDate[dateStr] || [];
          const isToday   = dateStr === todayStr;
          const isPast    = new Date(viewYear, viewMonth, day) < today;
          const tappable  = !!armed && !isPast;
          return (
            <div
              key={dateStr}
              onClick={() => { if (armed) { if (tappable) onDayTap(dateStr); } else if (isMobile) { setDayDetail(dateStr); } }}              style={{
                minHeight: '60px',
                background: isToday ? C.accentSoft : (C.cardBg || C.raised),
                backgroundClip: 'padding-box',
                border: '4px solid transparent', borderRadius: 0,
                borderImageSource: frameBevel(tappable ? C.accent : (isToday ? C.accent : C.border)),
                borderImageSlice: 6, borderImageWidth: '5px', borderImageRepeat: 'stretch',
                padding: '1px 2px',
                opacity: isPast ? 0.6 : 1,
                overflow: 'hidden', minWidth: 0,
                cursor: tappable ? 'copy' : 'default',
              }}
            >
              <div style={{ fontSize: '10px', fontFamily: SH.fm, fontWeight: 600, color: isToday ? C.accent : C.textM, marginBottom: (committed.length || drafts.length) ? '4px' : 0, lineHeight: 1 }}>{day}</div>
              {isMobile ? (committed.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', rowGap: '3px', padding: '1px 0' }}>
                  {committed.map((t, idx) => (
                    <span key={`c-${t.id}-${idx}`} style={{ display: 'flex', opacity: t._virtual ? 0.5 : 1 }}>
                      <PriDot priority={t.priority} C={C} />
                    </span>
                  ))}
                </div>
              )) : committed.map((t, idx) => (
                <div key={`c-${t.id}-${idx}`} onClick={e => { if (!t._virtual) { e.stopPropagation(); onEdit(t); } }} title={t.title}
                  style={{ display: 'flex', alignItems: 'center', fontSize: '9.5px', lineHeight: 1.35, color: t._virtual ? C.textM : C.textS, cursor: t._virtual ? 'default' : 'pointer', marginBottom: '2px', opacity: t._virtual ? 0.7 : 1 }}>
                  <PriDot priority={t.priority} C={C} />
                  <span style={{ overflow: 'hidden', wordBreak: 'break-word', lineHeight: 1.3 }}>{t.title}</span>
                </div>
              ))}
              {drafts.map(dr => isMobile ? (
                <span key={`d-${dr.key}`} onClick={e => { e.stopPropagation(); onRemoveDraftDate(dr.key, dateStr); }}
                  style={{ display: 'inline-block', width: '11px', height: '11px', margin: '1px 4px 1px 0',
                    border: `1px dashed ${C.accent}`, background: C.accentSoft, backgroundClip: 'padding-box', cursor: 'pointer' }} />
              ) : (
                <div key={`d-${dr.key}`} onClick={e => { e.stopPropagation(); onRemoveDraftDate(dr.key, dateStr); }} title={`${dr.title} (tap to remove)`}
                  style={{ fontSize: '9px', lineHeight: 1.3, color: C.accent, marginBottom: '2px', padding: '1px 3px', cursor: 'pointer',
                    border: `1px dashed ${C.accent}`, background: C.accentSoft, backgroundClip: 'padding-box',
                    overflow: 'hidden', wordBreak: 'break-word' }}>
                  {dr.title}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {isMobile && dayDetail && (
        <DayDetailPopup dateStr={dayDetail} tasks={committedByDate[dayDetail] || []} C={C} S={S} onClose={() => setDayDetail(null)} onEditTask={onEdit} />
      )}
    </div>
  );
}

export function UpcomingPage({ tasks, onToggle, onEdit, dsh, soundProfile, updateData, appointments = [], clSources = [], clSections = [], onPlannerCommit }) {
  const { C, S } = useAppTheme();
  const [tab, setTab] = useState(() => {
    try {
      const stored = localStorage.getItem('avi_upcoming_tab');
      return stored === 'week' || stored === 'month' || stored === 'planner' ? stored : 'week';
    } catch { return 'week'; }
  });

  const today   = getLogicalToday(dsh);
  const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);

  // ── Planner unsaved-changes guard ──
  const plannerDirtyRef = useRef(false);
  const [pendingTab, setPendingTab] = useState(null);
  const switchTab = (id) => {
    if (tab === 'planner' && id !== 'planner' && plannerDirtyRef.current) {
      setPendingTab(id);
      return;
    }
    setTab(id);
    try { localStorage.setItem('avi_upcoming_tab', id); } catch {}
  };

  // ── Follow-up projections
  // Queued appointment follow-ups render as _virtual instances, the same
  // treatment as upcoming recurring occurrences: visible but not the real
  // task until the promotion engine rolls them in. In-memory only; these
  // copies are never written back.
  const followUpVirtuals = useMemo(() => {
    const todayStr = toDateStr(getLogicalToday(dsh));
    const out = [];
    (appointments || []).forEach(a => {
      const queue = a.followUpQueue || [];
      if (!queue.length) return;
      const base = tasks.find(t => t.id === a.taskId);
      queue.forEach(q => {
        if (!q.date || q.date < todayStr) return;
        out.push({
          ...(base || {}),
          id: a.taskId || a.id,
          title: base?.title || `Appt: ${a.type || 'Appointment'}`,
          category: base?.category || a.category || 'health',
          priority: base?.priority || 'med',
          date: q.date, time: q.time || null,
          dates: null, completedDates: null,
          recurrence: { type: 'none' },
          completed: false, persistent: false,
          _virtual: true, _followUp: true,
        });
      });
    });
    return out;
  }, [appointments, tasks, dsh]);

  const filtered = useMemo(() => {
    const results = [];
    const seen = new Set();

    [...tasks, ...followUpVirtuals].forEach(t => {
      if (t.persistent) return;

      if (t.recurrence && t.recurrence.type !== 'none') {
        if (t.completed) {
          // Done task: don't show today's completed occurrence.
          // Show virtual projections from nextDue within the week.
          const anchor = t.recurrence.nextDue
            ? parseDate(t.recurrence.nextDue)
            : parseDate(t.date);
          if (!anchor) return;

          // Include the nextDue date itself as a virtual projection
          if (anchor > today && anchor <= weekEnd) {
            const key = `${t.id}:${toDateStr(anchor)}`;
            if (!seen.has(key)) {
              seen.add(key);
              results.push({ ...t, date: toDateStr(anchor), completed: false, _virtual: true });
            }
          }
          // Additional projections beyond nextDue within the week
          generateProjections(t, anchor, weekEnd).forEach(({ date, task }) => {
            const key = `${t.id}:${date}`;
            if (!seen.has(key)) { seen.add(key); results.push(task); }
          });
        } else {
          // Incomplete recurring task
          const realDate = parseDate(t.date);
          if (!realDate) return;

          // Real occurrence: show if today or in this week
          // (today's undone tasks show in both Today AND Upcoming)
          if (realDate <= weekEnd && realDate >= today) {
            const key = `${t.id}:${t.date}`;
            if (!seen.has(key)) {
              seen.add(key);
              // Real task — NOT virtual, fully editable/toggleable
              results.push(t);
            }
          }
          // Virtual projections beyond the real date within the week
          generateProjections(t, realDate, weekEnd).forEach(({ date, task }) => {
            const key = `${t.id}:${date}`;
            if (!seen.has(key)) { seen.add(key); results.push(task); }
          });
        }
      } else {
        // Non-recurring: show each due date that is not done and falls in this week
        if (!t.completed) {
          const taskDates = getTaskDates(t);
          taskDates.forEach(ds => {
            if (isDateDone(t, ds)) return;
            const d = parseDate(ds);
            if (d && d >= today && d <= weekEnd) {
              const key = `${t.id}:${ds}`;
              if (!seen.has(key)) {
                seen.add(key);
                results.push(taskDates.length > 1 ? { ...t, date: ds, _dateOcc: true } : t);
              }
            }
          });
        }
      }
    });

    return results.sort(taskSortComparator);
  }, [tasks, followUpVirtuals, dsh, today, weekEnd]);

  const grouped = useMemo(() => {
    const g = {};
    filtered.forEach(t => { (g[t.date] = g[t.date] || []).push(t); });
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  // Drag sort only applies to real tasks
  const realFiltered = useMemo(() => filtered.filter(t => !t._virtual && !t._dateOcc), [filtered]);
  const handleReorder = useCallback((updatedAllTasks) => {
    updateData(prev => ({ ...prev, tasks: updatedAllTasks }));
  }, [updateData]);
  const { getDragHandlers } = useDragSort(realFiltered, tasks, handleReorder);

  return (
    <div className="fade-up">
      <div style={S.agendaTabs}>
        {[
          { id: 'week',    l: 'This Week'  },
          { id: 'month',   l: 'This Month' },
          { id: 'planner', l: 'Planner'    },
        ].map(t => (
          <div
            key={t.id}
            style={S.agendaTab(tab === t.id)}
            onClick={() => switchTab(t.id)}
          >
            {t.l}
          </div>
        ))}
      </div>

      {tab === 'month' ? (
        <MonthCalendar tasks={[...tasks, ...followUpVirtuals]} dsh={dsh} C={C} S={S} onEdit={onEdit} />
      ) : tab === 'planner' ? (
        <PlannerView tasks={[...tasks, ...followUpVirtuals]} clSources={clSources} clSections={clSections} dsh={dsh} C={C} S={S} onEdit={onEdit} onDirtyChange={(d) => { plannerDirtyRef.current = d; }} onPlannerCommit={onPlannerCommit} />
      ) : (
        grouped.length === 0
          ? <div style={S.emptyState}>Nothing scheduled this week.</div>
          : grouped.map(([date, ts]) => (
            <div key={date} style={S.dayGroup}>
              <div style={S.dayHeader}>
                {fmtDate(parseDate(date))}
                <div style={S.dayHeaderLine} />
              </div>
              <div style={S.card}>
                {ts.map((t, idx) => t._virtual ? (
                  <div
                    key={`${t.id}-${idx}`}
                    style={{ ...S.taskItem(false), opacity: 0.6 }}
                    className="task-row"
                  >
                    <div style={{ ...S.taskCheck(false, t.priority), opacity: 0.25, cursor: 'default' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ ...S.taskTitle(false), color: C.textS }}>{t.title}</div>
                      <div style={S.taskMeta}>
                        <span style={S.taskTag(t.category)}>
                          {CATEGORIES.find(c => c.id === t.category)?.label || t.category}
                        </span>
                        <span style={S.recurBadge}>{t._followUp ? 'follow-up' : '↻'}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <TaskItem
                    key={t.id}
                    task={t}
                    onToggle={onToggle}
                    onEdit={onEdit}
                    dsh={dsh}
                    soundProfile={soundProfile}
                    dragHandlers={getDragHandlers(t)}
                  />
                ))}
              </div>
            </div>
          ))
      )}

      {pendingTab && (
        <div style={S.confirmOverlay} onClick={() => setPendingTab(null)}>
          <div style={S.confirmBox} onClick={e => e.stopPropagation()}>
            <div style={S.confirmTitle}>Discard placements?</div>
            <div style={S.confirmMsg}>You have unsaved planner placements. Leaving this tab will discard them.</div>
            <div style={S.confirmActions}>
              <button style={S.btnGhost} className="btn-ghost" onClick={() => setPendingTab(null)}>Stay</button>
              <button style={S.btnDanger} onClick={() => {
                const dest = pendingTab;
                plannerDirtyRef.current = false;
                setPendingTab(null);
                setTab(dest);
                try { localStorage.setItem('avi_upcoming_tab', dest); } catch {}
              }}>Discard</button>
            </div>
          </div>
        </div>
      )}
      {isMobile && <div style={{ height: '80px' }} />}
    </div>
  );
}