export const CATEGORIES = [
  // [LANG-SPECIFIC] UI label for the study category (docs/08)
  { id: 'lang',    label: '한국어', color: (C) => C.tLa },
];

export const RECUR_TYPES = [
  { id: 'none',                     label: 'None'                        },
  { id: 'daily',                    label: 'Daily'                       },
  { id: 'specific_days',            label: 'Specific Days'               },
  { id: 'twice_weekly',             label: 'Twice Weekly'                },
  { id: 'biweekly',                 label: 'Every 2 Weeks'               },
  { id: 'every_n_days',             label: 'Every N Days'                },
  { id: 'monthly_date',             label: 'Monthly (Date)'              },
  { id: 'monthly_relative',         label: 'Monthly (Relative)'          },
  { id: 'every_x_months_on_date',   label: 'Every X Months (Date)'       },
  { id: 'every_x_months_on_weekday',label: 'Every X Months (Weekday)'    },
  { id: 'yearly',                   label: 'Yearly'                      },
];

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKS = ['first', 'second', 'third', 'last'];
export const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

export const THEME_KEY   = 'avi_theme';
export const SOUND_KEY      = 'avi_sound';
export const QUIZ_SOUND_KEY = 'avi_quiz_sounds';
export const STORAGE_KEY = 'avi_v1';

export const THEME_DEFS = [
  { id: 'ember',   name: 'Ember',      desc: 'Warm dark — amber & rust',         sw: ['#1a1612','#c97d3a','#8fb4a8','#3d2a1a'] },
  { id: 'clay',    name: 'Clay',       desc: 'Warm light — terracotta',          sw: ['#f5ede3','#b85f25','#4a8a7e','#f7e4d4'] },
{ id: 'baroque', name: 'Baroque',    desc: 'Gilded viridian — peacock & gold', sw: ['#0F332C','#E8A800','#24afba','#153E36'] },
  { id: 'koi',     name: 'Koi Rush',   desc: 'Muted stone & warmth',             sw: ['#b4b4aa','#d4820a','#d4c48a','#3a3a2a'] },
  { id: 'feather', name: 'Feather',    desc: 'Mustard gold & pearl',             sw: ['#1a1008','#F5B800','#1a5c5a','#302010'] },
  { id: 'hanok',   name: 'Hanok Dusk', desc: 'Korean roof-tile & ginkgo gold',   sw: ['#3D3833','#EBA955','#9E978D','#564F49'] },
  { id: 'bauhaus', name: 'Bauhaus Sun', desc: 'Cream & poster orange',          sw: ['#EBE4D2','#E9810A','#C6340C','#FFFFFF'] },
  { id: 'blossom', name: 'Blossom Mist', desc: 'Spring fog, petal rose & moss', sw: ['#EDE9E2','#ab3f4a','#738f63','#F7F4ED'] },
];

export const NAV_SECTIONS = [
  { label: 'Agenda', items: [
    { id: 'today',       label: 'Today'           },
    { id: 'upcoming',    label: 'Upcoming'        },
    { id: 'overdue',     label: 'Overdue',  badgeDanger: true },
    { id: 'appointments', label: 'Appointments' },
  ]},
  { label: 'Language', items: [
    { id: 'grammar',    label: 'Grammar Index' },
    { id: 'content',    label: 'Content Library' },
    { id: 'flashcards', label: 'Flashcards' },
    { id: 'quizzes',    label: 'Quizzes' },
    { id: 'avi',        label: 'AutoVocaIndex' },
  ]},
];

export const PAGE_TITLES = {
  today: 'Today', upcoming: 'Upcoming', overdue: 'Overdue', appointments: 'Appointments',
  grammar: 'Grammar Index',
  content: 'Content Library', flashcards: 'Flashcards',
  quizzes: 'Quizzes', avi: 'AutoVocaIndex',
  settings: 'Settings',
};

// ── Grammar: mastery levels (Grammar Index, Grammar Deck, card picker) ─
export const GRAMMAR_MASTERY = {
  introduced: { label: 'Introduced', color: '#8A8275' },
  practicing: { label: 'Practicing', color: '#A8763A' },
  confident:  { label: 'Confident',  color: '#C9971F' },
  mastered:   { label: 'Mastered',   color: '#F7D774' },
};

export const SOUND_OPTIONS = [
  { id: 'chirp',      label: 'Chirp',       desc: 'Quick upward glide — a single bright bird note' },
  { id: 'warble',     label: 'Warble',      desc: 'Two-note ascending call — like a small songbird' },
  { id: 'click_tone', label: 'Click + Tone',desc: 'Tactile click followed by a warm note'          },
  { id: 'none',       label: 'Silent',      desc: 'No sound effects'                               },
];


// ── Appointment types keyed by category ───────────────────────
export const APPOINTMENT_TYPES = {
  lang:    ['Tutoring', 'Class', 'Language Exchange', 'Other'],
};
