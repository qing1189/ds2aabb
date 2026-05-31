import { config } from 'dotenv';
config();

import express from 'express';
import { initTokenPool, getPoolInfo, getTotalCapacity, addTokenToPool, loginAndAddToken, getAliveTokens, addAccountToPool, listAccounts, removeAccountFromPool, removeTokenFromPool, getTokenPoolRaw } from './auth.js';
import { prewarmSessions, getSessionInfo, deleteSession, clearAllSessions, getSessionPoolRaw } from './session.js';
import { handleOpenAICompletion, handleOpenAIModels, handleOpenAIModelById } from './openai.js';
import { handleDeepSeekCompletion } from './deepseek.js';
import { getQueueInfo } from './queue.js';
import { getProxyConfig, setManualProxy, setXiequApiUrl, fetchXiequProxy, checkProxy, restoreProxyConfig } from './proxy.js';
import { validateApiKey, isApiKeyRequired, validateAdminPassword, isAdminAuthRequired, getAdminPassword, listApiKeys, addApiKey, removeApiKey, getApiKeysRaw, restoreApiKeys } from './apikeys.js';
import { loadState, saveState, saveStateSync, buildPersistState } from './persist.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const startTime = Date.now();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// === Auth Middlewares ===

// API Key auth — only for model call endpoints
function apiKeyAuth(req, res, next) {
  if (!isApiKeyRequired()) return next();
  const auth = req.headers['authorization'];
  const key = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  if (validateApiKey(key)) return next();
  res.status(401).json({ error: { message: 'Invalid API key' } });
}

// Admin panel auth — uses ADMIN_PASSWORD (separate from API Key)
function adminAuth(req, res, next) {
  if (!isAdminAuthRequired()) return next();
  const auth = req.headers['authorization'];
  const password = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  if (validateAdminPassword(password)) return next();
  res.status(401).json({ error: { message: 'Invalid admin password' } });
}

// === Model API endpoints (protected by API Key) ===

app.post('/v1/chat/completions', apiKeyAuth, handleOpenAICompletion);
app.get('/v1/models', apiKeyAuth, handleOpenAIModels);
app.get('/v1/models/:id', apiKeyAuth, handleOpenAIModelById);
app.post('/api/v0/chat/completion', apiKeyAuth, handleDeepSeekCompletion);

// Health check (public)
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.1.0',
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
  });
});

// === Admin panel (protected by ADMIN_PASSWORD) ===

app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, 'admin', 'index.html'));
});

app.get('/admin/api/stats', adminAuth, (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  res.json({
    status: 'ok',
    version: '2.1.0',
    uptimeSeconds,
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
    sessions: getSessionInfo(),
  });
});

// --- Token management ---

app.post('/admin/api/token/add', adminAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: { message: 'token required' } });
  }
  try {
    const added = await addTokenToPool(token);
    res.json({ success: true, visionCapable: added.visionCapable });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/token/remove', adminAuth, (req, res) => {
  const { tokenPrefix } = req.body;
  if (!tokenPrefix) {
    return res.status(400).json({ error: { message: 'tokenPrefix required' } });
  }
  const result = removeTokenFromPool(tokenPrefix);
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

app.post('/admin/api/token/login', adminAuth, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'email and password required' } });
  }
  try {
    const token = await loginAndAddToken(email, password);
    res.json({ success: true, token: token.slice(0, 12) + '...' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// --- Account management ---

app.post('/admin/api/account/add', adminAuth, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'email and password required' } });
  }
  try {
    const result = await addAccountToPool(email, password);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/admin/api/accounts', adminAuth, (req, res) => {
  res.json({ success: true, accounts: listAccounts() });
});

app.post('/admin/api/account/remove', adminAuth, (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: { message: 'email required' } });
  }
  const result = removeAccountFromPool(email);
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

// --- Session management ---

app.post('/admin/api/session/delete', adminAuth, (req, res) => {
  const { cacheKey } = req.body;
  if (!cacheKey) {
    return res.status(400).json({ error: { message: 'cacheKey required' } });
  }
  const result = deleteSession(cacheKey);
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

app.post('/admin/api/session/clear', adminAuth, (req, res) => {
  const result = clearAllSessions();
  res.json(result);
});

// --- Login Proxy management ---

app.get('/admin/api/proxy', adminAuth, (req, res) => {
  res.json({ success: true, ...getProxyConfig() });
});

app.post('/admin/api/proxy/manual', adminAuth, (req, res) => {
  const { proxyUrl } = req.body;
  setManualProxy(proxyUrl || '');
  res.json({ success: true, message: proxyUrl ? '手动代理已设置' : '手动代理已清除' });
});

app.post('/admin/api/proxy/xiequ', adminAuth, (req, res) => {
  const { apiUrl } = req.body;
  if (apiUrl && !apiUrl.startsWith('http://') && !apiUrl.startsWith('https://')) {
    return res.status(400).json({ error: { message: '携趣 API 地址需以 http:// 或 https:// 开头' } });
  }
  setXiequApiUrl(apiUrl || '');
  res.json({ success: true, message: apiUrl ? '携趣 API 已设置' : '携趣 API 已清除' });
});

app.post('/admin/api/proxy/xiequ/test', adminAuth, async (req, res) => {
  const { proxy, error } = await fetchXiequProxy();
  if (!proxy) {
    return res.status(502).json({ success: false, error: { message: error || '提取失败' } });
  }
  const check = await checkProxy(proxy);
  res.json({ success: true, proxy, check });
});

app.post('/admin/api/proxy/check', adminAuth, async (req, res) => {
  const { proxyUrl } = req.body;
  if (!proxyUrl) {
    return res.status(400).json({ error: { message: 'proxyUrl required' } });
  }
  const result = await checkProxy(proxyUrl);
  res.json({ success: true, ...result });
});

// --- API Key management ---

app.get('/admin/api/apikeys', adminAuth, (req, res) => {
  res.json({ success: true, keys: listApiKeys() });
});

app.post('/admin/api/apikeys/add', adminAuth, (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: { message: 'key required' } });
  }
  const result = addApiKey(key);
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

app.post('/admin/api/apikeys/remove', adminAuth, (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: { message: 'key required' } });
  }
  const result = removeApiKey(key);
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

// === Start server ===

// ─── Persistence: save state periodically and on shutdown ───
function persistCurrentState() {
  const state = buildPersistState({
    tokenPool: getTokenPoolRaw(),
    apiKeys: getApiKeysRaw(),
    proxyConfig: getProxyConfig(),
    sessions: getSessionPoolRaw(),
  });
  saveState(state);
}

// Auto-save every 60 seconds
setInterval(persistCurrentState, 60000);

// Save on graceful shutdown
function handleShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}, saving state...`);
  const state = buildPersistState({
    tokenPool: getTokenPoolRaw(),
    apiKeys: getApiKeysRaw(),
    proxyConfig: getProxyConfig(),
    sessions: getSessionPoolRaw(),
  });
  saveStateSync(state);
  process.exit(0);
}
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

app.listen(PORT, async () => {
  console.log(`DS Gateway running on http://localhost:${PORT}`);
  console.log(`OpenAI format:  POST /v1/chat/completions`);
  console.log(`DeepSeek format: POST /api/v0/chat/completion`);
  console.log(`Models: GET /v1/models`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
  console.log(`Admin auth: ${isAdminAuthRequired() ? 'ADMIN_PASSWORD required' : 'NO PASSWORD (open access)'}`);
  console.log(`API Key auth: ${isApiKeyRequired() ? 'Required' : 'Disabled (open access)'}`);
  console.log(`Data dir: ${process.env.DATA_DIR || '/app/data'}`);

  // Restore persisted state
  const persisted = loadState();
  if (persisted) {
    // Restore API keys
    if (persisted.apiKeys) {
      restoreApiKeys(persisted.apiKeys);
    }
    // Restore proxy config
    if (persisted.proxyConfig) {
      restoreProxyConfig(persisted.proxyConfig);
    }
  }

  await initTokenPool(persisted?.tokenPool);

  const aliveTokens = getAliveTokens();
  await prewarmSessions(aliveTokens);

  // Restore sessions from persisted state
  if (persisted?.sessions) {
    const { restoreSessions } = await import('./session.js');
    restoreSessions(persisted.sessions);
  }

  // Initial save after startup
  persistCurrentState();
});
