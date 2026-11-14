import { describe, expect, it } from 'vitest';
import { modeFromHealth } from './mode-state';

describe('operating mode from GET /health', () => {
  it('reads demo and licensed', () => {
    expect(modeFromHealth({ status: 'ok', mode: 'demo' })).toBe('demo');
    expect(modeFromHealth({ status: 'ok', mode: 'licensed' })).toBe('licensed');
  });

  it('is unknown for anything else, so the caller keeps its last answer', () => {
    expect(modeFromHealth({ status: 'ok' })).toBeNull();
    expect(modeFromHealth({ mode: 'real' })).toBeNull();
    expect(modeFromHealth('demo')).toBeNull();
    expect(modeFromHealth(null)).toBeNull();
    expect(modeFromHealth(undefined)).toBeNull();
  });
});
