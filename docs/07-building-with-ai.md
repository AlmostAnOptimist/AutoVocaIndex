# Building with AI

This template was itself built substantially through AI-assisted development, and this document is the distilled working protocol from that process: what to feed an assistant, what practices to demand from it, how to verify its work, and the guardrails that keep a non-programmer out of trouble. If you can describe what you want and follow a checklist, you can modify anything in AVI — the protocol below is what makes that safe rather than hopeful.

One mindset note before the mechanics: an AI assistant is a power tool, not a contractor. It's extremely good at mechanical work and pattern-following, confidently wrong just often enough to matter, and it has no memory of the incidents that shaped this codebase's rules. *You* carry the rules; the assistant supplies the labor.

---

## What to feed it, and in what order

The documentation you're reading is a prompt kit — feed it before code. Two documents are the standing openers for any change:

1. **The data model guide (03).** Firestore is schemaless: nothing enforces the collection shapes except the code, which means the data model document *is* the contract. An assistant that hasn't read it will invent plausible-looking fields, write `undefined` where `null` belongs, and break readers it never saw.
2. **The architecture guide (02).** The module layers, the three data-access styles, and the leaf-module rule — an assistant needs the map before it can place new code correctly.

Add **the decisions-and-gotchas guide (06)** whenever the change touches anything it covers — and skim it yourself first, because you're the one who has to notice when the assistant is about to walk into a documented trap or "fix" a documented decision.

Then add the specific files. Recipes for the common change types:

| Change | Feed |
|---|---|
| Styling / UI tweak | The page file, `buildStyles.js`, the theming guide (09) |
| New field on an existing collection | 03's section for that collection, plus every file 03 names as its writer or reader; state the null-safe-default rule explicitly |
| New page | One existing page of the same kind as the pattern to copy, `App.jsx` (navigation and props), 02's layer rules |
| New collection / new module | 03's "Extending the model" section — the rules wildcard already covers new subcollections |
| Dictionary, fonts, heuristics, another language | The language-conversion guide (08) — it states each replacement's contract |
| Themes | The theming guide (09) alone usually suffices |

Paste documents and files into the conversation, or point the assistant at the repo if your tool reads files directly. Either way, the order stands: contract, map, gotchas, then code.

## The working protocol

These six practices are non-negotiable. They exist because their absence caused real incidents during development — duplicated exports, silently lost function bodies, edits applied to code that had changed since the assistant last saw it.

1. **Read before write.** The assistant must look at the actual current file and quote the code it intends to change before proposing any edit. Never accept an edit written from memory of an earlier state of the file, and never assume a previous edit landed exactly as written — re-read.
2. **Investigate, report, sign off, then implement.** For anything non-trivial, the assistant first investigates and reports findings and a plan; you approve before code is written. Assumptions get surfaced as questions, not silently baked in.
3. **Surgical edits only.** Changes are delivered as find-and-replace blocks with enough surrounding context to be unique — never as full-file replacements. Full-file pastes are where whole functions vanish.
4. **Exactly-once matching.** Every find block must match the file exactly once. If a find block doesn't match, the correct response is *stop and report* — never "adapt it by hand," which applies an edit to code the assistant didn't actually see.
5. **Syntax gates before delivery.** The assistant should parse-check edited files (or at minimum verify bracket/brace balance didn't change unexpectedly) before handing them over — and `npm run build` is your own backstop.
6. **One stage at a time.** Break multi-part work into named stages; apply, build, and verify each stage before starting the next. A pile of unverified changes is how you lose an afternoon to archaeology.

You can hand the assistant this working agreement verbatim at the start of a session:

> Before proposing any change, read the actual current file contents and quote what you'll modify. Deliver changes as find-and-replace blocks with unique context anchors — never full-file replacements. If a find block doesn't match exactly once, stop and tell me instead of adapting. Work in named stages; after each stage I'll build and verify before we continue. Surface assumptions as questions before implementing. Never write `undefined` to Firestore, follow the conventions in the data model doc, and flag anything that touches an item in the decisions-and-gotchas doc.

## Verifying a change

After each stage: `npm run build` must pass; run `netlify dev` and click through the flow you changed (a blank page with a `Cannot access ... before initialization` console error means an import cycle — see the gotchas guide); and if the change touched imports at all, run the cycle gate:

```
npx madge --circular --extensions js,jsx src/
```

For anything that writes data, verify the write in the Firestore console once — field names, `null` where you expect it, nothing missing that an `undefined` would explain.

## Guardrails

**Never paste secrets into a chat.** Not `.env` contents, not the service-account JSON, not API keys. Assistants don't need real values to write code — `process.env.WHATEVER` is the point. If a tool has direct file access to your working directory, that access includes `.env`; know your tool's data handling before granting it.

**Don't let an assistant "clean up" `firestore.rules`.** The shipped rules are deliberately minimal, and the recursive wildcard means new subcollections under `users/{uid}` need *no rules change at all* — an assistant that helpfully adds per-collection rules is adding surface area for lockout bugs. Any rules change: read the data model guide's rules section first, and test sign-in plus one read and one write immediately after deploying.

**`seed/` is untouchable, especially `updatedAt`.** The gotchas guide explains why: the lemma map's trust gate keys on those timestamps, and a well-meaning "refresh the timestamps" or "reformat the JSON" pass can promote every machine-generated junk row to trusted in one stroke.

**Respect the documented decisions.** The `.cjs` extensions, the frozen `isMobile`, the pipe delimiter, the fixed-palette logo, the direct-Firestore non-goal — each is tagged as a *decision* in the gotchas guide precisely so an assistant's tidying instinct doesn't undo it. When an assistant proposes changing something 06 documents, that's your cue to stop and read the entry.

**Secrets live in functions, full stop.** No change should ever move an API key into client code, localStorage, or Firestore. (The Firebase web config is the one exception — it's public by design.)

## The proxy problem — read this before wiring AI into anything

Here is the trap, stated plainly: **a Netlify function is a public URL.** There is no login in front of it. If a function takes a request and forwards it to a paid API with your key, then anyone who discovers the URL — and deployed site URLs do get discovered — can spend your money with it. An earlier general-purpose Anthropic passthrough was deleted from this project's ancestor for exactly this reason.

Judge any endpoint you add (or keep) on two axes: *how much can one call cost*, and *who can call it*. That gives three tiers:

1. **Bounded and single-purpose.** The endpoint builds its own request server-side: pinned model, capped tokens, fixed prompt shape, client supplies only the minimal input. Worst case, a stranger burns small amounts on your fixed task. Both shipped Anthropic endpoints live here, and are the pattern to copy for anything you add: `get-definition` (fixed persona, pinned Haiku model, 1024-token cap; the client sends only the lemma) and `grammar-quiz` (owns all four prompt templates server-side; pinned model, 4000-token cap; every request field validated and length-capped, malformed requests rejected before any API call is made).
2. **Unbounded passthrough — never acceptable unauthenticated.** A function that forwards the caller's request body to the API unexamined lets the caller choose the model, the token count, and the prompt — it *is* the open proxy, whatever its filename. This isn't hypothetical for this codebase: an ancestor endpoint shipped exactly this shape and was deleted, and `grammar-quiz` itself started as a verbatim passthrough before being constrained into tier 1. The test is simple: if any part of the paid API request reaches the provider without the function having built or validated it, rewrite before deploying.
3. **Authenticated general endpoints.** If you genuinely want a flexible AI endpoint, gate it on the same Firebase sign-in the app already has. The recipe: the client attaches its ID token (`await auth.currentUser.getIdToken()`) as a header, and the function verifies it with `firebase-admin` before doing anything:

```js
// netlify/functions/your-endpoint.cjs (sketch)
const { getAuth } = require('firebase-admin/auth');
// initialize firebase-admin once, with service-account credentials from
// env vars — the split-credential pattern in the gotchas guide; never
// commit or paste the JSON.

exports.handler = async (event) => {
  const token = (event.headers.authorization || '').replace(/^Bearer /, '');
  try { await getAuth().verifyIdToken(token); }
  catch { return { statusCode: 401, body: 'Unauthorized' }; }
  // ...now build and send the pinned, capped API request
};
```

Even authenticated, keep the model pinned and the tokens capped — authentication limits *who*, caps limit *how much*.

## What assistants do well here — and where to slow down

**Reliably good:** mechanical multi-file edits (renames, adding a field with a default everywhere it's read), new pages cloned from an existing pattern, styling and theme work, pure functions and engines (the easiest code in the tree to specify and test), and writing the boring parts of anything.

**Slow down and verify line-by-line:** the security rules, the auth flow, anything in `seed/`, the two sync layers (the diff logic and delete-all guard are subtle and load-bearing), the lemma-resolution cascade and trust gate, the serverless functions, and anything the gotchas guide tags as a decision. None of these are off-limits — the resolution cascade was itself built this way — but they're where "plausible" and "correct" diverge most, so they get the full protocol: investigate, report, sign off, stage, verify.

The honest summary: with the documents as context and the protocol enforced, an assistant can take you from "I wish AVI did X" to a working, verified change without you writing a line yourself. The protocol is not overhead — it's the difference between that experience and debugging a mystery at midnight.
