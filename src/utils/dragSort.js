/**
 * N6: a drag arranges one day only. Each dragged list
 * stamps its tasks with the order and the day it applies to (sortOrderDate);
 * on any other day the task sorts by time, then priority, as if never
 * dragged. Orders from before this change have no day and are ignored.
 */

// Ranks for a reordered list: id -> rank (multiples of 10).
export function dragRanks(reorderedSubset) {
  const ranks = {};
  reorderedSubset.forEach((task, i) => { ranks[task.id] = (i + 1) * 10; });
  return ranks;
}

/**
 * Applies ranks for `day` onto the task array (pass the latest array, e.g.
 * inside an updateData updater, so nothing that changed since the list was
 * drawn is reverted).
 */
export function applyDragOrder(allTasks, ranks, day) {
  return allTasks.map(t =>
    ranks[t.id] !== undefined
      ? { ...t, sortOrder: ranks[t.id], sortOrderDate: day }
      : t
  );
}

// The manual rank that applies to a task shown on `day`, or null.
export function manualRankOn(task, day) {
  return task.sortOrder != null && task.sortOrderDate && task.sortOrderDate === day
    ? task.sortOrder
    : null;
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

/**
 * Comparator for a task list. dayOf(task) is the day the row is shown on
 * (Today: the logical day for every row; Upcoming: the row's own date).
 * A manual order counts only on the day it was made for.
 */
export function makeTaskSortComparator(dayOf) {
  return (a, b) => compareTasks(a, b, manualRankOn(a, dayOf(a)), manualRankOn(b, dayOf(b)));
}

function compareTasks(a, b, aRank, bRank) {
  // Completed always last
  if (a.completed !== b.completed) return a.completed ? 1 : -1;

  const aHas = aRank != null;
  const bHas = bRank != null;

  // Both have manual order
  if (aHas && bHas) return aRank - bRank;

  // One has manual order — manual always wins over default
  if (aHas) return -1;
  if (bHas) return 1;

  // Neither has manual order — time wins, then the shared tiebreak
  if (a.time && b.time) return a.time.localeCompare(b.time);
  if (a.time) return -1;
  if (b.time) return 1;
  return compareByPriorityPushCategoryTitle(a, b);
}