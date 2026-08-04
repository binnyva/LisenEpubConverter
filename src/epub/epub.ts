import AdmZip from 'adm-zip';
import path from 'node:path/posix';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';

export interface SpineItem {
  id: string;
  href: string;
  html: string;
  isNav: boolean;
}

export interface ParsedEpub {
  title: string;
  author: string;
  language: string;
  spine: SpineItem[];
  /** href (relative to OPF) -> title, from the navigation document / NCX. */
  tocTitles: Map<string, string>;
  cover?: { data: Buffer; ext: string };
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
});

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)['#text']);
  }
  return '';
}

export function parseEpub(epubPath: string): ParsedEpub {
  const zip = new AdmZip(epubPath);
  const read = (p: string): Buffer | null => zip.getEntry(p)?.getData() ?? null;
  const readText = (p: string): string | null => read(p)?.toString('utf8') ?? null;

  const containerXml = readText('META-INF/container.xml');
  if (!containerXml) throw new Error('Not a valid EPUB: missing META-INF/container.xml');
  const container = xml.parse(containerXml);
  const opfPath: string = asArray(container.container?.rootfiles?.rootfile)[0]?.['@_full-path'];
  if (!opfPath) throw new Error('Not a valid EPUB: no rootfile in container.xml');

  const opfDir = path.dirname(opfPath);
  const resolve = (href: string): string =>
    path.normalize(opfDir === '.' ? href : path.join(opfDir, decodeURIComponent(href)));

  const opfXml = readText(opfPath);
  if (!opfXml) throw new Error(`Not a valid EPUB: missing OPF file ${opfPath}`);
  const opf = xml.parse(opfXml).package;

  const meta = opf.metadata ?? {};
  const title = textOf(meta.title) || path.basename(epubPath, '.epub');
  const author = textOf(meta.creator) || 'Unknown';
  const language = textOf(meta.language) || 'en';

  interface ManifestItem {
    id: string;
    href: string;
    mediaType: string;
    properties: string;
  }
  const manifest = new Map<string, ManifestItem>();
  for (const item of asArray<any>(opf.manifest?.item)) {
    manifest.set(item['@_id'], {
      id: item['@_id'],
      href: item['@_href'],
      mediaType: item['@_media-type'] ?? '',
      properties: item['@_properties'] ?? '',
    });
  }

  // Cover: EPUB3 properties="cover-image", else EPUB2 <meta name="cover" content="id">.
  let cover: ParsedEpub['cover'];
  let coverItem = [...manifest.values()].find((m) => m.properties.includes('cover-image'));
  if (!coverItem) {
    const coverMeta = asArray<any>(meta.meta).find((m) => m?.['@_name'] === 'cover');
    if (coverMeta) coverItem = manifest.get(coverMeta['@_content']);
  }
  if (coverItem) {
    const data = read(resolve(coverItem.href));
    if (data) cover = { data, ext: path.extname(coverItem.href) || '.jpg' };
  }

  // Chapter titles from the EPUB3 nav document, falling back to the EPUB2 NCX.
  const tocTitles = new Map<string, string>();
  const navItem = [...manifest.values()].find((m) => m.properties.includes('nav'));
  if (navItem) {
    const navHtml = readText(resolve(navItem.href));
    if (navHtml) {
      const $ = cheerio.load(navHtml, { xml: false });
      const navDir = path.dirname(navItem.href);
      $('nav a[href]').each((_, el) => {
        const href = $(el).attr('href')!.split('#')[0];
        if (!href) return;
        const full = path.normalize(navDir === '.' ? href : path.join(navDir, href));
        if (!tocTitles.has(full)) tocTitles.set(full, $(el).text().trim());
      });
    }
  }
  const ncxId = opf.spine?.['@_toc'];
  const ncxItem = ncxId ? manifest.get(ncxId) : undefined;
  if (ncxItem) {
    const ncxXml = readText(resolve(ncxItem.href));
    if (ncxXml) {
      const ncx = xml.parse(ncxXml).ncx;
      const walk = (points: any[]): void => {
        for (const p of asArray(points)) {
          const src = p?.content?.['@_src']?.split('#')[0];
          const label = textOf(p?.navLabel?.text);
          if (src && label) {
            const navDir = path.dirname(ncxItem.href);
            const full = path.normalize(navDir === '.' ? src : path.join(navDir, src));
            if (!tocTitles.has(full)) tocTitles.set(full, label.trim());
          }
          if (p?.navPoint) walk(asArray(p.navPoint));
        }
      };
      walk(asArray(ncx?.navMap?.navPoint));
    }
  }

  const spine: SpineItem[] = [];
  for (const itemref of asArray<any>(opf.spine?.itemref)) {
    const item = manifest.get(itemref['@_idref']);
    if (!item || !item.mediaType.includes('html')) continue;
    const html = readText(resolve(item.href));
    if (html === null) continue;
    spine.push({
      id: item.id,
      href: item.href,
      html,
      isNav: item.properties.includes('nav') || item.mediaType === 'application/x-dtbncx+xml',
    });
  }
  if (spine.length === 0) throw new Error('EPUB has no readable chapters in its spine');

  return { title, author, language, spine, tocTitles, cover };
}
