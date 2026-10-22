// src/utils/keyUtils.js
// U5: Enter that submits a field, as opposed to the Enter a Korean (or any
// IME) keyboard uses to finish the syllable it is still building. Leaf module.
//
// Chrome sends that Enter with isComposing set (often followed by a second,
// real Enter); Safari ends the composition first and then sends the Enter
// with keyCode 229. Acting on it adds the item with the unfinished syllable
// and leaves the syllable behind in the cleared box ("슈" after adding
// "물티슈"), or adds the item twice. A real Enter never has keyCode 229.

export function isComposingKey(e) {
  const n = e?.nativeEvent || e;
  return !!(n?.isComposing || n?.keyCode === 229 || e?.keyCode === 229);
}

export function isSubmitEnter(e) {
  return e?.key === 'Enter' && !isComposingKey(e);
}
