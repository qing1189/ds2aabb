/**
 * persist.js - Data persistence layer
 * 
 * Saves all runtime state to a JSON file so data survives container restarts.
 * Data directory: /app/data (mapped via Docker volume)
 * 
 * Persisted data:
 * - Token pool (tokens, accounts, vision capability, error counts)
 * - API Keys (dynamically added keys)
 * - Proxy config (manual proxy, xiequ API URL)
 * - Session cache (chat sessions)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const STATE_FILE = join(DATA_DIR, 'state.json');

// Debounce save to avoid excessive disk writes
let saveTimer = null;
const SAVE_DELAY = 2000; // 2 seconds debounce

/**
 * Ensure data directory exists
 */
function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[Persist] Created data directory: ${DATA_DIR}`);
  }
}

/**
 * Load persisted state from disk.
 * Returns null if no state file exists.
 */
export function loadState() {
  try {
    ensureDataDir();
    if (!existsSync(STATE_FILE)) {
      console.log('[Persist] No state file found, starting fresh');
      return null;
    }
    const raw = readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    console.log(`[Persist] Loaded state from ${STATE_FILE}`);
    return state;
  } catch (err) {
    console.warn(`[Persist] Failed to load state: ${err.message}`);
    return null;
  }
}

/**
 * Save state to disk (debounced).
 * Call this whenever state changes.
 */
export function saveState(state) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      ensureDataDir();
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[Persist] Failed to save state: ${err.message}`);
    }
  }, SAVE_DELAY);
}

/**
 * Save state immediately (no debounce).
 * Use on graceful shutdown.
 */
export function saveStateSync(state) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    ensureDataDir();
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    console.log('[Persist] State saved on shutdown');
  } catch (err) {
    console.warn(`[Persist] Failed to save state on shutdown: ${err.message}`);
  }
}

/**
 * Get the full runtime state to persist.
 * Called by modules that own state data.
 */
export function buildPersistState({ tokenPool, apiKeys, proxyConfig, sessions }) {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    tokenPool: tokenPool.map(t => ({
      token: t.token,
      email: t.email,
      password: t.password,
      visionCapable: t.visionCapable,
      errorCount: t.errorCount,
      dead: t.dead,
    })),
    apiKeys: [...apiKeys],
    proxyConfig: {
      manualProxy: proxyConfig.manualProxy || '',
      xiequApiUrl: proxyConfig.xiequApiUrl || '',
    },
    sessions: sessions.map(([key, val]) => ({
      key,
      id: val.id,
      model_type: val.model_type,
      createdAt: val.createdAt,
      token: val.token,
    })),
  };
}

/**
 * Restore token pool from persisted state.
 * Merges with env-configured tokens (env takes precedence).
 */
export function restoreTokenPool(persisted, envTokens, envAccounts) {
  if (!persisted || !Array.isArray(persisted)) return null;

  const restored = [];
  const envTokenSet = new Set(envTokens);
  const envAccountSet = new Set(envAccounts.map(a => a.email));

  // Restore persisted entries that are not duplicated in env
  for (const entry of persisted) {
    // Skip if this token is already in env
    if (entry.token && envTokenSet.has(entry.token)) continue;
    // Skip if this account is already in env
    if (entry.email && envAccountSet.has(entry.email)) continue;

    restored.push({
      token: entry.token || null,
      email: entry.email || null,
      password: entry.password || null,
      visionCapable: entry.visionCapable ?? null,
      lastUsed: 0,
      errorCount: entry.errorCount || 0,
      activeRequests: 0,
      dead: entry.dead || false,
    });
  }

  return restored;
}
