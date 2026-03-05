/**
 * Utilities for loading data from cloud object storage (S3, GCS) client-side.
 * Objects are fetched via the respective HTTP APIs and returned as Blobs,
 * which can then be registered with DuckDB WASM using BROWSER_FILEREADER.
 */

/**
 * Parse an S3 URI into its components.
 * @param {string} uri  e.g. "s3://my-bucket/path/to/file.parquet"
 * @returns {{ bucket: string, key: string } | null}
 */
export function parseS3Uri(uri) {
  if (typeof uri !== 'string') {
    return null;
  }
  const match = uri.match(/^s3:\/\/([^/]+)\/(.*)$/);
  if (!match) {
    return null;
  }
  return { bucket: match[1], key: match[2] };
}

/**
 * Parse a GCS URI into its components.
 * @param {string} uri  e.g. "gs://my-bucket/path/to/file.parquet"
 * @returns {{ bucket: string, path: string } | null}
 */
export function parseGcsUri(uri) {
  if (typeof uri !== 'string') {
    return null;
  }
  const match = uri.match(/^gs:\/\/([^/]+)\/(.*)$/);
  if (!match) {
    return null;
  }
  return { bucket: match[1], path: match[2] };
}

/**
 * Derive a safe file extension from a key/path string.
 * Falls back to empty string if no extension is found.
 * @param {string} keyOrPath
 * @returns {string}
 */
export function getExtensionFromKey(keyOrPath) {
  const baseName = keyOrPath.split('/').pop() || '';
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === baseName.length - 1) {
    return '';
  }
  return baseName.slice(dotIndex + 1).toLowerCase();
}

/**
 * Derive a base filename from a key/path string.
 * @param {string} keyOrPath
 * @returns {string}
 */
export function getBaseNameFromKey(keyOrPath) {
  return keyOrPath.split('/').pop() || keyOrPath;
}

/**
 * Fetch an object from Amazon S3 and return it as a Blob.
 * For public buckets, pass no credentials.
 * For private buckets, provide accessKeyId + secretAccessKey (and optionally sessionToken).
 *
 * This uses the S3 REST API with AWS Signature Version 4 for authenticated
 * requests, or a plain HTTPS GET for anonymous access.
 *
 * @param {string} bucket
 * @param {string} key
 * @param {{ region?: string, accessKeyId?: string, secretAccessKey?: string, sessionToken?: string } | undefined} options
 * @returns {Promise<Blob>}
 */
export async function fetchS3AsBlob(bucket, key, options = {}) {
  const region = options.region || 'us-east-1';
  const { accessKeyId, secretAccessKey, sessionToken } = options;

  const useAnonymous = !accessKeyId || !secretAccessKey;

  // Build the HTTPS URL for the S3 object
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`;

  let headers = {};

  if (!useAnonymous) {
    // Build AWS Signature Version 4 signed headers
    headers = await buildAwsSigV4Headers({
      method: 'GET',
      url,
      region,
      service: 's3',
      accessKeyId,
      secretAccessKey,
      sessionToken,
    });
  }

  const response = await fetch(url, { method: 'GET', headers });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`S3 fetch failed: HTTP ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`);
  }

  return response.blob();
}

/**
 * Fetch an object from Google Cloud Storage and return it as a Blob.
 * For public buckets, pass no credentials.
 * For private access, provide an OAuth2 access token.
 *
 * @param {string} bucket
 * @param {string} path
 * @param {{ accessToken?: string } | undefined} options
 * @returns {Promise<Blob>}
 */
export async function fetchGcsAsBlob(bucket, path, options = {}) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://storage.googleapis.com/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodedPath}?alt=media`;

  const headers = {};
  if (options.accessToken) {
    headers['Authorization'] = `Bearer ${options.accessToken}`;
  }

  const response = await fetch(url, { method: 'GET', headers });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GCS fetch failed: HTTP ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`);
  }

  return response.blob();
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4 implementation (minimal, no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Build AWS SigV4 Authorization headers for a GET request.
 * @param {{ method: string, url: string, region: string, service: string, accessKeyId: string, secretAccessKey: string, sessionToken?: string }} params
 * @returns {Promise<Record<string, string>>}
 */
async function buildAwsSigV4Headers({ method, url, region, service, accessKeyId, secretAccessKey, sessionToken }) {
  const urlObj = new URL(url);
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    'host': urlObj.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // SHA-256 of empty string
  };
  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken;
  }

  // Canonical request
  const canonicalUri = urlObj.pathname;
  const canonicalQueryString = '';
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const payloadHash = headers['x-amz-content-sha256'];

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // String to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [algorithm, amzDate, credentialScope, canonicalRequestHash].join('\n');

  // Signing key
  const signingKey = await getSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const result = {};
  for (const [k, v] of Object.entries(headers)) {
    result[k.toLowerCase()] = v;
  }
  result['authorization'] = authorizationHeader;
  delete result['host']; // fetch sets Host automatically
  return result;
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
}

async function sha256Hex(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return bufferToHex(hashBuffer);
}

async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function hmacHex(key, message) {
  const buf = await hmacSha256(key, message);
  return bufferToHex(buf);
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSigningKey(secretKey, dateStamp, region, service) {
  const kDate = await hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  return kSigning;
}
