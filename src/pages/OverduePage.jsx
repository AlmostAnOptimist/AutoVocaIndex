import { useMemo, useCallback } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { TaskItem } from '../components/TaskItem.jsx';
import { parseDate, isPast, getLogicalToday, toDateStr, getTaskDates, taskAnchorDate, taskLastDate, isDateDone } from '../utils/dateUtils.js';
import { getWindowEnd } from '../utils/recurrenceEngine.js';
import { SH } from '../theme/buildStyles.js';
import { useDragSort } from '../hooks/useDragSort.js';
import { compareByPriorityPushCategoryTitle } from '../utils/dragSort.js';

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

function MiniCalendar({ tasks, dsh, C }) {
  const today = getLogicalToday(dsh);
  const year  = today.getFullYear();
  const month = today.getMonth();

  // Count scheduled (non-null date, non-completed) tasks per day this month
  const countsByDate = useMemo(() => {
    const counts = {};
    tasks.forEach(t => {
      if (t.completed) return;
      getTaskDates(t).forEach(ds => {
        if (isDateDone(t, ds)) return;
        const d = parseDate(ds);
        if (!d || d.getFullYear() !== year || d.getMonth() !== month) return;
        counts[ds] = (counts[ds] || 0) + 1;
      });
    });
    return counts;
  }, [tasks, year, month]);

  const monthName = today.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Calendar grid: Monday-start
  const firstDay = new Date(year, month, 1);
  // getDay(): 0=Sun,1=Mon...6=Sat. Monday-start offset:
  const startOffset = (firstDay.getDay() + 6) % 7; // Mon=0, Tue=1 ... Sun=6
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = toDateStr(today);

  // Max count for heat scaling
  const maxCount = Math.max(1, ...Object.values(countsByDate));

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  return (
    <div>
      <div style={{
        fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: C.textM, marginBottom: '12px',
      }}>
        {monthName}
      </div>

      {/* Weekday headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '4px' }}>
        {WEEKDAYS.map((d, i) => (
          <div key={i} style={{
            textAlign: 'center', fontSize: '9px', fontWeight: 600,
            letterSpacing: '0.06em', color: C.textM, padding: '2px 0',
          }}>{d}</div>
        ))}
      </div>

      {/* Day cells */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
        {cells.map((day, i) => {
          if (!day) return <div key={`e-${i}`} />;
          const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const count   = countsByDate[dateStr] || 0;
          const isToday = dateStr === todayStr;
          const isPastDay = new Date(year, month, day) < today;

          // Heat: 0 tasks = lightest, more tasks = more saturated accent
          const heat = count > 0 ? Math.min(0.15 + (count / maxCount) * 0.55, 0.7) : 0;
          const bg   = count > 0
            ? `rgba(${hexToRgb(C.accent)}, ${heat})`
            : 'transparent';

          return (
            <div key={dateStr} title={count > 0 ? `${count} task${count > 1 ? 's' : ''}` : undefined} style={{
              borderRadius: '4px',
              padding: '3px 2px',
              textAlign: 'center',
              background: isToday ? C.accentSoft : bg,
              border: isToday ? `1px solid ${C.accent}` : '1px solid transparent',
              cursor: 'default',
            }}>
              <div style={{
                fontSize: '10px',
                fontFamily: SH.fm,
                color: isPastDay ? C.textM : isToday ? C.accent : C.text,
                opacity: isPastDay ? 0.45 : 1,
                lineHeight: 1.4,
              }}>{day}</div>
              {count > 0 && (
                <div style={{
                  fontSize: '9px',
                  fontFamily: SH.fm,
                  color: isToday ? C.accent : C.textS,
                  lineHeight: 1,
                }}>{count}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <div style={{ fontSize: '9px', color: C.textM, letterSpacing: '0.05em' }}>Lighter</div>
        {[0.15, 0.3, 0.45, 0.6, 0.7].map((o, i) => (
          <div key={i} style={{
            width: '10px', height: '10px', borderRadius: '2px',
            background: `rgba(${hexToRgb(C.accent)}, ${o})`,
          }} />
        ))}
        <div style={{ fontSize: '9px', color: C.textM, letterSpacing: '0.05em' }}>Busier</div>
      </div>
    </div>
  );
}

// Utility: convert 6-char hex to "r, g, b" string for rgba()
function hexToRgb(hex) {
  const h = (hex || '#888888').replace('#', '');
  if (h.length !== 6) return '136, 136, 136';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

export function OverduePage({ tasks, onToggle, onEdit, dsh, soundProfile, updateData }) {
  const { C, S } = useAppTheme();

  const overdue = useMemo(() => {
    const today = getLogicalToday(dsh);
    return tasks.filter(t => {
      if (t.completed) return false;
      // Overdue = the LAST due date has passed (multi-date model).
      const d = parseDate(taskLastDate(t));
      if (!d || !isPast(d, dsh)) return false;
      if (!t.recurrence || t.recurrence.type === 'none') return true;
      if (t.recurrence.type === 'daily') return false;
      const windowEnd = getWindowEnd(t);
      return windowEnd && today <= windowEnd;
    }).sort((a, b) => {
      // 1. Date ascending (oldest first)
      const da = parseDate(taskAnchorDate(a)), db = parseDate(taskAnchorDate(b));
      if (da && db && da.getTime() !== db.getTime()) return da - db;
      // 2. Priority > push > category > title
      return compareByPriorityPushCategoryTitle(a, b);
    });
  }, [tasks, dsh]);

  const unscheduled = useMemo(() => {
    return tasks.filter(t => getTaskDates(t).length === 0 && !t.persistent).sort(compareByPriorityPushCategoryTitle);
  }, [tasks]);

  const handleReorder = useCallback((updatedAllTasks) => {
    updateData(prev => ({ ...prev, tasks: updatedAllTasks }));
  }, [updateData]);

  const { getDragHandlers: getOverdueDrag }     = useDragSort(overdue,     tasks, handleReorder);
  const { getDragHandlers: getUnscheduledDrag } = useDragSort(unscheduled, tasks, handleReorder);

  return (
    <>
    <div className="fade-up" style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr',
      gap: '24px',
      alignItems: 'start',
    }}>

      {/* LEFT — Overdue */}
      <div>
        <div style={S.sectionHeader}>
          <div style={S.sectionTitle}>
            <div style={S.sectionAccent(C.danger)} />
            Overdue
            {overdue.length > 0 && (
              <span style={{
                marginLeft: '6px', fontSize: '11px', fontFamily: SH.fm,
                color: C.danger, fontWeight: 600,
              }}>{overdue.length}</span>
            )}
          </div>
        </div>
        <div style={S.card}>
          {overdue.length === 0
            ? <div style={S.emptyState}>No overdue tasks.</div>
            : overdue.map(t => (
              <TaskItem key={t.id} task={t} onToggle={onToggle} onEdit={onEdit} dsh={dsh} soundProfile={soundProfile} dragHandlers={getOverdueDrag(t)} />
            ))
          }
        </div>
      </div>

      {/* MIDDLE — Unscheduled */}
      <div>
        <div style={S.sectionHeader}>
          <div style={S.sectionTitle}>
            <div style={S.sectionAccent(C.accent2 || C.accent)} />
            Unscheduled
            {unscheduled.length > 0 && (
              <span style={{
                marginLeft: '6px', fontSize: '11px', fontFamily: SH.fm,
                color: C.textM, fontWeight: 600,
              }}>{unscheduled.length}</span>
            )}
          </div>
        </div>
        <div style={S.card}>
          {unscheduled.length === 0
            ? <div style={S.emptyState}>Nothing unscheduled.</div>
            : unscheduled.map(t => (
              <TaskItem key={t.id} task={t} onToggle={onToggle} onEdit={onEdit} dsh={0} soundProfile={soundProfile} dragHandlers={getUnscheduledDrag(t)} />            ))
          }
        </div>
      </div>

      {/* RIGHT — Mini calendar */}
      <div>
        <div style={S.sectionHeader}>
          <div style={S.sectionTitle}>
            <div style={S.sectionAccent(C.accent)} />
            This Month
          </div>
        </div>
        <div style={{
          background: C.cardBg || C.raised,
          border: `1px solid ${C.border}`,
          borderRadius: '12px',
          padding: '16px',
        }}>
          <MiniCalendar tasks={tasks} dsh={dsh} C={C} />
        </div>
      </div>

    </div>
    {isMobile && <div style={{ height: '80px' }} />}
    </>
  );
}