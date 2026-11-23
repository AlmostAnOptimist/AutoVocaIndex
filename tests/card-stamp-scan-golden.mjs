// tests/card-stamp-scan-golden.mjs
// Scans the source for flashcard writes that leave out the changed-at stamp
// (offline decisions OF-D2, src/utils/cardStamp.js).
//
// Other devices read only the cards stamped since they last looked, so a
// card write without withCardStamp(...) stays invisible to them until their
// once-a-day full read. This test is the guard against forgetting it: add a
// card write anywhere in src/ without the stamp and it fails, naming the
// file and line.
//
// What counts as a card write: a call to updateDoc, setDoc, addDoc, or a
// batch's .update / .set, whose target is the flashcards collection, either
// written out ('flashcards' inside the call) or through a variable that was
// assigned a flashcards doc earlier in the same file. Deletes need no stamp.
// Not seen by this scan: a write through a snapshot's own ref (d.ref). The
// Dev Dashboard's maintenance actions do that; the daily read covers them.
//
// Run from the repo root:   node tests/card-stamp-scan-golden.mjs   (or: npm test)
// Plain Node, reads files only. Exits 1 on any failure.

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// One-time migrations that have already run; they are not card edits a
// second device needs to hear about.
const EXEMPT = new Map([
  ['src/utils/migrateGrammarIndexReview.js', 'one-time migration, finished'],
  ['src/utils/migrateDedupeNuanceCards.js',  'one-time migration, finished'],
]);

async function sourceFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await sourceFiles(p));
    else if (/\.(js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

// The text between the parenthesis at `open` and its match.
function callArgs(text, open) {
  let depth = 0, quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}
const firstArg = (args) => {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
};
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Card writes in one file: [{ line, call, stamped }].
export function cardWrites(text) {
  const refNames = new Set();
  for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*doc\(\s*[^;\n]*'flashcards'/g)) refNames.add(m[1]);
  const found = [];
  for (const m of text.matchAll(/\b(updateDoc|setDoc|addDoc|\w+\.update|\w+\.set)\s*\(/g)) {
    const args = callArgs(text, m.index + m[0].length - 1);
    const target = firstArg(args);
    const isCard = target.includes("'flashcards'") || refNames.has(target);
    if (!isCard) continue;
    found.push({ line: lineOf(text, m.index), call: m[1], stamped: args.includes('withCardStamp(') });
  }
  return found;
}

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}${detail ? `\n  ${detail}` : ''}`);
}

// 1. The scanner itself, on small made-up sources.
{
  const sample = `
    const cardRef = doc(collection(db, 'users', uid, 'flashcards'));
    setDoc(cardRef, withCardStamp(cardData));
    setDoc(cardRef, cardData);
    updateDoc(doc(db, 'users', uid, 'flashcards', id), { front: 'x (y)' });
    batch.update(doc(db, 'users', uid, 'flashcards', id), withCardStamp({ deckIds }));
    batch.delete(doc(db, 'users', uid, 'flashcards', id));
    updateDoc(doc(db, 'users', uid, 'decks', deckId), { totalCards: increment(1) });
    held.set(key, { a: 1 });
    const snap = await getDocs(collection(db, 'users', uid, 'flashcards'));
    const made = await addDoc(collection(db, 'users', uid, 'flashcards'), cardData);
  `;
  const got = cardWrites(sample).map(w => [w.line, w.call, w.stamped]);
  check('scanner: finds card writes by literal and by variable, tells stamped from unstamped, ignores deletes, reads and other collections',
    JSON.stringify(got) === JSON.stringify([[3, 'setDoc', true], [4, 'setDoc', false], [5, 'updateDoc', false], [6, 'batch.update', true], [11, 'addDoc', false]]),
    JSON.stringify(got));
}

// 2. The real source.
const files = await sourceFiles(join(root, 'src'));
let stamped = 0;
const missing = [], exemptSeen = [];
for (const file of files) {
  const rel = relative(root, file).split('\\').join('/');
  const writes = cardWrites(await readFile(file, 'utf8'));
  if (EXEMPT.has(rel)) { if (writes.length) exemptSeen.push(rel); continue; }
  for (const w of writes) {
    if (w.stamped) stamped++;
    else missing.push(`${rel}:${w.line}  ${w.call}(...) writes a card without withCardStamp`);
  }
}
check('every card write in src/ carries the changed-at stamp', missing.length === 0, missing.join('\n  '));
// If the scan ever finds far fewer writes than exist, it has stopped seeing them.
check(`the scan still sees the card writes (found ${stamped}, expected at least 25)`, stamped >= 25);
check('the exempt files are still the ones named here', exemptSeen.length <= EXEMPT.size);

console.log(`card-stamp-scan-golden: ${pass} passed, ${fail} failed (${stamped} stamped card writes)`);
process.exit(fail ? 1 : 0);
