const uniqueCharacters = (value) => [...new Set(Array.from(value || ''))]

export function assessFontReplacement(font, replacementText) {
  if (!font) {
    return {
      supported: false,
      missingCharacters: uniqueCharacters(replacementText),
      reason: 'Font metadata is unavailable for the selected text run.',
    }
  }

  if (!font.canNativeReplace) {
    return {
      supported: false,
      missingCharacters: uniqueCharacters(replacementText),
      reason: font.limitations?.[0] || 'This font encoding is not supported for native text replacement.',
    }
  }

  const supported = new Set(font.supportedCharacters || [])
  const missingCharacters = uniqueCharacters(replacementText).filter((character) => !supported.has(character))

  return {
    supported: missingCharacters.length === 0 && Boolean(String(replacementText || '').length),
    missingCharacters,
    reason: missingCharacters.length
      ? `The embedded font does not contain ${missingCharacters.length} replacement character(s): ${missingCharacters.join(' ')}`
      : String(replacementText || '').length
        ? ''
        : 'Replacement text cannot be empty.',
  }
}

export function getFontStyleLabel(font) {
  if (!font) return 'Unknown'
  if (font.isBold && font.isItalic) return 'Bold Italic'
  if (font.isBold) return 'Bold'
  if (font.isItalic) return 'Italic'
  return 'Regular'
}
