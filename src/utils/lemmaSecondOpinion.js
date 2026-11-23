// src/utils/lemmaSecondOpinion.js
// Gives the lemma resolver (aviUtils.js) the Korean analyser as a second
// opinion (LM4). Imported once, by App.jsx, for its side effect. Nothing is
// loaded here: the analyser's files are fetched the first time a word is
// resolved, from the copy saved on the device, and a failed or slow load
// leaves the resolver on its rules alone.
//
// Kept out of aviUtils.js so that file stays free of the analyser (its
// tests run in plain Node, and AutoVocaIndex shares it without one).

import { setLemmaSecondOpinion } from './aviUtils.js';
import { loadAnalyser } from './koreanAnalyser.js';
import { analyserReadings } from './analyserLemma.js';

setLemmaSecondOpinion(async (surface, context) => analyserReadings(await loadAnalyser(), surface, context));
