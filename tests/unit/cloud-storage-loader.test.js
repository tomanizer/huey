import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseS3Uri,
  parseGcsUri,
  getExtensionFromKey,
  getBaseNameFromKey,
  fetchS3AsBlob,
  fetchGcsAsBlob,
} from '../../src/util/CloudStorageLoader.js';

// ---------------------------------------------------------------------------
// parseS3Uri
// ---------------------------------------------------------------------------
describe('parseS3Uri', () => {
  it('parses a simple s3 URI', () => {
    expect(parseS3Uri('s3://my-bucket/data/file.parquet')).toEqual({
      bucket: 'my-bucket',
      key: 'data/file.parquet',
    });
  });

  it('parses an s3 URI with a top-level key', () => {
    expect(parseS3Uri('s3://bucket/file.csv')).toEqual({
      bucket: 'bucket',
      key: 'file.csv',
    });
  });

  it('parses an s3 URI with an empty key (root)', () => {
    expect(parseS3Uri('s3://bucket/')).toEqual({
      bucket: 'bucket',
      key: '',
    });
  });

  it('returns null for an http URL', () => {
    expect(parseS3Uri('https://example.com/file.parquet')).toBeNull();
  });

  it('returns null for a gs:// URI', () => {
    expect(parseS3Uri('gs://bucket/file.parquet')).toBeNull();
  });

  it('returns null for a non-string', () => {
    expect(parseS3Uri(null)).toBeNull();
    expect(parseS3Uri(undefined)).toBeNull();
    expect(parseS3Uri(42)).toBeNull();
  });

  it('parses an s3 URI with special characters in the key', () => {
    const result = parseS3Uri('s3://my-bucket/path/to/my file (1).csv');
    expect(result).toEqual({ bucket: 'my-bucket', key: 'path/to/my file (1).csv' });
  });
});

// ---------------------------------------------------------------------------
// parseGcsUri
// ---------------------------------------------------------------------------
describe('parseGcsUri', () => {
  it('parses a simple gs URI', () => {
    expect(parseGcsUri('gs://my-bucket/path/to/file.json')).toEqual({
      bucket: 'my-bucket',
      path: 'path/to/file.json',
    });
  });

  it('parses a gs URI with a top-level path', () => {
    expect(parseGcsUri('gs://bucket/file.parquet')).toEqual({
      bucket: 'bucket',
      path: 'file.parquet',
    });
  });

  it('parses a gs URI with an empty path', () => {
    expect(parseGcsUri('gs://bucket/')).toEqual({
      bucket: 'bucket',
      path: '',
    });
  });

  it('returns null for an s3:// URI', () => {
    expect(parseGcsUri('s3://bucket/key.parquet')).toBeNull();
  });

  it('returns null for an http URL', () => {
    expect(parseGcsUri('https://example.com/file.json')).toBeNull();
  });

  it('returns null for a non-string', () => {
    expect(parseGcsUri(null)).toBeNull();
    expect(parseGcsUri(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getExtensionFromKey
// ---------------------------------------------------------------------------
describe('getExtensionFromKey', () => {
  it('returns the extension from a simple filename', () => {
    expect(getExtensionFromKey('file.parquet')).toBe('parquet');
  });

  it('returns the extension from a nested path', () => {
    expect(getExtensionFromKey('path/to/data.csv')).toBe('csv');
  });

  it('lowercases the extension', () => {
    expect(getExtensionFromKey('DATA.PARQUET')).toBe('parquet');
  });

  it('returns empty string when there is no extension', () => {
    expect(getExtensionFromKey('no-extension')).toBe('');
  });

  it('returns empty string for a trailing dot', () => {
    expect(getExtensionFromKey('file.')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getBaseNameFromKey
// ---------------------------------------------------------------------------
describe('getBaseNameFromKey', () => {
  it('returns the basename from a nested path', () => {
    expect(getBaseNameFromKey('path/to/data.parquet')).toBe('data.parquet');
  });

  it('returns the entire string when there are no slashes', () => {
    expect(getBaseNameFromKey('file.csv')).toBe('file.csv');
  });

  it('returns the key itself for an empty string (no slashes)', () => {
    expect(getBaseNameFromKey('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// fetchS3AsBlob (mocked fetch)
// ---------------------------------------------------------------------------
describe('fetchS3AsBlob', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches from S3 anonymously and returns a Blob', async () => {
    const fakeBlob = new Blob(['parquet data'], { type: 'application/vnd.apache.parquet' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(fakeBlob),
    });

    const result = await fetchS3AsBlob('my-bucket', 'data/file.parquet', { region: 'eu-west-1' });

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('my-bucket.s3.eu-west-1.amazonaws.com');
    expect(url).toContain('data/file.parquet');
    expect(result).toBe(fakeBlob);
  });

  it('throws when S3 returns a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: () => Promise.resolve('<Error>Access Denied</Error>'),
    });

    await expect(
      fetchS3AsBlob('private-bucket', 'secret/file.parquet')
    ).rejects.toThrow('S3 fetch failed: HTTP 403 Forbidden');
  });

  it('includes auth headers when credentials are provided', async () => {
    const fakeBlob = new Blob(['csv data']);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(fakeBlob),
    });

    await fetchS3AsBlob('my-bucket', 'file.csv', {
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });

    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers).toBeDefined();
    expect(init.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256/);
    expect(init.headers['x-amz-date']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// fetchGcsAsBlob (mocked fetch)
// ---------------------------------------------------------------------------
describe('fetchGcsAsBlob', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches from GCS anonymously and returns a Blob', async () => {
    const fakeBlob = new Blob(['json data'], { type: 'application/json' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(fakeBlob),
    });

    const result = await fetchGcsAsBlob('gcs-bucket', 'folder/data.json');

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('storage.googleapis.com');
    expect(url).toContain(encodeURIComponent('gcs-bucket'));
    expect(url).toContain('alt=media');
    expect(result).toBe(fakeBlob);
  });

  it('includes Authorization header when an access token is provided', async () => {
    const fakeBlob = new Blob(['data']);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(fakeBlob),
    });

    await fetchGcsAsBlob('bucket', 'file.parquet', { accessToken: 'ya29.token' });

    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers['Authorization']).toBe('Bearer ya29.token');
  });

  it('throws when GCS returns a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve(''),
    });

    await expect(
      fetchGcsAsBlob('bucket', 'missing-file.parquet')
    ).rejects.toThrow('GCS fetch failed: HTTP 404 Not Found');
  });
});
