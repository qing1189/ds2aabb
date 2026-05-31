/**
 * API Key Manager
 * 
 * 管理多个 API Key（用于模型调用接口鉴权）。
 * 支持 Web 面板热加载增删。
 * 与管理面板密码 (ADMIN_PASSWORD) 完全独立。
 */

import { config } from 'dotenv';
config();

// 从环境变量加载初始 API Keys（逗号分隔）
function loadInitialKeys() {
  const str = process.env.API_KEYS?.trim() || process.env.API_KEY?.trim() || '';
  if (!str) return [];
  return str.split(',').map(k => k.trim()).filter(Boolean);
}

const apiKeys = new Set(loadInitialKeys());

// 管理面板密码（独立于 API Key）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim() || '';

// ==================== Admin Auth ====================

export function validateAdminPassword(password) {
  if (!ADMIN_PASSWORD) return true; // 未设置则不需要验证
  return password === ADMIN_PASSWORD;
}

export function isAdminAuthRequired() {
  return !!ADMIN_PASSWORD;
}

export function getAdminPassword() {
  return ADMIN_PASSWORD;
}

// ==================== API Key Management ====================

export function validateApiKey(key) {
  if (apiKeys.size === 0) return true; // 未设置任何 key 则不需要验证
  return apiKeys.has(key);
}

export function isApiKeyRequired() {
  return apiKeys.size > 0;
}

export function listApiKeys() {
  return [...apiKeys].map(k => ({
    key: k.length > 8 ? k.slice(0, 4) + '****' + k.slice(-4) : '****',
    fullKey: k,
  }));
}

export function addApiKey(key) {
  const trimmed = key.trim();
  if (!trimmed) return { success: false, message: 'Key 不能为空' };
  if (apiKeys.has(trimmed)) return { success: false, message: 'Key 已存在' };
  apiKeys.add(trimmed);
  console.log(`[ApiKeys] Added key: ${trimmed.slice(0, 4)}****`);
  return { success: true, message: 'API Key 已添加' };
}

export function removeApiKey(key) {
  const trimmed = key.trim();
  if (!apiKeys.has(trimmed)) return { success: false, message: 'Key 不存在' };
  apiKeys.delete(trimmed);
  console.log(`[ApiKeys] Removed key: ${trimmed.slice(0, 4)}****`);
  return { success: true, message: 'API Key 已删除' };
}

export function getApiKeyCount() {
  return apiKeys.size;
}


// ─── Persistence support ───

export function getApiKeysRaw() {
  return apiKeys;
}

export function restoreApiKeys(keys) {
  if (!Array.isArray(keys)) return;
  for (const key of keys) {
    if (key && typeof key === 'string' && !apiKeys.has(key)) {
      apiKeys.add(key);
    }
  }
  console.log(`[Persist] Restored ${keys.length} API keys (total: ${apiKeys.size})`);
}
