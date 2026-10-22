import { useRef, useState, useCallback } from 'react';
import { dragRanks } from '../utils/dragSort.js';

/**
 * Manages drag-to-reorder for a list of tasks.
 *
 * @param {Array} visibleTasks - The currently displayed (filtered/sorted) task list
 * @param {Function} onReorder - Called with (ranks, day) after a drop: ranks
 *   maps task id -> manual rank for the tasks shown on that day
 * @param {Function} dayOf     - The day a row is shown on (N6: a drag
 *   arranges one day; a drop onto a row of another day does nothing)
 */
export function useDragSort(visibleTasks, onReorder, dayOf) {
  const dragId  = useRef(null); // id of the task being dragged
  const overId  = useRef(null); // id of the task currently hovered over
  const [draggingId, setDraggingId] = useState(null);

  const getDragHandlers = useCallback((task) => ({
    isDragging: draggingId === task.id,

    onDragStart: (e) => {
      dragId.current = task.id;
      setDraggingId(task.id);
      e.dataTransfer.effectAllowed = 'move';
    },

    onDragOver: (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      overId.current = task.id;
    },

    onDrop: (e) => {
      e.preventDefault();
      const fromId = dragId.current;
      dragId.current = null;
      overId.current = null;
      setDraggingId(null);
      if (!fromId || fromId === task.id) return;

      const moved = visibleTasks.find(t => t.id === fromId);
      if (!moved) return;
      const day = dayOf(task);
      if (dayOf(moved) !== day) return;

      // Reorder that day's rows only
      const dayRows = visibleTasks.filter(t => dayOf(t) === day);
      const ids     = dayRows.map(t => t.id);
      const fromIdx = ids.indexOf(fromId);
      const toIdx   = ids.indexOf(task.id);
      if (fromIdx === -1 || toIdx === -1) return;

      const reordered = [...dayRows];
      const [row]     = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, row);

      onReorder(dragRanks(reordered), day);
    },

    onDragEnd: () => {
      dragId.current = null;
      overId.current = null;
      setDraggingId(null);
    },
  }), [visibleTasks, onReorder, dayOf, draggingId]);

  return { getDragHandlers };
}
