import { useRef, useState, useCallback } from 'react';
import { applyDragOrder } from '../utils/dragSort.js';

/**
 * Manages drag-to-reorder for a list of tasks.
 *
 * @param {Array} visibleTasks - The currently displayed (filtered/sorted) task list
 * @param {Array} allTasks     - The full task array from app state
 * @param {Function} onReorder - Called with the updated full task array after a drop
 */
export function useDragSort(visibleTasks, allTasks, onReorder) {
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
      if (!dragId.current || dragId.current === task.id) return;

      // Reorder the visible subset
      const ids     = visibleTasks.map(t => t.id);
      const fromIdx = ids.indexOf(dragId.current);
      const toIdx   = ids.indexOf(task.id);
      if (fromIdx === -1 || toIdx === -1) return;

      const reordered = [...visibleTasks];
      const [moved]   = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);

      const updatedAll = applyDragOrder(allTasks, reordered);
      onReorder(updatedAll);

      dragId.current = null;
      overId.current = null;
      setDraggingId(null);
    },

    onDragEnd: () => {
      dragId.current = null;
      overId.current = null;
      setDraggingId(null);
    },
  }), [visibleTasks, allTasks, onReorder, draggingId]);

  return { getDragHandlers };
}