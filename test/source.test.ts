import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runExtract } from '../src/pipeline/extract.js';
import { readSource, sourceFormatForPath } from '../src/source/read.js';
import { WorkDir, openWorkDir } from '../src/state.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-source-'));
  roots.push(root);
  return root;
}

function makeTextPdf(file: string): void {
  const stream = 'BT\n/F1 12 Tf\n72 720 Td\n(A short PDF story begins here.) Tj\nET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Title (The PDF Story) /Author (PDF Tester) >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, pdf);
}

describe('source readers', () => {
  it('uses Markdown front matter and preserves its single-story chapter', async () => {
    const root = tempRoot();
    const source = path.join(root, 'moonlit-story.md');
    fs.writeFileSync(source, '---\ntitle: Moonlit Story\nauthor: Ada Writer\nlanguage: pt-BR\n---\n\n# Moonlit Story\n\nA quiet story.');

    const parsed = await readSource(source);
    expect(parsed).toMatchObject({ format: 'markdown', title: 'Moonlit Story', author: 'Ada Writer', language: 'pt-BR' });
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].markdown).toContain('A quiet story.');
    expect(parsed.chapters[0].text).toBe('Moonlit Story\n\nA quiet story.');
    expect(parsed.chapters[0].text).not.toContain('#');
  });

  it('supports UTF-8 plain text as a canonical source', async () => {
    const root = tempRoot(); const source = path.join(root, 'story.txt');
    fs.writeFileSync(source, '\uFEFF“Olá,” said Ana.\n\n😀 A second paragraph.');
    const parsed = await readSource(source, { language: 'en-GB', author: 'Writer' });
    expect(parsed).toMatchObject({ format: 'text', title: 'story', author: 'Writer', language: 'en-GB' });
    expect(parsed.chapters[0].text).toBe('“Olá,” said Ana.\n\n😀 A second paragraph.');
  });

  it('uses article content and document metadata from HTML', async () => {
    const root = tempRoot();
    const source = path.join(root, 'story.html');
    fs.writeFileSync(source, '<html lang="fr"><head><title>HTML Story</title><meta name="author" content="Camille"></head><body><nav>Skip me</nav><article><h1>HTML Story</h1><p>Bonjour.</p></article></body></html>');

    const parsed = await readSource(source, { author: 'Override Author' });
    expect(parsed).toMatchObject({ format: 'html', title: 'HTML Story', author: 'Override Author', language: 'fr' });
    expect(parsed.chapters[0].markdown).toContain('Bonjour.');
    expect(parsed.chapters[0].markdown).not.toContain('Skip me');
  });

  it('downloads an HTTP URL as HTML and records the fetched content hash', async () => {
    const root = tempRoot();
    const source = 'https://stories.example.test/moonlit';
    const html = '<html lang="en"><head><title>Moonlit URL</title><meta name="author" content="Web Writer"></head><body><article><p>Downloaded prose.</p></article></body></html>';
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(
      html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
    )));
    vi.stubGlobal('fetch', fetchMock);

    const parsed = await readSource(source);
    expect(fetchMock).toHaveBeenCalledWith(source, { redirect: 'follow' });
    expect(parsed).toMatchObject({ format: 'html', title: 'Moonlit URL', author: 'Web Writer' });
    expect(parsed.chapters[0].markdown).toContain('Downloaded prose.');
    expect(parsed.contentHash).toHaveLength(16);

    const work = new WorkDir(source, path.join(root, 'work'));
    await runExtract(source, work);
    expect(new WorkDir(source, path.join(root, 'work')).sourceChanged()).toBe(false);
  });

  it('extracts text and metadata from a text PDF', async () => {
    const root = tempRoot();
    const source = path.join(root, 'story.pdf');
    makeTextPdf(source);

    const parsed = await readSource(source);
    expect(parsed).toMatchObject({ format: 'pdf', title: 'The PDF Story', author: 'PDF Tester' });
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].markdown).toContain('A short PDF story begins here.');
  });

  it('keeps identically named source formats in separate work folders', async () => {
    const root = tempRoot();
    const markdown = path.join(root, 'story.md');
    const pdf = path.join(root, 'story.pdf');
    fs.writeFileSync(markdown, '# Story\n\nText.');
    makeTextPdf(pdf);

    const markdownWork = new WorkDir(markdown, path.join(root, 'work'));
    const pdfWork = new WorkDir(pdf, path.join(root, 'work'));
    expect(markdownWork.root).not.toBe(pdfWork.root);
    const metadata = await runExtract(markdown, markdownWork, { language: 'en-GB' });
    expect(metadata.language).toBe('en-GB');
    expect(sourceFormatForPath(path.join(root, 'story.txt'))).toBe('text');
  });

  it('names new work folders from the document title, including title overrides', async () => {
    const root = tempRoot();
    const first = path.join(root, 'an-unrelated-file-name.md');
    const second = path.join(root, 'another-file.md');
    fs.writeFileSync(first, '# The Actual Work Title\n\nText.');
    fs.writeFileSync(second, '# Something Else\n\nText.');

    const initial = await openWorkDir(first, path.join(root, 'work'));
    const overridden = await openWorkDir(second, path.join(root, 'work'), { title: 'Chosen Title' });
    expect(path.basename(initial.root)).toBe('the-actual-work-title');
    expect(path.basename(overridden.root)).toBe('chosen-title');
  });
});
