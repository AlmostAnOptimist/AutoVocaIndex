// src/utils/decoAssets.js
// Deco image assets resolved via import.meta.glob so the build succeeds even
// when the asset files are absent (the template repository commits no image
// assets). Each export is the bundled URL string, or null when the file is
// missing; render sites fall back to a themed placeholder block using
// decoBlockStyle below. Leaf module: imports nothing.

const globbed = import.meta.glob('../assets/*.png', { eager: true, import: 'default' });
const pick = (name) => globbed[`../assets/${name}`] ?? null;

export const birbSrc        = pick('birbs.png');
export const crowSrc        = pick('perched_crow_Deco.png');
export const decoDividerSrc = pick('DecoDividerPanel_gold.png');

// Placeholder block rendered where a deco image would sit — the same
// diagonal hatch treatment the Gazette components already use.
export const decoBlockStyle = (C) => ({
  backgroundImage: `repeating-linear-gradient(135deg, ${C.accent}1A 0 10px, ${C.accent}0A 10px 20px)`,
  border: `1px solid ${C.border}`,
});