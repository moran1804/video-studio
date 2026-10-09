import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, validateRuntimeConfig } from '../../src/config';
import { deriveProjectStatus } from '../../src/status';

describe('config', () => {
  it('applies defaults and parses booleans / numbers', () => {
    const c = parseConfig({
      AUTH_ENABLED: 'false',
      MAX_UPLOAD_MB: '50',
      APP_URL: 'https://studio.example.com',
      ALLOWED_ORIGINS: 'http://nas.local:3000, bad-url',
    });
    expect(c.AUTH_ENABLED).toBe(false);
    expect(c.maxUploadBytes).toBe(50 * 1024 * 1024);
    expect(c.secureCookies).toBe(true);
    expect(c.allowedOrigins).toEqual(['https://studio.example.com', 'http://nas.local:3000']);
    expect(c.DEFAULT_VIDEO_PROVIDER).toBe('google');
  });

  it('reports understandable errors', () => {
    expect(() => parseConfig({ MAX_UPLOAD_MB: 'lots' })).toThrow(ConfigError);
    expect(() => parseConfig({ DEFAULT_VIDEO_PROVIDER: 'sora' })).toThrow(/DEFAULT_VIDEO_PROVIDER/);
    const c = parseConfig({ SESSION_SECRET: 'short' });
    const { errors } = validateRuntimeConfig('web', c);
    expect(errors.join(' ')).toMatch(/DATABASE_URL/);
    expect(errors.join(' ')).toMatch(/REDIS_URL/);
    expect(errors.join(' ')).toMatch(/SESSION_SECRET/);
  });

  it('accepts a complete configuration', () => {
    const c = parseConfig({
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      SESSION_SECRET: 'a'.repeat(40),
      MOCK_PROVIDERS: 'true',
    });
    expect(validateRuntimeConfig('worker', c).errors).toEqual([]);
  });
});

describe('project status', () => {
  const base = {
    briefStatus: 'none',
    sceneStatuses: [] as string[],
    activeJobTypes: [] as string[],
    failedJobCount: 0,
    hasFinalExport: false,
  };
  it('derives statuses in priority order', () => {
    expect(deriveProjectStatus(base).key).toBe('draft');
    expect(deriveProjectStatus({ ...base, briefStatus: 'approved' }).key).toBe('brief_approved');
    expect(deriveProjectStatus({ ...base, sceneStatuses: ['completed', 'draft'] }).key).toBe('storyboard');
    expect(deriveProjectStatus({ ...base, sceneStatuses: ['completed'] }).key).toBe('ready');
    expect(deriveProjectStatus({ ...base, activeJobTypes: ['generation'] }).key).toBe('generating');
    expect(deriveProjectStatus({ ...base, activeJobTypes: ['render'] }).key).toBe('rendering');
    expect(deriveProjectStatus({ ...base, failedJobCount: 1, hasFinalExport: true }).key).toBe('attention');
    expect(deriveProjectStatus({ ...base, hasFinalExport: true, sceneStatuses: ['completed'] }).key).toBe(
      'exported',
    );
  });
});
