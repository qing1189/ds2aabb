// Mimic real Chrome 120 browser session
const UA_VERSION = '120.0.0.0';
const UA_MAJOR = '120';

const BROWSER_HEADERS = {
  'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${UA_VERSION} Safari/537.36`,
  'accept-language': 'zh-CN,zh;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'origin': 'https://chat.deepseek.com',
  'referer': 'https://chat.deepseek.com/',
  'sec-ch-ua': `"Not_A Brand";v="8", "Chromium";v="${UA_MAJOR}", "Google Chrome";v="${UA_MAJOR}"`,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'x-client-timezone-offset': '28800',
};

// Per-token cookie jar: smidV2, HWWAFSESTIME, HWWAFSESID, ds_session_id, thumbcache
const tokenCookies = new Map();

function randomHex(len) {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

function randomAlphaNum(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function ensureCookies(token) {
  if (tokenCookies.has(token)) return tokenCookies.get(token);
  const smidV2 = `20260520${randomAlphaNum(10)}${randomHex(24)}`;
  const HWWAFSESTIME = `${Date.now()}`;
  const HWWAFSESID = `${randomAlphaNum(4)}${randomHex(12)}`;
  const dsSessionId = `${randomHex(32)}`;
  const thumbcache = `${randomAlphaNum(16)}=${Buffer.from(randomHex(32)).toString('base64')}`;
  const cookie = `smidV2=${smidV2}; HWWAFSESTIME=${HWWAFSESTIME}; HWWAFSESID=${HWWAFSESID}; ds_session_id=${dsSessionId}; .thumbcache_${randomHex(32)}=${thumbcache}`;
  tokenCookies.set(token, cookie);
  return cookie;
}

// Proxy dispatcher for bypassing IP-based rate limits
let proxyDispatcher = null;

export async function getDispatcher() {
  if (proxyDispatcher !== null) return proxyDispatcher;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxyUrl) {
    proxyDispatcher = false; // No proxy configured
    return false;
  }
  try {
    const { ProxyAgent } = await import('undici');
    proxyDispatcher = new ProxyAgent(proxyUrl);
    console.log(`Proxy enabled: ${proxyUrl}`);
    return proxyDispatcher;
  } catch (e) {
    console.warn(`Failed to init proxy (${proxyUrl}): ${e.message}`);
    proxyDispatcher = false;
    return false;
  }
}

// Common headers for API requests
export function apiHeaders(token, extra = {}) {
  return {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'accept': '*/*',
    'x-app-version': '2.0.0',
    'x-client-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'zh_CN',
    'cookie': ensureCookies(token),
    ...BROWSER_HEADERS,
    ...extra,
  };
}

// Headers for SSE streaming requests
export function streamHeaders(token, powResponse, extra = {}) {
  return {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'x-ds-pow-response': powResponse,
    'accept': 'text/event-stream',
    'x-app-version': '2.0.0',
    'x-client-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'zh_CN',
    'cookie': ensureCookies(token),
    ...BROWSER_HEADERS,
    ...extra,
  };
}

// Headers for GET requests (no content-type)
export function getHeaders(token, extra = {}) {
  return {
    'authorization': `Bearer ${token}`,
    'accept': '*/*',
    'x-app-version': '2.0.0',
    'x-client-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'zh_CN',
    'cookie': ensureCookies(token),
    ...BROWSER_HEADERS,
    ...extra,
  };
}

// Headers for login (no token)
export function loginHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    'accept': '*/*',
    'x-app-version': '2.0.0',
    'x-client-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'zh_CN',
    ...BROWSER_HEADERS,
    ...extra,
  };
}

// Device ID for settings endpoint
const deviceId = randomHex(8) + '-' + randomHex(4) + '-' + randomHex(4) + '-' + randomHex(4) + '-' + randomHex(12);
export function getDeviceId() { return deviceId; }

// Wrap fetch to use proxy dispatcher when available
export async function proxiedFetch(url, options = {}) {
  const dispatcher = await getDispatcher();
  if (dispatcher) {
    options.dispatcher = dispatcher;
  }
  return fetch(url, options);
}
