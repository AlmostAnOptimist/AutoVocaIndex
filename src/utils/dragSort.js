/**
 * Assigns sortOrder values to a reordered task list.
 * Takes the full task array and a reordered subset (the visible list after drag),
 * returns the full task array with updated sortOrder on affected tasks.
 */
export function applyDragOrder(allTasks, reorderedSubset) {
  // Assign sequential sortOrder to the reordered subset
  const orderMap = {};
  reorderedSubset.forEach((task, i) => {
    orderMap[task.id] = (i + 1) * 10; // multiples of 10 leave room for future insertions
  });

  return allTasks.map(t =>
    orderMap[t.id] !== undefined
      ? { ...t, sortOrder: orderMap[t.id] }
      : t
  );
}

/**
 * Sort comparator that respects sortOrder, then falls back to time > priority.
 */
import { CATEGORIES } from '../constants.js';

const PRI       = { high: 0, med: 1, low: 2 };
const CAT_ORDER = CATEGORIES.map(c => c.id);

function catRank(cat) {
  const i = CAT_ORDER.indexOf(cat);
  return i === -1 ? CAT_ORDER.length : i;
}

/**
 * Shared tiebreak: priority (high > med > low) > regular before Push >
 * category (app display order) > title (alphabetical).
 */
export function compareByPriorityPushCategoryTitle(a, b) {
  const priDiff = (PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1);
  if (priDiff !== 0) return priDiff;

  const pushDiff = (a.push ? 1 : 0) - (b.push ? 1 : 0);
  if (pushDiff !== 0) return pushDiff;

  const catDiff = catRank(a.category) - catRank(b.category);
  if (catDiff !== 0) return catDiff;

  return (a.title || '').localeCompare(b.title || '');
}

export function taskSortComparator(a, b) {
  // Completed always last
  if (a.completed !== b.completed) return a.completed ? 1 : -1;

  const aHas = a.sortOrder != null;
  const bHas = b.sortOrder != null;

  // Both have manual order
  if (aHas && bHas) return a.sortOrder - b.sortOrder;

  // One has manual order — manual always wins over default
  if (aHas) return -1;
  if (bHas) return 1;

  // Neither has manual order — time wins, then the shared tiebreak
  if (a.time && b.time) return a.time.localeCompare(b.time);
  if (a.time) return -1;
  if (b.time) return 1;
  return compareByPriorityPushCategoryTitle(a, b);
}