import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEpub } from '../src/epub/epub.js';
import { WorkDir } from '../src/state.js';
import { runExtract } from '../src/pipeline/extract.js';

let tmpDir: string;
let epubPath: string;

function makeTestEpub(file: string): void {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
  );
  zip.addFile(
    'OEBPS/content.opf',
    Buffer.from(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">test-book</dc:identifier>
    <dc:title>Test Book</dc:title>
    <dc:creator>Jane Tester</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="nav"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`)
  );
  zip.addFile(
    'OEBPS/nav.xhtml',
    Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml"><body>
<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>
<li><a href="ch1.xhtml">The Beginning</a></li>
<li><a href="ch2.xhtml">The End</a></li>
</ol></nav></body></html>`)
  );
  zip.addFile(
    'OEBPS/ch1.xhtml',
    Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>The Beginning</h1>
<p>"Hello there," said Alice.</p>
<img src="map.png" alt="A hand-drawn map"/>
<p>See <a href="https://example.com">this site</a> for more.</p>
</body></html>`)
  );
  zip.addFile(
    'OEBPS/ch2.xhtml',
    Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>The End</h1><p>It was over.</p></body></html>`)
  );
  zip.addFile('OEBPS/cover.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  zip.writeZip(file);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-test-'));
  epubPath = path.join(tmpDir, 'test-book.epub');
  makeTestEpub(epubPath);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseEpub', () => {
  it('reads metadata, spine, toc titles and cover', () => {
    const epub = parseEpub(epubPath);
    expect(epub.title).toBe('Test Book');
    expect(epub.author).toBe('Jane Tester');
    expect(epub.spine).toHaveLength(3);
    expect(epub.spine[0].isNav).toBe(true);
    expect(epub.tocTitles.get('ch1.xhtml')).toBe('The Beginning');
    expect(epub.cover?.ext).toBe('.jpg');
  });
});

describe('runExtract', () => {
  it('writes one markdown file per chapter with edge-case rules applied', () => {
    const work = new WorkDir(epubPath, path.join(tmpDir, 'work'));
    const meta = runExtract(epubPath, work);

    expect(meta.chapters).toHaveLength(3);
    expect(meta.chapters[1].title).toBe('The Beginning');
    expect(meta.coverFile).toBe('cover.jpg');

    const ch1 = fs.readFileSync(work.path(meta.chapters[1].file), 'utf8');
    expect(ch1).toContain('# The Beginning');
    expect(ch1).toContain('"Hello there," said Alice.');
    expect(ch1).toContain('Image: A hand-drawn map.');
    expect(ch1).toContain('this site');
    expect(ch1).not.toContain('example.com');
  });

  it('marks stage completion in state.json and resumes', () => {
    const work = new WorkDir(epubPath, path.join(tmpDir, 'work'));
    work.markDone('extract');
    expect(work.isDone('extract')).toBe(true);

    const again = new WorkDir(epubPath, path.join(tmpDir, 'work'));
    expect(again.isDone('extract')).toBe(true);

    again.invalidateFrom('extract');
    expect(again.isDone('extract')).toBe(false);
  });
});
