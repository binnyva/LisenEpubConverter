import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseEpub } from '../epub/epub.js';
import { htmlToPlainText, markdownToPlainText, normalizePlainText } from '../epub/markdown.js';

export const SOURCE_FORMATS = ['epub', 'pdf', 'html', 'markdown', 'text'] as const;
export type SourceFormat = typeof SOURCE_FORMATS[number];

export interface SourceMetadataOverrides {
  title?: string;
  author?: string;
  language?: string;
}

export interface SourceChapter {
  id: string;
  title: string;
  text: string;
  /** @deprecated Compatibility alias; content is plain text, not Markdown. */
  markdown: string;
  isNav: boolean;
}

export interface ParsedSource {
  format: SourceFormat;
  title: string;
  author: string;
  language: string;
  chapters: SourceChapter[];
  cover?: { data: Buffer; ext: string };
  /** Hash of downloaded URL content, used to record the exact retrieved source. */
  contentHash?: string;
}

export function sourceFormatForPath(sourcePath: string): SourceFormat | undefined {
  if (isRemoteSource(sourcePath)) return 'html';
  switch (path.extname(sourcePath).toLowerCase()) {
    case '.epub': return 'epub';
    case '.pdf': return 'pdf';
    case '.html':
    case '.htm': return 'html';
    case '.md':
    case '.markdown': return 'markdown';
    case '.txt': return 'text';
    default: return undefined;
  }
}

export function supportedSourceDescription(): string {
  return 'an http(s) URL, .epub, .pdf, .html, .htm, .md, .markdown, or .txt';
}

export function isRemoteSource(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sourceIsAvailable(source: string): boolean {
  return isRemoteSource(source) || fs.existsSync(source);
}

export async function readSource(sourcePath: string, overrides: SourceMetadataOverrides = {}): Promise<ParsedSource> {
  const format = sourceFormatForPath(sourcePath);
  if (!format) throw new Error(`Unsupported source format. Choose ${supportedSourceDescription()}.`);

  const parsed = await ({
    epub: () => readEpub(sourcePath),
    pdf: () => readPdf(sourcePath),
    html: () => isRemoteSource(sourcePath) ? readRemoteHtml(sourcePath) : readHtml(sourcePath),
    markdown: () => readMarkdown(sourcePath),
    text: () => readText(sourcePath),
  } satisfies Record<SourceFormat, () => Promise<ParsedSource>>)[format]();

  return {
    ...parsed,
    title: cleanOverride(overrides.title) ?? parsed.title,
    author: cleanOverride(overrides.author) ?? parsed.author,
    language: cleanOverride(overrides.language) ?? parsed.language,
  };
}

async function readEpub(sourcePath: string): Promise<ParsedSource> {
  const epub = parseEpub(sourcePath);
  return {
    format: 'epub',
    title: epub.title,
    author: epub.author,
    language: epub.language,
    chapters: epub.spine.map((item, index) => ({
      id: item.id,
      title: epub.tocTitles.get(item.href) || firstHeading(item.html) || `Section ${index + 1}`,
      text: htmlToPlainText(item.html),
      markdown: htmlToPlainText(item.html),
      isNav: item.isNav,
    })),
    cover: epub.cover,
  };
}

async function readHtml(sourcePath: string): Promise<ParsedSource> {
  const html = fs.readFileSync(sourcePath, 'utf8');
  return parseHtml(sourcePath, html);
}

async function readRemoteHtml(sourceUrl: string): Promise<ParsedSource> {
  let response: Response;
  try {
    response = await fetch(sourceUrl, { redirect: 'follow' });
  } catch (error) {
    throw new Error(`Could not download URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Could not download URL: server returned HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !contentType.includes('html') && !contentType.startsWith('text/')) {
    throw new Error(`URL did not return HTML or text content (Content-Type: ${contentType}).`);
  }
  const html = await readResponseText(response);
  if (!html.trim()) throw new Error('URL returned an empty document.');
  return {
    ...parseHtml(sourceUrl, html),
    contentHash: crypto.createHash('sha256').update(html).digest('hex').slice(0, 16),
  };
}

function parseHtml(sourcePath: string, html: string): ParsedSource {
  const $ = cheerio.load(html);
  const content = $('article').first().html() ?? $('main').first().html() ?? $('body').html() ?? html;
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || titleFromPath(sourcePath);
  const author = $('meta[name="author" i], meta[property="article:author" i]').first().attr('content')?.trim() || 'Unknown';
  const language = $('html').attr('lang')?.trim() || 'en';
  return {
    format: 'html', title, author, language,
    chapters: [{ id: 'source', title, text: htmlToPlainText(content), markdown: htmlToPlainText(content), isNav: false }],
  };
}

async function readResponseText(response: Response): Promise<string> {
  const maxBytes = 10 * 1024 * 1024;
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('URL response is larger than the 10 MB import limit.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('URL response is larger than the 10 MB import limit.');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function readMarkdown(sourcePath: string): Promise<ParsedSource> {
  const raw = fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '');
  const { attributes, body } = splitFrontMatter(raw);
  const title = attributes.title || firstMarkdownHeading(body) || titleFromPath(sourcePath);
  return {
    format: 'markdown',
    title,
    author: attributes.author || 'Unknown',
    language: attributes.language || attributes.lang || 'en',
    chapters: [{ id: 'source', title, text: markdownToPlainText(body), markdown: markdownToPlainText(body), isNav: false }],
  };
}

async function readText(sourcePath: string): Promise<ParsedSource> {
  const raw = fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '');
  const text = normalizePlainText(raw);
  if (!text) throw new Error('Text source is empty.');
  const title = titleFromPath(sourcePath);
  return { format: 'text', title, author: 'Unknown', language: 'en', chapters: [{ id: 'source', title, text, markdown: text, isNav: false }] };
}

async function readPdf(sourcePath: string): Promise<ParsedSource> {
  let document;
  try {
    document = await getDocument({ data: new Uint8Array(fs.readFileSync(sourcePath)) }).promise;
  } catch (error) {
    throw new Error(`Could not read PDF: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const { info } = await document.getMetadata();
    const metadata = info as Record<string, unknown>;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let line: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        if (item.str) line.push(item.str);
        if (item.hasEOL) {
          if (line.length) lines.push(line.join(' '));
          line = [];
        }
      }
      if (line.length) lines.push(line.join(' '));
      page.cleanup();
      pages.push(lines.join('\n'));
    }
    const text = normalizePdfText(pages.join('\n\n'));
    if (text.replace(/\s/g, '').length < 20) {
      throw new Error('This PDF has no readable text. It may be scanned or image-only; run OCR first, then use the OCRed PDF or a Markdown/text export.');
    }
    const title = stringMetadata(metadata.Title) || titleFromPath(sourcePath);
    const author = stringMetadata(metadata.Author) || 'Unknown';
    return {
      format: 'pdf', title, author, language: 'en',
      chapters: [{ id: 'source', title, text, markdown: text, isNav: false }],
    };
  } finally {
    await document.cleanup();
  }
}

function normalizePdfText(text: string): string {
  return text
    .replace(/([\p{L}\p{N}])-[ \t]*\n[ \t]*([\p{Ll}])/gu, '$1$2')
    .replace(/[^\S\r\n]+/g, ' ')
    // Preserve explicit PDF line groups as paragraphs. Join a line only when
    // it clearly continues a sentence; quoted dialogue on its own line stays
    // a separate paragraph for BookNLP.
    .replace(/([^.!?:;”"'’—-])\n(?=[\p{Ll}\p{N}])/gu, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitFrontMatter(raw: string): { attributes: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { attributes: {}, body: raw };
  const attributes: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/);
    if (field && field[2]) attributes[field[1].toLowerCase()] = field[2].replace(/^['"]|['"]$/g, '');
  }
  return { attributes, body: raw.slice(match[0].length) };
}

function firstHeading(html: string): string {
  const $ = cheerio.load(html);
  return $('h1, h2, h3').first().text().trim();
}

function firstMarkdownHeading(markdown: string): string {
  return markdown.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1].trim() ?? '';
}

function titleFromPath(sourcePath: string): string {
  if (isRemoteSource(sourcePath)) {
    const url = new URL(sourcePath);
    const leaf = path.posix.basename(url.pathname);
    return leaf.replace(/\.[A-Za-z0-9]+$/, '').replace(/[-_]+/g, ' ').trim() || url.hostname;
  }
  return path.basename(sourcePath, path.extname(sourcePath)).replace(/[-_]+/g, ' ').trim() || 'Untitled';
}

function cleanOverride(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function stringMetadata(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}
