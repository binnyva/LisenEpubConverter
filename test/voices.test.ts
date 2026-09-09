import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import { runVoices, validateVoiceBindings } from '../src/pipeline/voices.js';
import { importVoiceLibrary, loadVoiceLibrary, saveVoiceLibrary, refreshVoiceLibrary } from '../src/voices/library.js';
import { runStage } from '../src/pipeline/runner.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('voice library bindings', () => {
  it('applies the version-2 Fish catalogue through the stage runner and preserves manual assignments on rerun', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-fish-'));
    roots.push(root);
    const epub = path.join(root, 'book.epub');
    fs.writeFileSync(epub, crypto.randomBytes(32));
    const libraryFile = path.join(root, 'library.json');
    const library = loadVoiceLibrary(path.resolve('library/voices.json'));
    saveVoiceLibrary(library, libraryFile);
    expect(loadVoiceLibrary(libraryFile).sources).toEqual(library.sources);
    const fish = library.models.find(m => m.id === 'fish:s2.1-pro');
    expect(fish?.inputLimits).toEqual(expect.arrayContaining([expect.objectContaining({ max: null })]));
    const work = new WorkDir(epub, root);
    work.writeJson('casting.json', {
      version: 2,
      narrator: { voiceProfile: { presentation: 'male', tone: ['deep', 'dramatic'] }, instructions: 'Narrate in British English.' },
      characters: { Alice: { voiceProfile: { presentation: 'female', age: 'young', tone: ['sincere'] }, instructions: 'Curious.' } },
    });
    work.writeJson('script/00.json', { index: 0, segments: [{ speaker: 'Alice', text: 'Hello.' }] });
    const options = { epubPath: epub, workRoot: root, outDir: root, stage: 'voices' as const, voiceTarget: { provider: 'fish' as const, model: 's2.1-pro' }, voiceLibraryFile: libraryFile, rerun: true };
    await runStage(options);
    const first = validateVoiceBindings(work);
    expect(first.target).toEqual(options.voiceTarget);
    expect(first.characters.Alice.voiceId).toBe('933563129e564b19a115bedd57b7406a');
    expect(first.characters.Alice.match.limitations.join(' ')).toContain('inline delivery cues');
    first.characters.Alice.selection = 'manual';
    work.writeJson('voice-bindings.json', first);
    await runStage(options);
    expect(validateVoiceBindings(work).characters.Alice.selection).toBe('manual');
    expect(new WorkDir(epub, root).isDone('voices')).toBe(true);
    expect(fs.existsSync(work.path('audio'))).toBe(false);
    expect(() => refreshVoiceLibrary({ provider: 'openai', model: 'gpt-4o-mini-tts' }, libraryFile)).toThrow('Version-2');
    expect(loadVoiceLibrary(libraryFile).sources).toEqual(library.sources);
  });

  it('rejects missing scripted speakers before writing bindings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-speakers-'));
    roots.push(root);
    const epub = path.join(root, 'book.epub');
    fs.writeFileSync(epub, crypto.randomBytes(32));
    const work = new WorkDir(epub, root);
    work.writeJson('casting.json', { version: 2, narrator: { voiceProfile: {} }, characters: {} });
    work.writeJson('script/00.json', { index: 0, segments: [{ speaker: 'The Duchess', text: 'Hello.' }] });
    expect(() => runVoices(work, { provider: 'fish', model: 's2.1-pro' }, path.resolve('library/voices.json'))).toThrow('The Duchess');
    expect(fs.existsSync(work.path('voice-bindings.json'))).toBe(false);
  });

  it('matches independent cast traits and preserves a compatible manual override', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-voices-'));
    roots.push(root);
    const epub = path.join(root, 'book.epub');
    const catalogue = path.join(root, 'catalogue.json');
    const library = path.join(root, 'voices.json');
    fs.writeFileSync(epub, crypto.randomBytes(32));
    fs.writeFileSync(catalogue, JSON.stringify([
      { id: 'bright', sex: 'female', description: 'bright, friendly adult female' },
      { id: 'calm', sex: 'female', description: 'calm, mature female' },
      { id: 'deep', sex: 'male', description: 'deep, authoritative male' },
    ]));
    vi.stubEnv('LISEN_VOICE_LIBRARY_FILE', library);
    importVoiceLibrary(catalogue, { provider: 'openai', model: 'test-tts' });

    const work = new WorkDir(epub, root);
    work.writeJson('casting.json', {
      version: 2,
      narrator: { voiceProfile: { presentation: 'male', age: 'mature', tone: ['authoritative'], language: 'en', accent: 'unspecified' }, instructions: 'Narrate steadily.' },
      characters: {
        Alice: { voiceProfile: { presentation: 'female', age: 'child', tone: ['bright'], language: 'en', accent: 'unspecified' }, instructions: 'Curious and lively.' },
      },
    });

    const first = runVoices(work, { provider: 'openai', model: 'test-tts' });
    expect(first.narrator.voiceId).toBe('deep');
    expect(first.characters.Alice.voiceId).toBe('bright');
    expect(first.characters.Alice.match.limitations).toContain('Requested child; catalogue describes this voice as unknown.');

    first.characters.Alice = { ...first.characters.Alice, voiceId: 'calm', libraryVoiceId: 'openai:test-tts:calm', selection: 'manual' };
    work.writeJson('voice-bindings.json', first);
    expect(runVoices(work, { provider: 'openai', model: 'test-tts' }).characters.Alice.voiceId).toBe('calm');
    expect(validateVoiceBindings(work).characters.Alice.selection).toBe('manual');
  });

  it('migrates a legacy model-specific cast before applying library voices', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-legacy-voices-'));
    roots.push(root);
    const epub = path.join(root, 'book.epub');
    const catalogue = path.join(root, 'catalogue.json');
    const library = path.join(root, 'voices.json');
    fs.writeFileSync(epub, crypto.randomBytes(32));
    fs.writeFileSync(catalogue, JSON.stringify([{ id: 'voice-a', sex: 'female', description: 'bright female' }]));
    vi.stubEnv('LISEN_VOICE_LIBRARY_FILE', library);
    importVoiceLibrary(catalogue, { provider: 'openai', model: 'test-tts' });
    const work = new WorkDir(epub, root);
    work.writeJson('casting.json', { narrator: { voiceId: 'legacy-narrator', instructions: 'Steady.' }, characters: {} });

    expect(runVoices(work, { provider: 'openai', model: 'test-tts' }).narrator.voiceId).toBe('voice-a');
    expect(fs.existsSync(work.path('casting.legacy.json'))).toBe(true);
    expect(work.readJson<{ version: number }>('casting.json').version).toBe(2);
  });
});
