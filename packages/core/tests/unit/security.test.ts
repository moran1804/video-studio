import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  assertFilterSafePath,
  assertRealPathInside,
  assertUuid,
  safeExtension,
  safeJoin,
  sanitizeFilename,
  PathSecurityError,
} from '../../src/security/paths';
import { isPublicIp, safeLookup, validatePublicUrl, UnsafeUrlError } from '../../src/security/ssrf';
import { sniffFile } from '../../src/security/upload';
import { makePng } from '../fixtures/png';
import { decryptSecret, encryptSecret, maskSecret, timingSafeEqualStr } from '../../src/security/crypto';
import { redact, registerSecret } from '../../src/security/redact';

describe('path security', () => {
  it('sanitises filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\x\\évil<script>.mp4')).toBe('evil_script_.mp4');
    expect(sanitizeFilename('.hidden')).toBe('hidden');
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('a'.repeat(300) + '.png').length).toBeLessThanOrEqual(120);
    expect(sanitizeFilename('a'.repeat(300) + '.png').endsWith('.png')).toBe(true);
  });

  it('keeps only safe extensions', () => {
    expect(safeExtension('video.MP4')).toBe('.mp4');
    expect(safeExtension('x.tar.gz')).toBe('.gz');
    expect(safeExtension('bad.$(rm)')).toBe('');
  });

  it('prevents traversal in safeJoin', () => {
    const root = '/data';
    expect(safeJoin(root, 'projects', 'abc', 'file.mp4')).toBe('/data/projects/abc/file.mp4');
    expect(() => safeJoin(root, '../etc/passwd')).toThrow(PathSecurityError);
    expect(() => safeJoin(root, 'projects/../../etc')).toThrow(PathSecurityError);
    expect(() => safeJoin(root, '/etc/passwd')).toThrow(PathSecurityError);
    expect(() => safeJoin(root, 'a\0b')).toThrow(PathSecurityError);
    expect(() => safeJoin(root, '')).toThrow(PathSecurityError);
  });

  it('detects symlink escapes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paths-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
    await fs.writeFile(path.join(outside, 'secret'), 'x');
    await fs.symlink(path.join(outside, 'secret'), path.join(dir, 'link'));
    await fs.writeFile(path.join(dir, 'ok'), 'y');
    await expect(assertRealPathInside(dir, path.join(dir, 'ok'))).resolves.toContain('ok');
    await expect(assertRealPathInside(dir, path.join(dir, 'link'))).rejects.toThrow(PathSecurityError);
  });

  it('validates uuids and filter-safe paths', () => {
    expect(assertUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(() => assertUuid('../x')).toThrow();
    expect(assertFilterSafePath('/data/temp/render-1/captions.ass')).toBeTruthy();
    expect(() => assertFilterSafePath("/tmp/a';rm -rf /.ass")).toThrow();
    expect(() => assertFilterSafePath('/tmp/a:b,c.ass')).toThrow();
  });
});

describe('SSRF protection', () => {
  it('accepts public http(s) URLs', () => {
    expect(validatePublicUrl('https://www.youtube.com/watch?v=abc').hostname).toBe('www.youtube.com');
    expect(validatePublicUrl('http://example.com/video.mp4').pathname).toBe('/video.mp4');
  });

  it.each([
    ['file:///etc/passwd', 'Only http'],
    ['ftp://example.com/x', 'Only http'],
    ['gopher://example.com', 'Only http'],
    ['http://localhost/admin', 'local or internal'],
    ['http://127.0.0.1/', 'private'],
    ['http://10.0.0.5/', 'private'],
    ['http://192.168.1.10/', 'private'],
    ['http://172.16.0.1/', 'private'],
    ['http://169.254.169.254/latest/meta-data/', 'private'],
    ['http://100.64.0.1/', 'private'],
    ['http://[::1]/', 'private'],
    ['http://[fd00::1]/', 'private'],
    ['http://[::ffff:127.0.0.1]/', 'private'],
    ['http://0.0.0.0/', 'private'],
    ['http://truenas.local/', 'local or internal'],
    ['http://intranet/', 'fully-qualified'],
    ['http://user:pass@example.com/', 'credentials'],
    ['http://example.com:6379/', 'standard web ports'],
    ['not a url', 'valid URL'],
  ])('rejects %s', (url, msg) => {
    expect(() => validatePublicUrl(url)).toThrow(UnsafeUrlError);
    expect(() => validatePublicUrl(url)).toThrow(new RegExp(msg, 'i'));
  });

  it('classifies IP addresses', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('1.1.1.1')).toBe(true);
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.1.1',
      '100.100.100.100',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:10.0.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it('blocks hostnames that resolve to private addresses at connect time (DNS rebinding)', async () => {
    await new Promise<void>((resolve) => {
      safeLookup('localhost', {}, (err) => {
        expect(err).toBeTruthy();
        expect(String(err?.message)).toMatch(/private or reserved/);
        resolve();
      });
    });
  });
});

describe('upload validation', () => {
  const png = makePng(4, 4);
  it('detects file types from content', async () => {
    expect(await sniffFile(png, 'image.jpg')).toMatchObject({ mime: 'image/png', cls: 'image', ext: '.png' });
    expect(
      await sniffFile(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n', 'binary'), 'doc.pdf'),
    ).toMatchObject({ mime: 'application/pdf', cls: 'pdf' });
    expect(await sniffFile(Buffer.from('# Heading\nSome *markdown*'), 'notes.md')).toMatchObject({
      mime: 'text/markdown',
      cls: 'document',
    });
    expect(await sniffFile(Buffer.from('plain text'), 'notes.txt')).toMatchObject({ mime: 'text/plain' });
  });

  it('rejects disallowed or disguised files', async () => {
    expect(await sniffFile(Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'binary'), 'video.mp4')).toBeNull();
    expect(await sniffFile(Buffer.from('<html><script>alert(1)</script></html>'), 'page.html')).toBeNull();
    expect(
      await sniffFile(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'logo.svg'),
    ).toBeNull();
    expect(await sniffFile(Buffer.from([0, 1, 2, 3, 0, 0]), 'notes.txt')).toBeNull();
    expect(await sniffFile(Buffer.from('plain text'), 'script.sh')).toBeNull();
  });
});

describe('crypto & redaction', () => {
  it('encrypts and decrypts API keys', () => {
    const secret = 'x'.repeat(40);
    const enc = encryptSecret('sk-test-1234567890', secret);
    expect(enc).not.toContain('sk-test');
    expect(decryptSecret(enc, secret)).toBe('sk-test-1234567890');
    expect(() => decryptSecret(enc, 'y'.repeat(40))).toThrow();
  });

  it('masks keys', () => {
    expect(maskSecret('sk-abcdefghijklmnop1234')).toBe('sk-…1234');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret(undefined)).toBeNull();
  });

  it('compares tokens in constant time', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  });

  it('redacts secrets from strings', () => {
    registerSecret('my-registered-secret-value');
    expect(redact('failed with my-registered-secret-value')).toBe('failed with [REDACTED]');
    expect(redact('key sk-proj-ABCDEFGHIJKLMNOPQRSTUV')).toBe('key [REDACTED]');
    expect(redact('Authorization: Bearer abc.def.ghi123')).not.toContain('abc.def');
    expect(redact('https://x.com/v1?key=AIzaSyA1234567890abcdefghij')).not.toContain('AIza');
    expect(redact('{"xi-api-key":"abcdef123456"}')).not.toContain('abcdef123456');
  });
});
