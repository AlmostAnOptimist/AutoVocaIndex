// src/utils/pendingFields.js
// Field updates held per document until they are sent (audit CL1).
// Leaf module: no imports.
//
// The Library's status buttons wait half a second before writing, so quick
// clicks become one write. Each click used to replace the write that was
// waiting, fields and all: a first click that cleared a section's task link
// (Not started or Skip releases the scheduled task) followed quickly by a
// second click sent only the second click's fields, and the section kept a
// link to a task that no longer existed. Here every click's fields are
// merged, later clicks winning field by field, so what is sent is exactly
// what the clicks left on screen.

export function createPendingFields() {
  const held = new Map();
  return {
    // Merge `fields` into what is waiting for `key`.
    add(key, fields) { held.set(key, { ...(held.get(key) || {}), ...fields }); },
    // What is waiting for `key` (null if nothing), and forget it.
    take(key) {
      const fields = held.get(key) || null;
      held.delete(key);
      return fields;
    },
    size: () => held.size,
  };
}
