// tests/card-factory-golden.mjs
// Golden test for card creation in AVI, src/utils/cardFactory.js (audit OF2):
// a new card must not wait on the network, and making that so must not bring
// back duplicate cards or decks.
//
// Run from the repo root:   node tests/card-factory-golden.mjs   (or: npm test)
// Firebase and the audio helpers are replaced by stand-ins
// (bundle-with-stub.mjs); nothing here reads or writes Firestore or calls
// the audio function. Exits 1 on any failure.

import { bundleWithStub } from './bundle-with-stub.mjs';

process.env.TZ = 'Asia/Seoul';
const { mod, cleanup } = await bundleWithStub('src/utils/cardFactory.js', `
  let n = 0;
  export const db = {};
  export const auth = { currentUser: null };
  export const collection = (_db, ...path) => ({ path: path.join('/') });
  export const doc = (first, ...path) => (first && first.path !== undefined && path.length === 0
    ? { path: first.path + '/new' + (++n), id: 'new' + n }
    : { path: path.join('/'), id: path[path.length - 1] });
  export const setDoc    = (ref, data) => globalThis.__fs.write('set', ref, data);
  export const updateDoc = (ref, data) => globalThis.__fs.write('update', ref, data);
  export const increment  = (by) => ({ __increment: by });
  export const arrayUnion = (...v) => ({ __union: v });
  export const serverTimestamp = () => ({ __serverTime: true });
  // Imported by modules the factory pulls in; never called here.
  const unused = () => { throw new Error('not expected in this test'); };
  export const writeBatch = unused, getDocs = unused, getDoc = unused, query = unused, where = unused,
    deleteDoc = unused, addDoc = unused, deleteField = unused, arrayRemove = unused, onSnapshot = unused,
    getDocsFromServer = unused, getDocFromServer = unused, limit = unused, orderBy = unused, documentId = unused;
`, {
  './ttsUtils.js': `
    export const generateVocabCardAudio = (a) => { globalThis.__audio.push(a.cardId); };
    export const generateSentenceCardAudio = (a) => { globalThis.__audio.push(a.cardId); };
  `,
});
const { autoCreateWordCard, autoCreateSentenceCard } = mod;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
async function quiet(fn) {
  const { error, warn } = console;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = error; console.warn = warn; }
}
const STUCK = Symbol('stuck');
const settle = (p, ms = 150) => Promise.race([p, new Promise(r => setTimeout(() => r(STUCK), ms))]);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// A stand-in Firestore. mode 'ok': writes succeed; 'hang': they never come
// back (offline); 'refuse': they are rejected.
function firestore(mode = 'ok') {
  const log = [];
  globalThis.__audio = [];
  globalThis.__fs = {
    write: (op, ref, data) => {
      log.push({ op, path: ref.path, data });
      if (mode === 'hang') return new Promise(() => {});
      if (mode === 'refuse') return Promise.reject(new Error('refused'));
      return Promise.resolve();
    },
  };
  return log;
}
// The app's card and deck lists, as the pages hold them. `cards` and `decks`
// are the copies a page captured before the burst (they go stale on purpose).
// Each case gets its own user id, so one case's creations (which stay on
// record for a moment, see HOLD_MS in cardFactory.js) can't answer another's.
let users = 0;
function app(decks = [], cards = []) {
  const state = { decks, cards };
  const uid = `u${++users}`;
  return {
    state,
    args: (extra) => ({
      uid, dsh: 3, lemmaMaster: [], aviSources: [],
      cards, decks,
      updateCards: (u) => { state.cards = typeof u === 'function' ? u(state.cards) : u; },
      updateDecks: (u) => { state.decks = typeof u === 'function' ? u(state.decks) : u; },
      ...extra,
    }),
  };
}
const word = (lemma, source = 'Book A') => ({ lemma, def2: 'meaning', source });
const sent = (targetWord, sentence, source = 'Book A') => ({ targetWord, sentence, cardBack: 'back', source });

// 1. Online, as before: one card, its deck, the deck's count, audio asked for.
{
  const log = firestore('ok');
  const a = app();
  const id = await autoCreateWordCard(a.args({ entry: word('가다') }));
  check('online: the card and its deck exist in memory',
    [a.state.cards.map(c => [c.id, c.lemma, c.deckIds.length]), a.state.decks.map(d => [d.name, d.totalCards])],
    [[[id, '가다', 1]], [['Book A', 1]]]);
  check('online: three writes (deck, card, deck count)', log.map(w => w.op), ['set', 'set', 'update']);
  check('online: audio asked for the new card', globalThis.__audio, [id]);
}

// 2. Offline: writes never come back. Creation must still finish.
{
  const log = firestore('hang');
  const a = app();
  const id = await settle(autoCreateWordCard(a.args({ entry: word('가다') })));
  check('offline: creating a word card finishes', id === STUCK ? 'stuck' : typeof id, 'string');
  check('offline: the card and deck are in memory at once',
    [a.state.cards.length, a.state.decks.map(d => [d.name, d.totalCards])], [1, [['Book A', 1]]]);
  check('offline: the writes were started (Firestore keeps them for later)', log.map(w => w.op), ['set', 'set', 'update']);
  const sid = await settle(autoCreateSentenceCard(a.args({ entry: sent('가다', '학교에 가요.'), decks: a.state.decks })));
  check('offline: creating a sentence card finishes', sid === STUCK ? 'stuck' : typeof sid, 'string');
  check('offline: sentence card in its own deck',
    a.state.decks.map(d => [d.name, d.totalCards]), [['Book A', 1], ['Book A (sentence mining)', 1]]);
}

// 3. No duplicates. Every caller in a burst holds the same out-of-date lists.
{
  firestore('hang');
  const a = app();
  const ids = await Promise.all([1, 2, 3].map(() => settle(autoCreateWordCard(a.args({ entry: word('가다') })))));
  check('burst of three at once: one card, one deck', [new Set(ids).size, a.state.cards.length, a.state.decks.length], [1, 1, 1]);
}
{
  // A second call a moment later, from a page that hasn't re-rendered yet.
  // The network used to hold the first call open long enough to cover this.
  firestore('ok');
  const a = app();
  const first = await autoCreateWordCard(a.args({ entry: word('가다') }));
  await wait(60);
  const second = await autoCreateWordCard(a.args({ entry: word('가다') }));
  check('a moment later, same out-of-date lists: still one card', [second === first, a.state.cards.length, a.state.decks.length], [true, 1, 1]);
  const other = await autoCreateWordCard(a.args({ entry: word('오다') }));
  check('a different word right after: its own card, the same deck', [other !== first, a.state.cards.length, a.state.decks.length, a.state.decks[0].totalCards], [true, 2, 1, 2]);
}
{
  firestore('ok');
  const a = app();
  const s1 = await autoCreateSentenceCard(a.args({ entry: sent('가다', '학교에 가요.') }));
  await wait(60);
  const s2 = await autoCreateSentenceCard(a.args({ entry: sent('가다', '학교에 가요.') }));
  const s3 = await autoCreateSentenceCard(a.args({ entry: sent('가다', '집에 가요.') }));
  check('sentences: same sentence once, another sentence its own card', [s2 === s1, s3 !== s1, a.state.cards.length, a.state.decks.length], [true, true, 2, 1]);
}

// 4. The hold ends: a card deleted later can be made again.
{
  firestore('ok');
  const a = app();
  const first = await autoCreateWordCard(a.args({ entry: word('가다') }));
  await wait(2300);
  a.state.cards = [];                                   // deleted in the meantime
  const again = await autoCreateWordCard(a.args({ entry: word('가다'), decks: a.state.decks, cards: [] }));
  check('after the hold: a deleted card is created afresh', [again !== first, a.state.cards.length, a.state.decks.length], [true, 1, 1]);
}

// 5. A write the server refuses is logged, never thrown at the page.
await quiet(async () => {
  firestore('refuse');
  const a = app();
  let threw = false, id = null;
  try { id = await autoCreateWordCard(a.args({ entry: word('가다') })); } catch { threw = true; }
  await wait(10);
  check('refused writes: no error reaches the page', [threw, typeof id], [false, 'string']);
});

// 6. Guards unchanged: no def2, skipped, or already in the deck.
{
  const log = firestore('ok');
  const a = app([{ id: 'd1', name: 'Book A', totalCards: 1 }], [{ id: 'c1', lemma: '가다', deckIds: ['d1'] }]);
  check('no card without a def2, for a skipped row, or signed out; an existing card is returned',
    [await autoCreateWordCard(a.args({ entry: { lemma: '오다', source: 'Book A' } })),
     await autoCreateWordCard(a.args({ entry: { ...word('오다'), skipUpload: true } })),
     await autoCreateWordCard(a.args({ entry: word('오다'), uid: null })),
     await autoCreateWordCard(a.args({ entry: word('가다') })), log.length],
    [null, null, null, 'c1', 0]);
}

await cleanup();
console.log(`card-factory-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
