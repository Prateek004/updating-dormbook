'use strict';
/**
 * Off-site copies of the database backups and the encrypted ID-proof files.
 * Two places, both optional, both used when set up (a copy goes to each):
 *
 *  Cloudflare R2                         Supabase Storage (S3 protocol)
 *   R2_ACCOUNT_ID                         SUPABASE_URL                 https://<ref>.supabase.co
 *   R2_ACCESS_KEY_ID                      SUPABASE_S3_ACCESS_KEY_ID    Storage → S3 Connection → new access key
 *   R2_SECRET_ACCESS_KEY                  SUPABASE_S3_SECRET_ACCESS_KEY
 *   R2_BUCKET                             SUPABASE_S3_REGION           shown on the same page, e.g. ap-south-1
 *   R2_PREFIX (default "dormbook")        SUPABASE_BUCKET              private bucket (default "dormbook-backups")
 *   R2_ENDPOINT (optional)                SUPABASE_PREFIX (default "dormbook"), SUPABASE_S3_ENDPOINT (optional)
 *
 * Reading (restore, a missing ID photo) tries R2 first, then Supabase.
 * No extra npm package: requests are signed here with AWS Signature V4 (both speak the S3 API).
 * Nothing here ever throws into a request: callers get { ok:false, error } or null.
 */
const crypto = require('crypto');

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const EMPTY_SHA = sha256hex('');

const cleanPrefix = (v) => String(v || 'dormbook').replace(/[^a-zA-Z0-9._/-]/g, '').replace(/^\/+|\/+$/g, '') || 'dormbook';

function r2Config() {
  const accountId = (process.env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucket = (process.env.R2_BUCKET || '').trim();
  if (!accessKeyId || !secretAccessKey || !bucket || !(accountId || process.env.R2_ENDPOINT)) return null;
  const endpoint = (process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  return { name: 'R2', endpoint, accessKeyId, secretAccessKey, bucket, prefix: cleanPrefix(process.env.R2_PREFIX), region: 'auto' };
}

function supabaseConfig() {
  const accessKeyId = (process.env.SUPABASE_S3_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.SUPABASE_S3_SECRET_ACCESS_KEY || '').trim();
  const region = (process.env.SUPABASE_S3_REGION || '').trim();
  let endpoint = (process.env.SUPABASE_S3_ENDPOINT || '').trim();
  if (!endpoint) {
    const m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i.exec((process.env.SUPABASE_URL || '').trim());
    if (m) endpoint = `https://${m[1]}.storage.supabase.co/storage/v1/s3`;
  }
  if (!accessKeyId || !secretAccessKey || !region || !endpoint) return null;
  return { name: 'Supabase', endpoint: endpoint.replace(/\/+$/, ''), accessKeyId, secretAccessKey,
    bucket: (process.env.SUPABASE_BUCKET || 'dormbook-backups').trim(), prefix: cleanPrefix(process.env.SUPABASE_PREFIX), region };
}

/** Every place that is set up, in reading order (R2 first). */
function configs() { return [r2Config(), supabaseConfig()].filter(Boolean); }
function isConfigured() { return configs().length > 0; }
/** Names of the places that are set up, e.g. ["R2", "Supabase"]. */
function names() { return configs().map((c) => c.name); }

/** RFC 3986 encoding, as S3 wants it ("/" kept in paths). */
function enc(s, keepSlash) {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return keepSlash ? out.replace(/%2F/g, '/') : out;
}

/**
 * AWS Signature V4. Exported for the tests (checked against AWS's published examples).
 * headers: lower-case names → values (must include host, x-amz-date, x-amz-content-sha256).
 */
function signV4({ method, path, query = {}, headers, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', amzDate }) {
  const date = amzDate.slice(0, 8);
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join('&');
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let key = hmac(`AWS4${secretAccessKey}`, date);
  key = hmac(key, region); key = hmac(key, service); key = hmac(key, 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature, canonicalQuery,
  };
}

/** Only safe characters in object names (we build every key ourselves). */
function cleanKey(key) {
  const k = String(key || '').replace(/[^a-zA-Z0-9._/-]/g, '_').replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  if (!k || k.includes('..')) throw new Error('bad storage key');
  return k;
}

/** Full key inside the bucket, under that place's prefix. */
function fullKey(c, rel) {
  return cleanKey(`${c.prefix}/${cleanKey(rel)}`);
}

async function send(c, method, key, { body, query = {}, contentType, timeoutMs = 60000 } = {}) {
  const url = new URL(c.endpoint);
  // Supabase's S3 address has a path (/storage/v1/s3); R2's has none. The signature covers the whole path.
  const basePath = url.pathname.replace(/\/+$/, '');
  const path = `${basePath}/${enc(c.bucket)}${key ? '/' + enc(key, true) : ''}`;
  const payload = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
  const payloadHash = payload ? sha256hex(payload) : EMPTY_SHA;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const headers = { host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  if (contentType) headers['content-type'] = contentType;
  const { authorization, canonicalQuery } = signV4({ method, path, query, headers, payloadHash,
    accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, amzDate });
  const target = `${url.protocol}//${url.host}${path}${canonicalQuery ? '?' + canonicalQuery : ''}`;
  const reqHeaders = { ...headers, authorization };
  delete reqHeaders.host;
  return fetch(target, { method, headers: reqHeaders, body: payload || undefined, signal: AbortSignal.timeout(timeoutMs) });
}

/** Up to 3 tries for network errors and 5xx / 429 answers. */
async function withRetry(c, fn) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fn();
      if (res.status < 500 && res.status !== 429) return res;
      last = new Error(`${c.name} answered ${res.status}`);
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  throw last;
}

const xmlAll = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** One place (R2 or Supabase): put / get / delete / list. */
function store(c) {
  return {
    name: c.name,
    async put(rel, body, contentType = 'application/octet-stream') {
      try {
        const key = fullKey(c, rel);
        const res = await withRetry(c, () => send(c, 'PUT', key, { body, contentType, timeoutMs: 300000 }));
        if (!res.ok) return { ok: false, error: `${c.name} upload failed (${res.status}): ${(await res.text()).slice(0, 200)}` };
        return { ok: true, key };
      } catch (e) { return { ok: false, error: `${c.name}: ${e.message}` }; }
    },
    async get(rel) {
      try {
        const key = fullKey(c, rel);
        const res = await withRetry(c, () => send(c, 'GET', key, { timeoutMs: 300000 }));
        if (res.status === 404 || res.status === 400) return null;   // Supabase answers 400 for a missing object
        if (!res.ok) { console.error(`[OFFSITE] ${c.name} download ${key} failed: ${res.status}`); return null; }
        return Buffer.from(await res.arrayBuffer());
      } catch (e) { console.error(`[OFFSITE] ${c.name} download failed:`, e.message); return null; }
    },
    async del(rel) {
      try {
        const res = await withRetry(c, () => send(c, 'DELETE', fullKey(c, rel)));
        return { ok: res.ok || res.status === 404 };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    /** [{ key (relative to the prefix), size, last_modified }] — at most maxPages × 1000 objects. */
    async list(relPrefix, { maxPages = 20 } = {}) {
      const base = `${c.prefix}/`;
      const prefix = fullKey(c, relPrefix).replace(/\/?$/, '/');
      const out = [];
      let token = null;
      for (let page = 0; page < maxPages; page++) {
        const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
        if (token) query['continuation-token'] = token;
        const res = await withRetry(c, () => send(c, 'GET', '', { query }));
        if (!res.ok) throw new Error(`${c.name} list failed (${res.status})`);
        const xml = await res.text();
        for (const item of xmlAll(xml, 'Contents')) {
          const key = unxml((xmlAll(item, 'Key')[0] || ''));
          out.push({ key: key.startsWith(base) ? key.slice(base.length) : key,
            size: Number(xmlAll(item, 'Size')[0] || 0), last_modified: xmlAll(item, 'LastModified')[0] || null });
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(xmlAll(xml, 'NextContinuationToken')[0] || '') : null;
        if (!token) break;
      }
      return out;
    },
  };
}

/** Every place that is set up, as store objects. */
function stores() { return configs().map(store); }

// ── The same calls over ALL places (what the rest of the app uses) ─────────────

/** Copy to every place. ok when at least one place has it; `results` says which. */
async function putObject(rel, body, contentType) {
  const list = stores();
  if (!list.length) return { ok: false, skipped: true };
  const results = await Promise.all(list.map(async (st) => ({ store: st.name, ...(await st.put(rel, body, contentType)) })));
  const failed = results.filter((r) => !r.ok);
  for (const f of failed) console.error('[OFFSITE]', f.error);
  return { ok: failed.length < results.length, results, error: failed.map((f) => f.error).join('; ') || undefined };
}

/** First place that has it (R2, then Supabase), or null. */
async function getObject(rel) {
  for (const st of stores()) {
    const buf = await st.get(rel);
    if (buf) return buf;
  }
  return null;
}

async function deleteObject(rel) {
  const list = stores();
  if (!list.length) return { ok: false, skipped: true };
  const results = await Promise.all(list.map((st) => st.del(rel)));
  return { ok: results.every((r) => r.ok) };
}

/** Listing from the first place that answers. */
async function listObjects(relPrefix, opts) {
  let last = null;
  for (const st of stores()) {
    try { return await st.list(relPrefix, opts); } catch (e) { last = e; }
  }
  if (last) throw last;
  return [];
}

module.exports = { isConfigured, names, configs, stores, signV4, putObject, getObject, deleteObject, listObjects };
