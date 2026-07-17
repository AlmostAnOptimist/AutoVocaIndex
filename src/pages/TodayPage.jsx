import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { parseDate, isToday, getLogicalToday, getGreeting, toDateStr, getLogicalDateStr, getTaskDates, taskOccursOn, isDateCounted } from '../utils/dateUtils.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { TaskItem } from '../components/TaskItem.jsx';
import { ProgressBar } from '../components/ProgressBar.jsx';
import { CATEGORIES } from '../constants.js';
import { playSound } from '../utils/soundEngine.js';
import { doc, setDoc } from 'firebase/firestore';
import { db, auth } from '../firebase.js';import { SH } from '../theme/buildStyles.js';
import { Icons } from '../components/Icons.jsx';
import { useDragSort } from '../hooks/useDragSort.js';
import { taskSortComparator, applyDragOrder } from '../utils/dragSort.js';
import { uid } from '../utils/dateUtils.js';

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

export function TodayPage({ tasks, onToggle, onEdit, dsh, soundProfile, updateData, flashcardDue, cards, srsSnapshot = {},
 }) {
  const { C, S } = useAppTheme();
  const [filter, setFilter] = useState('all');
  const ct  = C.bgText  || C.text;
  const ctm = C.bgTextM || C.textM;

  // ── SRS progress for today ────────────────────────────────────
  // srsReviewed: cards reviewed in today's logical window (respects day-flip hour).
  // Derived from the app-level cards prop — no extra Firestore read needed.
  // dueAtDayStart: snapshot taken when the pipeline ran (fixed total all day).
  const srsReviewed = useMemo(() => {
    if (!cards) return 0;
    const logicalDateStr = getLogicalDateStr(dsh);
    const windowStart = new Date(logicalDateStr + 'T' + String(dsh).padStart(2, '0') + ':00:00').getTime();
    const windowEnd   = windowStart + 86_400_000;
    return cards.filter(c => {
      const reviewed = c.lastReview || c.lastReviewed;
      if (c.type === 'grammar' || !reviewed) return false;
      const ms = new Date(reviewed).getTime();
      return ms >= windowStart && ms < windowEnd;
    }).length;
  }, [cards, dsh]);

  // ── Tasks ─────────────────────────────────────────────────────
  const todayTasks = useMemo(() => {
    const todayDateStr = toDateStr(getLogicalToday(dsh));
    let t = tasks.filter(tk => !tk.persistent && taskOccursOn(tk, todayDateStr));
    if (filter !== 'all') t = t.filter(tk => tk.category === filter);
    return [...t].sort(taskSortComparator);
  }, [tasks, filter, dsh]);

  const persistentTasks = useMemo(() => {
    return tasks.filter(tk => tk.persistent);
  }, [tasks]);

  const activatePersistent = useCallback((taskId) => {
    const today = getLogicalToday(dsh);
    updateData(prev => ({
      ...prev,
      tasks: prev.tasks.map(t =>
        t.id === taskId
          ? { ...t, activeToday: true, activatedOn: toDateStr(today), completed: false }
          : t
      ),
    }));
  }, [updateData, dsh]);

  const handleReorder = useCallback((updatedAllTasks) => {
    updateData(prev => ({ ...prev, tasks: updatedAllTasks }));
  }, [updateData]);

  const { getDragHandlers } = useDragSort(todayTasks, tasks, handleReorder);

  const today        = getLogicalToday(dsh);
  const todayDateStr = toDateStr(today);
  const done  = todayTasks.filter(t => isDateCounted(t, todayDateStr)).length;
  const total = todayTasks.length;

  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekEnd   = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  // Per-date counting: each due date in the week is one unit; a date is done
  // iff isDateCounted says so (completedDates membership on multi-date tasks).
  let weekTotal = 0;
  let weekDone  = 0;
  tasks.forEach(t => {
    if (filter !== 'all' && t.category !== filter) return;
    getTaskDates(t).forEach(ds => {
      const d = parseDate(ds);
      if (!d || d < weekStart || d > weekEnd) return;
      weekTotal += 1;
      if (isDateCounted(t, ds)) weekDone += 1;
    });
  });

  const dateStr = getLogicalToday(dsh).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const srsDone   = srsReviewed;
  const srsTotal_ = srsSnapshot.dueAtDayStart ?? 0;

  return (
    <>
    <div className="fade-up">

      {/* Outer 2-column layout: left content + right spacer */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr', gap: '24px', alignItems: 'start' }}>

        {/* LEFT COLUMN — greeting, pills, tasks+stats grid */}
        <div>

          {/* Greeting + date */}
          <div style={{ fontFamily: SH.fd, fontSize: '30px', color: ct, lineHeight: 1.2, marginBottom: '4px' }}>
            {getGreeting(dsh)}
          </div>
          <div style={{ color: ctm, fontSize: '13px', marginBottom: '20px' }}>{dateStr}</div>

          {/* Category filter pills — hidden while only one category exists */}
          {CATEGORIES.length > 1 && (
            <div style={S.catPills}>
              {[{ id: 'all', label: 'All' }, ...CATEGORIES].map(c => (
                <div key={c.id} style={S.catPill(filter === c.id)} onClick={() => setFilter(c.id)}>
                  {c.label}
                </div>
              ))}
            </div>
          )}

          {/* Inner 2-column: tasks + stats */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
            gap: '16px',
            alignItems: 'start',
          }} className="today-grid">

            {/* Tasks column */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={S.sectionHeader}>
                <div style={S.sectionTitle}>
                  <div style={S.sectionAccent(C.accent)} />
                  Today's Tasks
                </div>
              </div>
              <div style={S.card}>
                {todayTasks.length === 0
                  ? <div style={S.emptyState}>{filter !== 'all' ? 'No tasks for this category today.' : 'No tasks for today.'}</div>
                  : todayTasks.map(t => (
                  <TaskItem
                  key={t.id}
                  task={t}
                  onToggle={onToggle}
                  onEdit={onEdit}
                  dsh={dsh}
                  soundProfile={soundProfile}
                  dragHandlers={getDragHandlers(t)}
                  />
                  ))
                }
              </div>
            </div>

            {/* Stats column */}
            <div style={S.statsCol} className="stats-col">
              <div style={S.sectionHeader}>
                <div style={S.sectionTitle}>
                  <div style={S.sectionAccent(C.accent2 || C.accent)} />
                  Stats
                </div>
              </div>

              <div style={S.statCard}>
                <div style={S.statCardTitle}>Today's Progress</div>
                <ProgressBar
                  done={done} total={total} label="Tasks"
                  onComplete={() => { if (soundProfile !== 'none') playSound(soundProfile || 'chirp'); }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '12px', fontSize: '12px', color: C.textS }}>
                  <span>Done: <span style={{ fontFamily: SH.fm, color: C.accent }}>{done}</span></span>
                  <span>Left: <span style={{ fontFamily: SH.fm, color: C.text }}>{total - done}</span></span>
                </div>
              </div>

              {/* Today's Reviews — visible whenever cards were due or reviewed */}
              {(srsTotal_ > 0 || srsDone > 0) && (
                <div style={S.statCard}>
                  <div style={S.statCardTitle}>Today's Reviews</div>
                  <ProgressBar
                    done={srsDone}
                    total={srsTotal_}
                    label="Cards"
                    color={C.accent2 || C.accent}
                    onComplete={() => { if (soundProfile !== 'none') playSound(soundProfile || 'chirp'); }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '12px', fontSize: '12px', color: C.textS }}>
                    <span>Done: <span style={{ fontFamily: SH.fm, color: C.accent2 || C.accent }}>{srsDone}</span></span>
                    <span>Left: <span style={{ fontFamily: SH.fm, color: C.text }}>{Math.max(0, srsTotal_ - srsDone)}</span></span>
                  </div>
                </div>
              )}

              {/* SRS spike flags — up to 3, nearest first, shown under Today's Reviews */}
              {(srsSnapshot.spikes ?? []).length > 0 && (
                <div style={{
                  padding: '10px 12px', borderRadius: '8px',
                  border: `1px solid ${C.warning}`,
                  background: `${C.warning}11`,
                }}>
                  {(srsSnapshot.spikes).map((spike, i) => (
                    <div
                      key={spike.taskDateStr}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        marginTop: i > 0 ? '6px' : 0,
                      }}
                    >
                      <span style={{ color: C.warning, display: 'flex', flexShrink: 0 }}>{Icons.shield}</span>
                      <div style={{ fontSize: '12px', fontWeight: 500, color: C.warning }}>
                        {spike.dueCount} card spike on {spike.dayName}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* This Week - shows tasks done / total */}
              <div style={S.statCard}>
                <div style={S.statCardTitle}>This Week</div>
                <ProgressBar done={weekDone} total={weekTotal} color={C.accent2} label="Tasks" />
              </div>
            </div>
  
          </div>

          {/* Always On — below the tasks/stats grid */}
          {persistentTasks.length > 0 && filter === 'all' && (
            <div style={{ marginTop: '24px' }}>
              <div style={{ ...S.sectionHeader, marginBottom: '12px' }}>
                <div style={S.sectionTitle}>
                  <div style={S.sectionAccent(C.textM)} />
                  Always On
                </div>
              </div>
              <div style={S.card}>
                {persistentTasks.map(t => {
                  const isActive    = t.activeToday && !t.completed;

                  return (
                    <div
                      key={t.id}
                      style={{
                        ...S.taskItem(t.completed),
                        opacity: isActive ? 1 : 0.45,
                        flexDirection: 'column',
                        alignItems: 'stretch',
                      }}
                      className="task-row"
                    >
                      {/* Top row: check + priority dot + title/meta + button */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {isActive ? (
                          <div onClick={() => { if (!t.completed && soundProfile !== 'none') playSound(soundProfile || 'chirp'); onToggle(t.id); }} style={S.taskCheck(t.completed, t.priority)}>
                            {t.completed && <span style={{ color: '#fff', lineHeight: 1 }}>{Icons.check}</span>}
                          </div>
                        ) : (
                          <div style={{ ...S.taskCheck(false, t.priority), opacity: 0.3, cursor: 'default' }} />
                        )}
                        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onEdit && onEdit(t)}>
                          <div style={S.taskTitle(t.completed)}>{t.title}</div>
                          <div style={S.taskMeta}>
                            <span style={S.taskTag(t.category)}>
                              {CATEGORIES.find(c => c.id === t.category)?.label || t.category}
                            </span>
                          </div>
                        </div>
                        {!isActive && (
                          <button
                            onClick={() => activatePersistent(t.id)}
                            style={{
                              fontSize: '11px', fontWeight: 500, color: C.accent,
                              border: `1px solid ${C.accent}`, borderRadius: '4px',
                              padding: '3px 8px', flexShrink: 0, cursor: 'pointer',
                              background: 'transparent', transition: 'all 0.15s',
                              maxWidth: '100px',
                            }}
                          >
                            Add to Today
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN — invisible spacer so grid reserves space for fixed birb (desktop only) */}
        {!isMobile && <div style={{ visibility: 'hidden', pointerEvents: 'none' }} aria-hidden="true" />}

      </div>
      {isMobile && <div style={{ height: '88px' }} />}
    </div>
  </>
  );
}

