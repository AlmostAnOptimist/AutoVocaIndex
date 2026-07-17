export function buildColors(theme) {
// Gold/silver metal trios retired in Phase B-1 — frames are theme-native now.
  const sh = { danger: '#c0553a', success: '#7a9e6e', warning: '#c9973a' };

  if (theme === 'clay') return { ...sh,
    bg: '#f5ede3', surface: '#fffaf5', raised: '#ffffff',
    border: '#e0d0be', borderB: '#c4a882',
    text: '#2e1f0f', textS: '#7a5a3a', textM: '#b89a7a',
    accent: '#b85f25', accentSoft: 'rgba(184,95,37,0.12)',
    accent2: '#4a8a7e', accent2Soft: 'rgba(74,138,126,0.12)',
    danger: '#b84030', success: '#3D7A66', warning: '#b88020',
    tL: '#2F7868', tLa: '#C4801E', tH: '#7D7A30', tF: '#8a6040',
    logoText: '#b85f25',
  };

  if (theme === 'baroque') return { ...sh,
    bg: '#0F332C', surface: '#153E36', raised: '#1C4B41',
    border: '#8A6D2A', borderB: '#D9A23C',
    text: '#F2E7CE', textS: '#C8C8BE', textM: '#7E9A8C',
    accent: '#E8A800', accentSoft: 'rgba(232,168,0,0.15)',
    accent2: '#24afba', accent2Soft: 'rgba(36,175,186,0.18)',
    accentText: '#2A1F00',
    danger: '#E05A46', success: '#4FB08A', warning: '#E8B02A',
    tL: '#3FBFA6', tLa: '#E8B84A', tH: '#B8C24E', tF: '#D98A5A',
    logoText: '#E8A800',
  };

  if (theme === 'koi') return { ...sh,
    bg: '#b4b4aa', surface: '#c8c8be', raised: '#dcdcd0',
    border: '#9a9a90', borderB: '#7a7a70',
    text: '#3a3a2a', textS: '#6a6a68', textM: '#8a8a80',
    accent: '#d4820a', accentSoft: 'rgba(212,130,10,0.15)',
    accent2: '#d4c48a', accent2Soft: 'rgba(212,196,138,0.25)',
    danger: '#c04030', success: '#3D7A5A', warning: '#b07820',
    tL: '#5a7890', tLa: '#C99A2E', tH: '#707828', tF: '#a07830',
    logoText: '#d4820a',
  };

  if (theme === 'feather') return { ...sh,
    bg: '#1a1008', surface: '#241808', raised: '#302010',
    border: '#402e18', borderB: '#5a4028',
    text: '#e8e0d0', textS: '#b8a888', textM: '#8c4a1f',
    accent: '#F5B800', accentSoft: 'rgba(245,184,0,0.12)',
    accent2: '#1a5c5a', accent2Soft: 'rgba(26,92,90,0.20)',
    danger: '#c04838', success: '#4A9678', warning: '#d4920a',
    tL: '#2A7868', tLa: '#E0922E', tH: '#A89A3E', tF: '#B8762A',
    logoText: '#F5B800',
  };

if (theme === 'hanok') return { ...sh,
    bg: '#3D3833', surface: '#47423E', raised: '#564F49',
    border: '#6B635A', borderB: '#847A6E',
    text: '#DBC5A0', textS: '#B8A888', textM: '#8C8275',
    accent: '#EBA955', accentSoft: 'rgba(235,169,85,0.18)',
    accent2: '#9E978D', accent2Soft: 'rgba(158,151,141,0.2)',
    danger: '#B8453A', success: '#5C8A6E', warning: '#D9963E',
    tL: '#7C9488', tLa: '#C4843A', tH: '#8A8040', tF: '#9C7A4A',
    logoText: '#EBA955',
  };

  if (theme === 'bauhaus') return { ...sh,
    bg: '#EBE4D2', surface: '#F5F0E4', raised: '#FFFFFF',
    border: '#D8CFB8', borderB: '#B5A988',
    text: '#221C18', textS: '#5C5248', textM: '#8C8070',
    accent: '#E9810A', accentSoft: 'rgba(233,129,10,0.15)',
    accent2: '#C6340C', accent2Soft: 'rgba(198,52,12,0.15)',
    danger: '#C81909', success: '#4A8C3E', warning: '#D4940A',
    tL: '#4A8C82', tLa: '#D4A01E', tH: '#9C9C1E', tF: '#8C5A2E',
    logoText: '#221C18',
  };

if (theme === 'blossom') return { ...sh,
    bg: '#EDE9E2', surface: '#F7F4ED', raised: '#FDFBF6',
    border: '#DDD3C6', borderB: '#B9998F',
    text: '#33241E', textS: '#75584C', textM: '#AB8F82',
    accent: '#ab3f4a', accentSoft: 'rgba(171,63,74,0.12)',
    accent2: '#738f63', accent2Soft: 'rgba(115,143,99,0.14)',
    danger: '#B84038', success: '#3D7A5A', warning: '#C08A2E',
    tL: '#3A8272', tLa: '#C08A2E', tH: '#8A8A34', tF: '#9C6A4E',
    logoText: '#ab3f4a',
  };

  // ember (default)
  return { ...sh,
    bg: '#1a1612', surface: '#231e19', raised: '#2e2720',
    border: '#3d3328', borderB: '#5a4a38',
    text: '#f0e6d6', textS: '#b89e85', textM: '#7a6655',
    accent: '#c97d3a', accentSoft: 'rgba(201,125,58,0.12)',
    accent2: '#8fb4a8', accent2Soft: 'rgba(143,180,168,0.12)',
    danger: '#c0553a', success: '#4F8C76', warning: '#c9973a',
    tL: '#5E9E8E', tLa: '#E0A83C', tH: '#8C8A3E', tF: '#b8896e',
    logoText: '#c97d3a',
  };
}