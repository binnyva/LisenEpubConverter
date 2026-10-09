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

/** Convert HTML to paragraph-preserving plain text for annotation. */
export function htmlToPlainText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, link, meta').remove();
  $('img').each((_index, node) => {
    const alt = $(node).attr('alt')?.trim();
    $(node).replaceWith(alt ? `Image: ${alt}.` : '');
  });
  $('a').each((_index, node) => {
    const text = $(node).text().trim();
    $(node).replaceWith(/^\[?[\d*†‡]+\]?$/.test(text) ? '' : text);
  });
  $('br').replaceWith('\n');
  $('p, div, section, article, aside, header, footer, nav, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption').each((_index, node) => {
    $(node).prepend('\n\n');
    $(node).append('\n\n');
  });
  return normalizePlainText(($('body').text() || $.root().text()));
}

/**
 * A small stateful Markdown reader. It handles block structure and inline
 * constructs explicitly so source preparation never depends on broad syntax-
 * stripping expressions that can eat punctuation or dialogue.
 */
export function markdownToPlainText(markdown: string): string {
  const lines = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let fence: string | undefined;
  for (const original of lines) {
    let line = original;
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = undefined;
      continue;
    }
    if (fence) {
      output.push(line);
      continue;
    }
    if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) {
      output.push('');
      continue;
    }
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '');
    line = line.replace(/^\s*>\s?/, '');
    line = line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '');
    output.push(parseMarkdownInline(line));
  }
  return normalizePlainText(output.join('\n'));
}

function parseMarkdownInline(line: string): string {
  let out = '';
  for (let i = 0; i < line.length;) {
    if (line[i] === '\\' && i + 1 < line.length) {
      out += line[i + 1]; i += 2; continue;
    }
    const image = line.slice(i).match(/^!\[([^\]]*)\]\([^)]*\)/);
    if (image) {
      if (image[1].trim()) out += `Image: ${image[1].trim()}.`;
      i += image[0].length; continue;
    }
    const link = line.slice(i).match(/^\[([^\]]+)\]\([^)]*\)/);
    if (link) { out += parseMarkdownInline(link[1]); i += link[0].length; continue; }
    const code = line.slice(i).match(/^(`+)([\s\S]*?)\1/);
    if (code) { out += code[2]; i += code[0].length; continue; }
    const marker = line.slice(i).match(/^(\*\*|__|~~|\*|_)/)?.[1];
    if (marker) {
      const end = line.indexOf(marker, i + marker.length);
      if (end >= 0) {
        out += parseMarkdownInline(line.slice(i + marker.length, end));
        i = end + marker.length; continue;
      }
    }
    if (line[i] === '<') {
      const end = line.indexOf('>', i + 1);
      if (end >= 0) { i = end + 1; continue; }
    }
    out += line[i++];
  }
  return out;
}

export function normalizePlainText(text: string): string {
  return normalizeNonBreakingSpaces(text)
    .normalize('NFC')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
