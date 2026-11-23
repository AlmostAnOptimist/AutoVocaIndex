// src/theme/themeCoverage.js
// How much of the screen each colour token covers, in percent, for the
// Appearance tab's coverage bars. Measured Nov 15, 2026 on the app this
// template is taken from: every main page (Today, Upcoming, Overdue,
// Appointments, Grammar Index, Content Library, Flashcards, Quizzes,
// AutoVocaIndex, Settings, and a few pages the template doesn't have)
// rendered at 1440x900 and 390x844 with each token
// swapped for its own test colour, then pixels counted per token; softened
// text edges and tints are credited back to the token they came from.
// Every theme shares one layout, so one measurement serves all of them.
// Re-measured with a headless-browser harness kept outside this repo
// when layouts change a lot. Data only: no imports.

export const THEME_COVERAGE = {
  desktop: { bg: 54.934, surface: 24.848, raised: 17.048, border: 1.069, borderB: 0.175, text: 0.317, textS: 0.328, textM: 0.158, accentText: 0.026, accent: 0.314, accentSoft: 0.605, accent2: 0.067, accent2Soft: 0.005, logoText: 0.027, danger: 0.028, success: 0.003, warning: 0.003, tLa: 0.018, tL: 0.009, tH: 0.01, tF: 0.007 },
  phone:   { bg: 55.721, surface: 19.808, raised: 20.35, border: 1.336, borderB: 0.404, text: 0.787, textS: 0.426, textM: 0.474, accentText: 0.026, accent: 0.393, accentSoft: 0.036, accent2: 0.047, accent2Soft: 0.018, logoText: 0.006, danger: 0.033, success: 0.001, warning: 0.011, tLa: 0.056, tL: 0.025, tH: 0.022, tF: 0.02 },
};
