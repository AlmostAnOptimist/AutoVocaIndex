import { useAppTheme } from '../hooks/useAppTheme.js';
import { TaskCheck } from './TaskCheck.jsx';
import { Icons } from './Icons.jsx';
import { playSound } from '../utils/soundEngine.js';
import { CATEGORIES } from '../constants.js';
import { parseDate, isToday, isPast, fmtDate, toDateStr, getLogicalToday, getTaskDates, taskLastDate, isLastDate, isDateDone } from '../utils/dateUtils.js';

// Converts "HH:MM" (24h) to "h:MM AM/PM"
function fmtTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${mStr} ${ampm}`;
}

export function TaskItem({ task, onToggle, onEdit, dsh, soundProfile, dragHandlers }) {
  const { C, S } = useAppTheme();
  const d = parseDate(task.date);
  // Overdue keys off the LAST due date (multi-date model); identical to d
  // for single-date tasks.
  const last = parseDate(taskLastDate(task));
  const overdue = last && isPast(last, dsh) && !task.completed;

  // ── Multi-date rows (F1) ──────────────────────────────────────
  // The date this row represents: Upcoming occurrence copies carry it in
  // task.date (_dateOcc); otherwise act on today's occurrence if there is
  // one, else the last date (Overdue rows).
  const taskDates = getTaskDates(task);
  const isMulti   = taskDates.length > 1;
  const todayStr  = toDateStr(getLogicalToday(dsh));
  const rowDate   = !isMulti ? task.date
    : task._dateOcc ? task.date
    : taskDates.includes(todayStr) ? todayStr
    : taskLastDate(task);
  const rowIsLast  = !isMulti || isLastDate(task, rowDate);
  const rowChecked = rowIsLast ? !!task.completed : isDateDone(task, rowDate);
  const catLabel = CATEGORIES.find(c => c.id === task.category)?.label || task.category;
  const recurLabel = task.recurrence?.type && task.recurrence.type !== 'none'
    ? task.recurrence.type.replace(/_/g, ' ') : null;

  // ── Standard task ──────────────────────────────────────────
  return (
    <div
      style={{
        ...S.taskItem(rowChecked),
        cursor: dragHandlers ? 'grab' : 'default',
        opacity: dragHandlers?.isDragging ? 0.4 : (rowChecked ? 0.55 : 1),
      }}
      className="task-row"
      draggable={!!dragHandlers}
      onDragStart={dragHandlers?.onDragStart}
      onDragOver={dragHandlers?.onDragOver}
      onDrop={dragHandlers?.onDrop}
      onDragEnd={dragHandlers?.onDragEnd}
    >
        <TaskCheck checked={rowChecked} priority={task.priority} onClick={() => onToggle(task.id, isMulti ? rowDate : undefined)} soundProfile={soundProfile} />
      {isMulti && !rowIsLast && !task.completed && (
        <div
          title="Finish entire task"
          onClick={e => { e.stopPropagation(); if (soundProfile !== 'none') playSound(soundProfile || 'chirp'); onToggle(task.id, rowDate, true); }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '18px', height: '18px', marginTop: '1px', flexShrink: 0, color: C.textM, cursor: 'pointer' }}
        >
          {Icons.doubleCheck}
        </div>
      )}      <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onEdit && onEdit(task)}>
        <div style={{ ...S.taskTitle(rowChecked), display: 'flex', alignItems: 'center', gap: '5px' }}>
          {task.title}
          {task.push && (
            <span style={{ color: C.textM, opacity: 0.65, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
              {Icons.push}
            </span>
          )}
        </div>
        <div style={S.taskMeta}>
          <span style={S.taskTag(task.category)}>{catLabel}</span>
          {d && !isToday(d, dsh) && (
            <span style={S.taskTime(overdue)}>
              {overdue ? `Overdue · ${fmtDate(d)}` : fmtDate(d)}
            </span>
          )}
          {isMulti && (
            <span style={{ fontSize: '11px', color: C.textM }}>
              {`Day ${taskDates.indexOf(rowDate) + 1} of ${taskDates.length}`}
            </span>
          )}
          {task.isAppointmentTask
            ? (task.apptProvider || task.time) && (
                <span style={{ fontSize: '11px', color: C.textM }}>
                  {task.apptProvider || ''}
                  {task.apptProvider && task.time ? ' · ' : ''}
                  {task.time ? fmtTime(task.time) : ''}
                </span>
              )
            : recurLabel && <span style={S.recurBadge}>{Icons.recur} {recurLabel}</span>
          }
        </div>
      </div>
    </div>
  );
}
