// Sync crypto: AES-GCM 256 envelopes and pairing codes. Uses only globalThis.crypto
// (Node, Electron and Android WebView). No Buffer dependency.
(function (root) {
  'use strict';

  const PREFIX = 'CCSYNC1.';
  const BAD_CODE = 'Not a Client Clusters pairing code';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function bytesToB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlToBytes(str) {
    if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) {
      throw new Error('Invalid base64url');
    }
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    const b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  }

  async function generateKey() { return bytesToB64url(randomBytes(32)); }
  function randomToken() { return bytesToB64url(randomBytes(32)); }

  function importKey(keyB64, usage) {
    return globalThis.crypto.subtle.importKey('raw', b64urlToBytes(keyB64), { name: 'AES-GCM' }, false, [usage]);
  }

  async function encrypt(keyB64, obj, aad) {
    const key = await importKey(keyB64, 'encrypt');
    const iv = randomBytes(12);
    const ct = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(String(aad)) },
      key,
      enc.encode(JSON.stringify(obj))
    );
    return { iv: bytesToB64url(iv), ct: bytesToB64url(new Uint8Array(ct)) };
  }

  async function decrypt(keyB64, env, aad) {
    const key = await importKey(keyB64, 'decrypt');
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlToBytes(env.iv), additionalData: enc.encode(String(aad)) },
      key,
      b64urlToBytes(env.ct)
    );
    return JSON.parse(dec.decode(pt));
  }

  // https anywhere, or plain http only for this very computer. Parsed with URL, never with a regex on the raw text.
  function allowedRelayUrl(str) {
    let u;
    try { u = new URL(str); } catch { return false; }
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return !!u.hostname;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  }

  // deviceId / pcDeviceId (relay ids of the phone and of the PC) are optional extras the phone needs to sync.
  function encodePairing({ url, token, key, name, deviceId, pcDeviceId }) {
    const obj = { url, token, key, name };
    if (deviceId !== undefined) obj.deviceId = deviceId;
    if (pcDeviceId !== undefined) obj.pcDeviceId = pcDeviceId;
    return PREFIX + bytesToB64url(enc.encode(JSON.stringify(obj)));
  }

  function decodePairing(str) {
    try {
      if (typeof str !== 'string') throw new Error();
      const s = str.trim();
      if (!s.startsWith(PREFIX)) throw new Error();
      const obj = JSON.parse(dec.decode(b64urlToBytes(s.slice(PREFIX.length))));
      if (!obj || typeof obj !== 'object') throw new Error();
      const { url, token, key } = obj;
      if (typeof url !== 'string' || typeof token !== 'string' || typeof key !== 'string' || !token || !key) throw new Error();
      if (!allowedRelayUrl(url)) throw new Error();
      if (b64urlToBytes(key).length !== 32) throw new Error();
      return obj;
    } catch (e) {
      throw new Error(BAD_CODE);
    }
  }

  const api = { allowedRelayUrl, generateKey, randomToken, encrypt, decrypt, encodePairing, decodePairing };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SyncCrypto = api;
})(typeof window !== 'undefined' ? window : globalThis);
