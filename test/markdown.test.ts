import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, markdownToSpeakable } from '../src/epub/markdown.js';

describe('htmlToMarkdown', () => {
  it('converts images with alt text to spoken sentences', () => {
    const md = htmlToMarkdown('<p>Before.</p><img src="map.png" alt="A map of Middle Earth"><p>After.</p>');
    expect(md).toContain('Image: A map of Middle Earth.');
  });

  it('drops images without alt text', () => {
    const md = htmlToMarkdown('<p>Before.</p><img src="deco.png"><p>After.</p>');
    expect(md).not.toContain('Image');
    expect(md).toContain('Before.');
    expect(md).toContain('After.');
  });

  it('keeps link text and drops the URL', () => {
    const md = htmlToMarkdown('<p>Visit <a href="https://example.com">our website</a> today.</p>');
    expect(md).toContain('our website');
    expect(md).not.toContain('example.com');
    expect(md).not.toContain('[');
  });

  it('drops footnote-marker links', () => {
    const md = htmlToMarkdown('<p>A claim<a href="#fn1">[1]</a> in text.</p>');
    expect(md).not.toContain('[1]');
    expect(md).not.toContain('1');
  });

  it('keeps headings as markdown', () => {
    const md = htmlToMarkdown('<h1>Chapter One</h1><p>It begins.</p>');
    expect(md).toContain('# Chapter One');
  });

  it('keeps bullet and numbered lists', () => {
    const md = htmlToMarkdown('<ul><li>First</li><li>Second</li></ul><ol><li>Uno</li></ol>');
    expect(md).toMatch(/-\s+First/);
    expect(md).toMatch(/-\s+Second/);
    expect(md).toMatch(/1\.\s+Uno/);
  });

  it('removes script and style content', () => {
    const md = htmlToMarkdown('<style>p{color:red}</style><script>alert(1)</script><p>Text.</p>');
    expect(md).toBe('Text.');
  });

  it('normalizes non-breaking spaces', () => {
    const md = htmlToMarkdown('<p>One&nbsp;two&#x202f;three</p>');
    expect(md).toBe('One two three');
  });
});

describe('markdownToSpeakable', () => {
  it('strips heading markers, list markers, and emphasis', () => {
    const text = markdownToSpeakable('# Chapter One\n\n- item one\n\nThis is **bold** and *italic*.');
    expect(text).not.toContain('#');
    expect(text).not.toContain('**');
    expect(text).toContain('Chapter One');
    expect(text).toContain('item one');
    expect(text).toContain('This is bold and italic.');
  });

  it('keeps numbered list numbers spoken', () => {
    expect(markdownToSpeakable('1. First step')).toBe('1. First step');
  });

  it('normalizes non-breaking spaces before synthesis', () => {
    expect(markdownToSpeakable('One\u00a0two\u202fthree')).toBe('One two three');
  });
});
