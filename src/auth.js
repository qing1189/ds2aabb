import { config } from 'dotenv';
config();

const BASE_URL = 'https://chat.deepseek.com';

const MAX_CONCURRENT_PER_TOKEN = 2;
const TOKEN_DEAD_THRESHOLD = 5;

// Multi-token support: DS_TOKENS=token1,token2,token3 (comma-separated)
// Fallback: DS_TOKEN=single_token
// Account support: DS_ACCOUNTS=email1:pass1,email2:pass2 (auto-login to refresh tokens)
export function loadTokens() {
  const tokensStr = process.env.DS_TOKENS?.trim();
  if (tokensStr) {
    return tokensStr.split(',').map(t => t.trim()).filter(Boolean);
  }
  const single = process.env.DS_TOKEN?.trim();
  if (single) return [single];
  return [];
}

export function loadAccounts() {
  const accountsStr = process.env.DS_ACCOUNTS?.trim();
  if (!accountsStr) return [];
  return accountsStr.split(',').map(entry => {
    const [email, ...passParts] = entry.trim().split(':');
    const password = passParts.join(':');
    return email && password ? { email, password } : null;
  }).filter(Boolean);
}

const tokens = loadTokens();
const accounts = loadAccounts();
if (tokens.length === 0 && accounts.length === 0) {
  console.warn('Warning: No DS_TOKEN/DS_TOKENS or DS_ACCOUNTS configured. Add accounts via admin panel.');
}

// DS_ACCOUNTS_EXTENDED=email:password:token_prefix — links existing tokens to accounts
function loadAccountTokens() {
  const extStr = process.env.DS_ACCOUNTS_EXTENDED?.trim();
  if (!extStr) return [];
  return extStr.split(',').map(entry => {
    const parts = entry.trim().split(':');
    if (parts.length >= 3) return { email: parts[0], password: parts[1], tokenPrefix: parts[2] };
    return null;
  }).filter(Boolean);
}

const accountTokenMap = loadAccountTokens();

// Token metadata: { token, email, password, visionCapable, lastUsed, errorCount, activeRequests, dead }
const tokenPool = tokens.map(t => ({
  token: t,
  email: null,
  password: null,
  visionCapable: null,
  lastUsed: 0,
  errorCount: 0,
  activeRequests: 0,
  dead: false,
}));

// Link existing tokens to accounts via token prefix
for (const entry of tokenPool) {
  if (!entry.token) continue;
  const prefix = entry.token.slice(0, 12);
  const match = accountTokenMap.find(a => a.tokenPrefix === prefix);
  if (match) {
    entry.email = match.email;
    entry.password = match.password;
  }
}

// Create pool entries for accounts without matching tokens (will login on init)
for (const acct of accounts) {
  const alreadyLinked = tokenPool.some(t => t.email === acct.email);
  if (!alreadyLinked) {
    tokenPool.push({
      token: null,
      email: acct.email,
      password: acct.password,
      visionCapable: null,
      lastUsed: 0,
      errorCount: 0,
      activeRequests: 0,
      dead: false,
    });
  }
}

import { loginHeaders, getHeaders, getDeviceId, proxiedFetch } from './headers.js';
import { loginProxiedFetch } from './proxy.js';

async function login(account, password) {
  // account can be email or phone number (e.g. +8613800138000 or 13800138000)
  // DeepSeek API accepts both in the "email" field
  const isPhone = /^\+?\d{10,15}$/.test(account.replace(/\s/g, ''));
  const loginBody = isPhone
    ? { mobile: account.replace(/\s/g, ''), password, device_id: getDeviceId(), os: 'web' }
    : { email: account, password, device_id: getDeviceId(), os: 'web' };

  // Use login-specific proxy (xiequ/manual) to bypass WAF
  // Note: acquireLoginProxy() fetches a fresh proxy from xiequ API each time (short-lived proxies)
  const res = await loginProxiedFetch(`${BASE_URL}/api/v0/users/login`, {
    method: 'POST',
    headers: loginHeaders(),
    body: JSON.stringify(loginBody),
  });

  // AWS WAF returns 202 with empty body — can't login from this IP
  if (res.status === 202) {
    throw new Error('WAF challenge (202) — login blocked from this IP, use external refresh');
  }

  const text = await res.text();
  if (!text) throw new Error('Empty response from login endpoint');

  const json = JSON.parse(text);
  if (json.code !== 0) throw new Error(`Login failed for ${account}: ${json.msg || JSON.stringify(json)}`);

  const bizCode = json.data?.biz_code;
  if (bizCode === 10) throw new Error(`Account banned: ${account}`);

  const token = json.data?.biz_data?.user?.token;
  if (!token) throw new Error(`Login succeeded but no token returned for ${account}`);
  return token;
}

async function checkVisionCapability(token) {
  try {
    const res = await proxiedFetch(`${BASE_URL}/api/v0/client/settings?did=${getDeviceId()}&scope=model`, {
      headers: getHeaders(token),
    });
    const json = await res.json();
    const configs = json.data?.biz_data?.settings?.model_configs?.value || [];
    const visionConfig = configs.find(c => c.model_type === 'vision');
    if (visionConfig) {
      return visionConfig.switchable === true;
    }
    return false;
  } catch {
    return null;
  }
}

// Check if a token is still valid — uses /users/current which actually validates the token
// (unlike /client/settings which returns code:0 even for invalid tokens)
async function validateToken(token) {
  try {
    const res = await proxiedFetch(`${BASE_URL}/api/v0/users/current`, {
      headers: getHeaders(token),
    });
    const json = await res.json();
    return json.code === 0;
  } catch {
    return false;
  }
}

// Refresh a dead token entry — login if account credentials exist
async function refreshToken(entry) {
  if (!entry.password) return false;
  try {
    // entry.email stores the account identifier (email or phone number)
    const newToken = await login(entry.email, entry.password);
    entry.token = newToken;
    entry.errorCount = 0;
    entry.dead = false;
    const vision = await checkVisionCapability(newToken);
    entry.visionCapable = vision;
    console.log(`  Refreshed token for ${entry.email}: ${newToken.slice(0, 12)}... vision=${vision}`);
    return true;
  } catch (err) {
    console.warn(`  Refresh failed for ${entry.email}: ${err.message}`);
    // If account is banned, mark dead permanently
    if (err.message.includes('banned')) {
      entry.dead = true;
      entry.errorCount = TOKEN_DEAD_THRESHOLD;
    }
    return false;
  }
}

export async function initTokenPool(persistedPool) {
  // ─── Merge persisted entries (tokens/accounts added via admin panel) ───
  if (Array.isArray(persistedPool)) {
    for (const entry of persistedPool) {
      const existsByToken = entry.token && tokenPool.some(t => t.token === entry.token);
      const existsByEmail = entry.email && tokenPool.some(t => t.email === entry.email);
      if (!existsByToken && !existsByEmail) {
        tokenPool.push({
          token: entry.token || null,
          email: entry.email || null,
          password: entry.password || null,
          visionCapable: entry.visionCapable ?? null,
          lastUsed: 0,
          errorCount: entry.errorCount || 0,
          activeRequests: 0,
          dead: entry.dead || false,
        });
        if (entry.token) {
          console.log(`[Persist] Restored token: ${entry.token.slice(0, 12)}... ${entry.email ? `(${entry.email})` : ''}`);
        } else if (entry.email) {
          console.log(`[Persist] Restored account: ${entry.email}`);
        }
      }
    }
  }

  console.log(`Token pool: ${tokenPool.length} entries (${tokens.length} tokens + ${accounts.length} accounts), max ${MAX_CONCURRENT_PER_TOKEN} concurrent each`);

  // Validate existing tokens, mark dead ones (auto-refresh if account linked)
  for (const entry of tokenPool) {
    if (entry.token) {
      const valid = await validateToken(entry.token);
      if (!valid) {
        console.log(`  ${entry.token.slice(0, 12)}... INVALID — ${entry.password ? 'attempting refresh' : 'no account to refresh'}`);
        if (entry.password) {
          const ok = await refreshToken(entry);
          if (ok) {
            // Remove duplicate account-only entries that now have same email
            const dupIdx = tokenPool.findIndex(t => t !== entry && t.email === entry.email && !t.token);
            if (dupIdx !== -1) {
              console.log(`  Removing duplicate account entry for ${entry.email}`);
              tokenPool.splice(dupIdx, 1);
            }
          }
        } else {
          entry.dead = true;
          entry.errorCount = TOKEN_DEAD_THRESHOLD;
        }
      }
    }
  }

  // Login account-only entries (no token yet) — remove if banned/WAF-blocked
  for (let i = tokenPool.length - 1; i >= 0; i--) {
    const entry = tokenPool[i];
    if (!entry.token && entry.password) {
      const ok = await refreshToken(entry);
      if (!ok && entry.dead) {
        // Banned or permanently failed — remove from pool
        console.log(`  Removing banned/failed account entry for ${entry.email}`);
        tokenPool.splice(i, 1);
      }
    }
  }

  // Also remove account entries with no token and no password (stale NONE entries)
  for (let i = tokenPool.length - 1; i >= 0; i--) {
    if (!tokenPool[i].token && !tokenPool[i].password) {
      console.log(`  Removing stale NONE entry at index ${i}`);
      tokenPool.splice(i, 1);
    }
  }

  // Check vision capability for valid tokens
  for (const entry of tokenPool) {
    if (entry.token && !entry.dead) {
      const vision = await checkVisionCapability(entry.token);
      entry.visionCapable = vision;
      const label = vision === true ? 'vision=YES' : vision === false ? 'vision=NO' : 'vision=UNKNOWN';
      console.log(`  ${entry.token.slice(0, 12)}... ${label} ${entry.email ? `(${entry.email})` : ''}`);
    }
  }

  const alive = tokenPool.filter(t => !t.dead).length;
  console.log(`Pool ready: ${alive}/${tokenPool.length} tokens alive`);
}

export function acquireToken(preferVision = false) {
  let candidates = tokenPool.filter(t => !t.dead && t.activeRequests < MAX_CONCURRENT_PER_TOKEN && t.token);

  if (preferVision) {
    const visionTokens = candidates.filter(t => t.visionCapable === true);
    if (visionTokens.length > 0) candidates = visionTokens;
  } else {
    const nonVisionTokens = candidates.filter(t => t.visionCapable !== true);
    if (nonVisionTokens.length > 0) candidates = nonVisionTokens;
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.activeRequests - b.activeRequests);
  const chosen = candidates[0];
  chosen.activeRequests++;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    chosen.activeRequests = Math.max(0, chosen.activeRequests - 1);
  };

  return { token: chosen.token, account: chosen, release };
}

export function reportTokenError(token) {
  const entry = tokenPool.find(t => t.token === token);
  if (!entry) return;
  entry.errorCount++;

  if (entry.errorCount >= TOKEN_DEAD_THRESHOLD) {
    entry.dead = true;
    console.warn(`Token ${token.slice(0, 12)}... marked DEAD (errorCount=${entry.errorCount})`);

    // Try auto-refresh if account credentials exist
    if (entry.password) {
      refreshToken(entry).then(ok => {
        if (ok) {
          invalidateTokenSessions(token);
        }
      });
    }
  }
}

export function reportTokenSuccess(token) {
  const entry = tokenPool.find(t => t.token === token);
  if (!entry) return;
  entry.errorCount = 0;
  if (entry.dead) {
    entry.dead = false;
    console.log(`Token ${token.slice(0, 12)}... revived (was dead, now working)`);
  }
}

// Invalidate cached sessions for a token (after refresh)
function invalidateTokenSessions(token) {
  const prefix = token.slice(0, 12);
  // Dynamic import to avoid circular dependency
  import('./session.js').then(m => m.invalidateTokenSessions(prefix)).catch(() => {});
}

// Legacy: pickToken returns just the token string
let tokenIndex = 0;
export function pickToken(preferVision = false) {
  let candidates = tokenPool.filter(t => !t.dead && t.token);

  if (preferVision) {
    const visionTokens = candidates.filter(t => t.visionCapable === true);
    if (visionTokens.length > 0) candidates = visionTokens;
  } else {
    const nonVisionTokens = candidates.filter(t => t.visionCapable !== true);
    if (nonVisionTokens.length > 0) candidates = nonVisionTokens;
  }

  if (candidates.length === 0) {
    // Absolute fallback — use any token with a token string
    candidates = tokenPool.filter(t => t.token);
    if (candidates.length === 0) throw new Error('No tokens available in pool');
  }

  const idx = tokenIndex % candidates.length;
  const chosen = candidates[idx];
  tokenIndex++;
  return chosen.token;
}

// Legacy: sticky per-request token
let currentRequestToken = null;

export function setRequestToken(token) {
  currentRequestToken = token;
}

export function getRequestToken() {
  return currentRequestToken;
}

export async function getToken(preferVision = false) {
  if (currentRequestToken) return currentRequestToken;
  return pickToken(preferVision);
}

// Legacy: email/password login (adds to pool dynamically)
export async function loginAndAddToken(email, password) {
  const token = await login(email, password);
  const existing = tokenPool.find(t => t.token === token);
  if (!existing) {
    const vision = await checkVisionCapability(token);
    tokenPool.push({ token, email, password, visionCapable: vision, lastUsed: 0, errorCount: 0, activeRequests: 0, dead: false });
  }
  return token;
}

export async function addTokenToPool(tokenStr) {
  const trimmed = tokenStr.trim();
  const existing = tokenPool.find(t => t.token === trimmed);
  if (existing) return existing;
  const vision = await checkVisionCapability(trimmed);
  const entry = { token: trimmed, email: null, password: null, visionCapable: vision, lastUsed: 0, errorCount: 0, activeRequests: 0, dead: false };
  tokenPool.push(entry);
  return entry;
}

export function getPoolInfo() {
  return tokenPool.map(t => ({
    token: t.token ? t.token.slice(0, 12) + '...' : 'NONE',
    email: t.email || null,
    visionCapable: t.visionCapable,
    errorCount: t.errorCount,
    activeRequests: t.activeRequests,
    dead: t.dead,
    maxConcurrent: MAX_CONCURRENT_PER_TOKEN,
  }));
}

export function getAliveTokens() {
  return tokenPool.filter(t => !t.dead && t.token).map(t => t.token);
}

export function getTotalCapacity() {
  return tokenPool.filter(t => !t.dead).length * MAX_CONCURRENT_PER_TOKEN;
}

// === Account management (hot-reload, no restart needed) ===

// Add account to pool: login immediately, get token, add to pool
export async function addAccountToPool(email, password) {
  // Support both email and phone number
  const trimmedAccount = email.trim();
  const accountKey = trimmedAccount.includes('@') ? trimmedAccount.toLowerCase() : trimmedAccount;
  const existing = tokenPool.find(t => t.email === accountKey);
  if (existing) {
    // Account already exists — try refresh if dead
    if (existing.dead || !existing.token) {
      existing.password = password;
      const ok = await refreshToken(existing);
      if (!ok) throw new Error(`Account ${accountKey} login failed`);
      return { email: accountKey, token: existing.token.slice(0, 12) + '...', visionCapable: existing.visionCapable, refreshed: true };
    }
    return { email: accountKey, token: existing.token.slice(0, 12) + '...', visionCapable: existing.visionCapable, refreshed: false, message: 'Account already exists in pool' };
  }

  // New account — login and add
  const token = await login(accountKey, password);
  const vision = await checkVisionCapability(token);
  const entry = {
    token,
    email: accountKey,
    password,
    visionCapable: vision,
    lastUsed: 0,
    errorCount: 0,
    activeRequests: 0,
    dead: false,
  };
  tokenPool.push(entry);
  console.log(`[HotReload] Added account ${accountKey}: ${token.slice(0, 12)}... vision=${vision}`);
  return { email: accountKey, token: token.slice(0, 12) + '...', visionCapable: vision, refreshed: false };
}

// List all accounts in pool
export function listAccounts() {
  return tokenPool
    .filter(t => t.email)
    .map(t => ({
      email: t.email,
      token: t.token ? t.token.slice(0, 12) + '...' : 'NONE',
      visionCapable: t.visionCapable,
      errorCount: t.errorCount,
      activeRequests: t.activeRequests,
      dead: t.dead,
      maxConcurrent: MAX_CONCURRENT_PER_TOKEN,
    }));
}

// Remove account from pool (hot-reload) — also removes the associated token
export function removeAccountFromPool(email) {
  const trimmedAccount = email.trim();
  const accountKey = trimmedAccount.includes('@') ? trimmedAccount.toLowerCase() : trimmedAccount;
  const idx = tokenPool.findIndex(t => t.email === accountKey);
  if (idx === -1) {
    return { success: false, message: `Account ${accountKey} not found in pool` };
  }
  const entry = tokenPool[idx];
  if (entry.activeRequests > 0) {
    return { success: false, message: `Account ${accountKey} has active requests, cannot remove now` };
  }
  tokenPool.splice(idx, 1);
  // Invalidate sessions for this token
  if (entry.token) {
    invalidateTokenSessions(entry.token);
  }
  console.log(`[HotReload] Removed account ${accountKey} (and its token) from pool`);
  return { success: true, message: `Account ${accountKey} removed` };
}

// Remove token from pool by token prefix (hot-reload)
export function removeTokenFromPool(tokenPrefix) {
  const trimmed = tokenPrefix.trim();
  const idx = tokenPool.findIndex(t => t.token && t.token.startsWith(trimmed));
  if (idx === -1) {
    return { success: false, message: `Token ${trimmed}... not found in pool` };
  }
  const entry = tokenPool[idx];
  if (entry.activeRequests > 0) {
    return { success: false, message: `Token ${trimmed}... has active requests, cannot remove now` };
  }
  const tokenStr = entry.token;
  tokenPool.splice(idx, 1);
  // Invalidate sessions for this token
  if (tokenStr) {
    invalidateTokenSessions(tokenStr);
  }
  console.log(`[HotReload] Removed token ${trimmed}... from pool`);
  return { success: true, message: `Token ${trimmed}... removed` };
}


// ─── Persistence support ───

export function getTokenPoolRaw() {
  return tokenPool;
}
