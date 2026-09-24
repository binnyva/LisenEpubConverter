import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import { normalizeNonBreakingSpaces } from '../util/text.js';

/**
 * Convert one XHTML chapter to audio-friendly Markdown:
 * - images become "Image: <alt>." sentences (dropped when there is no alt text)
 * - links keep only their text; pure footnote-marker links (e.g. "[1]") are dropped
 * - headings, lists and emphasis stay as plain markdown
 */
export function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, head title, link, meta').remove();

  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    emDelimiter: '*',
  });

  turndown.addRule('images', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = (node as HTMLElement).getAttribute?.('alt')?.trim();
      return alt ? `\n\nImage: ${alt}.\n\n` : '';
    },
  });

  turndown.addRule('links', {
    filter: 'a',
    replacement: (content) => {
      const text = content.trim();
      // Footnote/reference markers like "1", "[2]", "*" add nothing to audio.
      // (turndown escapes brackets, so strip backslashes before testing.)
      if (/^\[?[\d*†‡]+\]?$/.test(text.replace(/\\/g, ''))) return '';
      return text;
    },
  });

  // <figure>/<figcaption>: keep the caption text.
  turndown.addRule('figcaption', {
    filter: ['figcaption'],
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });

  const body = $('body').html() ?? html;
  return normalizeNonBreakingSpaces(
    turndown
    .turndown(body)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  );
}

/**
 * Strip markdown syntax from a script segment so TTS never reads "#" or "*".
 * Used as a safety net right before synthesis.
 */
export function markdownToSpeakable(md: string): string {
  return normalizeNonBreakingSpaces(md)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*(\d+)\.\s+/gm, '$1. ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
