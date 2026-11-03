// src/utils/settingsLayout.js
// Settings page layout (ST1): which tab each setting appears on, grouped
// the way the sidebar groups pages. A setting more than one page uses is
// listed on each of those tabs; every copy edits the same value, so they
// stay in sync. Labels and descriptions live here too, so the tab panels
// and settings search read the same words.
// Pure module: no React, no Firebase, no page imports.

import { CATEGORIES } from '../constants.js';

// The default-category setting only means something with two or more task
// categories (the template ships with one; docs/08).
const TASK_SETTINGS = CATEGORIES.length > 1 ? ['defaultCat', 'sound'] : ['sound'];

export const SETTINGS_SECTIONS = [
  { id: 'general',  label: 'General',  tabs: ['general'] },
  { id: 'agenda',   label: 'Agenda',   tabs: ['agenda', 'appointments'] },
  { id: 'language', label: 'Language', tabs: ['content', 'flashcards', 'quizzes', 'avi'] },
];

// groups: [heading, [setting ids]]
export const SETTINGS_TABS = {
  general: {
    label: 'General', ko: '일반',
    lede: 'Your account, and the settings every page runs on.',
    groups: [['Account', ['account']], ['Every page', ['dayFlip', 'theme']]],
  },
  agenda: {
    label: 'Agenda', ko: '일정',
    lede: 'Today, Upcoming and Overdue: finishing tasks, and the review check on Today.',
    groups: [['Tasks', TASK_SETTINGS], ['Today’s checks', ['reviewCap']]],
  },
  appointments: {
    label: 'Appointments', ko: '예약',
    lede: 'The types offered in the appointment form, and the rates for costs entered in other currencies.',
    groups: [['Appointment types', ['apptTypes']], ['Costs', ['currency']]],
  },
  content: {
    label: 'Content Library', ko: '자료실',
    lede: 'When a quiet source moves from Active to Adrift, and the rates for source costs.',
    groups: [['Overview', ['adrift']], ['Costs', ['currency']]],
  },
  flashcards: {
    label: 'Flashcards', ko: '카드',
    lede: 'How reviews are scheduled, and the audio on each card.',
    groups: [
      ['Scheduling', ['reviewCap', 'retention', 'maxInterval', 'gradInterval', 'easyInterval', 'againCap']],
      ['Pronunciation audio', ['tts', 'ttsSpeed', 'autoTts', 'backfill']],
    ],
  },
  quizzes: {
    label: 'Quizzes', ko: '퀴즈',
    lede: 'Feedback sounds, and the speed of Echo prompts and Dictation.',
    groups: [['Sound and audio', ['quizSounds', 'ttsSpeed']]],
  },
  avi: {
    label: 'AutoVocaIndex', ko: '어휘',
    lede: 'Where definitions come from, how lists sort, and what imports strip out.',
    groups: [
      ['Definitions', ['dictMode']],
      ['Lemma Master and Overview', ['lemmaSort', 'overviewDisplay']],
      ['Imports', ['tts', 'autoTts', 'noise']],
      ['Search', ['stopwords']],
    ],
  },
};

// label, desc (static part), kw (extra search words)
export const SETTING_META = {
  account:        { label: 'Account', desc: 'The account the app syncs to.', kw: 'sign out email sync signed in' },
  dayFlip:        { label: 'Day-flip time', desc: 'Tasks, reviews and logs stay on the current day until this hour, for late nights.', kw: 'midnight night owl day start hour' },
  theme:          { label: 'Theme', desc: 'Colours and frames across the app.', kw: 'appearance colour color dark light' },
  defaultCat:     { label: 'Default task category', desc: 'Preselected when you add a task.', kw: 'new task category' },
  sound:          { label: 'Completion sound', desc: 'Plays when you check off a task. Tap one to hear it.', kw: 'audio chirp warble click silent check off' },
  reviewCap:      { label: 'Daily review cap', desc: 'Forecast days above this many flashcard reviews are flagged as spikes. Default 80.', kw: 'spike forecast reviews limit srs' },
  apptTypes:      { label: 'Appointment types', desc: 'Your own types, shown beside the built-in ones in the appointment form.', kw: 'custom tutoring class exchange' },
  currency:       { label: 'Exchange rates', desc: 'All amounts are stored in KRW. These rates convert costs entered in USD and EUR.', kw: 'usd eur krw won rate currency cost' },
  adrift:         { label: 'Days until Adrift', desc: 'Sources with no activity for this many days move to the Adrift column on the Overview.', kw: 'active adrift overview library' },
  retention:      { label: 'Desired retention', desc: 'Target chance of recalling a card when it comes due. Higher means more frequent reviews. Default 90%.', kw: 'fsrs recall probability' },
  maxInterval:    { label: 'Maximum interval', desc: 'Longest gap between reviews, in days. Default 1095 (3 years).', kw: 'fsrs days longest' },
  gradInterval:   { label: 'Graduating interval', desc: 'First gap, in days, when a new card graduates with Hard or Good. Default 1.', kw: 'fsrs new card' },
  easyInterval:   { label: 'Easy interval', desc: 'First gap, in days, when a new card graduates with Easy. Default 3.', kw: 'fsrs new card' },
  againCap:       { label: 'Again cap', desc: 'Times a card can come back after Again in one session before it carries over to the next. Default 2.', kw: 'fsrs session requeue' },
  tts:            { label: 'Pronunciation audio', desc: 'Shows a speaker button on cards that have audio.', kw: 'tts audio speaker korean' },
  ttsSpeed:       { label: 'Playback speed', desc: 'For card audio, Echo audio prompts and Dictation.', kw: 'tts audio speed echo dictation' },
  autoTts:        { label: 'Audio after imports', desc: 'After a sentence-mode import commits, audio for the new sentences is generated in the background so cards play right away.', kw: 'tts import automatic' },
  backfill:       { label: 'Generate missing audio', desc: 'Creates audio for every card that has none.', kw: 'tts backfill generate' },
  quizSounds:     { label: 'Quiz sounds', desc: 'Right and wrong feedback, finish sounds and clicks during quizzes.', kw: 'audio feedback correct wrong' },
  dictMode:       { label: 'Dictionary mode', desc: 'Where Definition 1 comes from for new words and lemmas. API keys are Netlify environment variables and can’t be edited here.', kw: 'krdict claude api definition def1' },
  lemmaSort:      { label: 'Lemma Master order', desc: 'How the Lemma Master list sorts when it opens.', kw: 'sort recent alphabetical' },
  overviewDisplay:{ label: 'Overview counts', desc: 'What the AVI Overview shows.', kw: 'word sentence sourceless count' },
  noise:          { label: 'E-book noise patterns', desc: 'Text stripped from pasted content before it’s processed. Put a line with only --- between patterns; a pattern can span several lines, which helps with e-reader watermarks.', kw: 'import strip watermark paste ebook' },
  stopwords:      { label: 'Stopwords', desc: 'Extra words ignored when Search matches by meaning, on top of the built-in list.', kw: 'search ignore meaning english' },
};

export const DEFAULT_SETTINGS_TAB = 'general';

export const sectionOfTab = (tab) =>
  (SETTINGS_SECTIONS.find(s => s.tabs.includes(tab)) || SETTINGS_SECTIONS[0]).id;

// Every tab a setting appears on, in tab-bar order.
export function tabsOfSetting(id) {
  return SETTINGS_SECTIONS.flatMap(s => s.tabs)
    .filter(t => SETTINGS_TABS[t].groups.some(([, ids]) => ids.includes(id)));
}

export const settingCount = (tab) =>
  (SETTINGS_TABS[tab]?.groups || []).reduce((n, [, ids]) => n + ids.length, 0);

// Each setting once, in tab-bar order, matched against its label,
// description, search words and the names of the tabs it appears on.
export function searchSettings(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const seen = [];
  SETTINGS_SECTIONS.flatMap(s => s.tabs).forEach(t =>
    SETTINGS_TABS[t].groups.forEach(([, ids]) => ids.forEach(id => { if (!seen.includes(id)) seen.push(id); })));
  return seen.filter(id => {
    const m = SETTING_META[id];
    if (!m) return false;
    const hay = [m.label, m.desc, m.kw, ...tabsOfSetting(id).map(t => SETTINGS_TABS[t].label)].join(' ').toLowerCase();
    return q.split(/\s+/).every(w => hay.includes(w));
  });
}
