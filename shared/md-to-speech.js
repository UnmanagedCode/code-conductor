// Convert markdown-formatted text to clean spoken prose for TTS synthesis.
// Strips syntax characters (bold markers, backticks, list bullets, etc.) so
// Piper doesn't read them aloud. Only the audio text is affected — visual
// rendering always uses the original buffer.
export function mdToSpeech(text) {
  if (typeof text !== 'string') return '';

  // 1. Fenced code blocks — replace entire block with a short placeholder.
  //    Reading code aloud is unintelligible; the placeholder tells the listener
  //    that code was present.
  text = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '(code block)');

  // 2. Indented code blocks (4 spaces or tab — rare in assistant output).
  text = text.replace(/^(?:    |\t).+/gm, '(code block)');

  // 3. Inline code — speak the content, drop the backticks.
  text = text.replace(/`([^`\n]+)`/g, '$1');

  // 4. Headings — drop the # markers, keep the heading text.
  text = text.replace(/^#{1,6}\s+(.+)/gm, '$1');

  // 5. Bold/strong.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/__([^_\n]+)__/g, '$1');

  // 6. Italic/emphasis.
  text = text.replace(/\*([^*\n]+)\*/g, '$1');
  // Underscore italic: require word boundary so variable_names aren't mangled.
  // Note: in JS regex, _ is a word char (\w), so \b matches at _-to-space edges.
  text = text.replace(/\b_([^_\n]+)_\b/g, '$1');

  // 7. Strikethrough.
  text = text.replace(/~~([^~\n]+)~~/g, '$1');

  // 8. Images — speak alt text if present, else drop entirely.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => alt.trim() || '');

  // 9. Links — speak link text, drop the URL.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // 10. Unordered list bullets.
  text = text.replace(/^[ \t]*[-*+]\s+/gm, '');

  // 11. Ordered list numbers.
  text = text.replace(/^[ \t]*\d+\.\s+/gm, '');

  // 12. Blockquotes — strip leading > characters.
  text = text.replace(/^>+\s?/gm, '');

  // 13. Horizontal rules.
  text = text.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, '');

  // 14. Table separator rows (|---|---| style).
  text = text.replace(/^\|?[\s\-|:]+\|[\s\-|:]+\|?\s*$/gm, '');
  // Table data rows — strip pipes, join cells with em-dash.
  text = text.replace(/^\|(.*)\|\s*$/gm, (_, row) =>
    row.split('|').map(c => c.trim()).filter(Boolean).join(' — ')
  );

  // 15. HTML tags.
  text = text.replace(/<[^>]+>/g, '');

  // 16. Collapse 3+ consecutive newlines down to two.
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
