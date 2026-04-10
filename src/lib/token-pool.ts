import fs from 'fs-extra';
import path from 'path';
import logger from '@/lib/logger.ts';

const DATA_DIR = path.join(path.resolve(), 'tmp', 'pool-data');
// ============================================================
// Quota management (per-auth-token per-action)
// ============================================================

const QUOTA_FILE = path.join(DATA_DIR, 'quotas.json');

export type QuotaAction = 'videos-cn' | 'videos-international' | 'images';

export interface QuotaEntry {
  quotas: Record<QuotaAction, number>;
  used: Record<QuotaAction, number>;
}

let quotas: Record<string, QuotaEntry> = {};

function loadQuotas(): Record<string, QuotaEntry> {
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      return JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveQuotas() {
  fs.ensureDirSync(DATA_DIR);
  fs.writeFileSync(QUOTA_FILE, JSON.stringify(quotas, null, 2), 'utf-8');
}

const DEFAULT_QUOTA: Record<QuotaAction, number> = {
  'videos-cn': 50,
  'videos-international': 50,
  'images': 100,
};

export function getTokenQuota(token: string): QuotaEntry | null {
  return quotas[token] || null;
}

export function setTokenQuota(token: string, action: QuotaAction, limit: number): boolean {
  if (!quotas[token]) {
    quotas[token] = { quotas: { ...DEFAULT_QUOTA }, used: { 'videos-cn': 0, 'videos-international': 0, 'images': 0 } };
  }
  if (action) {
    quotas[token].quotas[action] = limit;
  }
  saveQuotas();
  return true;
}

export function checkAndIncrementQuota(token: string, action: QuotaAction): { allowed: boolean; reason?: string; quota?: QuotaEntry } {
  if (!quotas[token]) {
    quotas[token] = { quotas: { ...DEFAULT_QUOTA }, used: { 'videos-cn': 0, 'videos-international': 0, 'images': 0 } };
  }
  const entry = quotas[token];
  const limit = entry.quotas[action] ?? 0;
  const used = entry.used[action] ?? 0;
  if (limit > 0 && used >= limit) {
    return { allowed: false, reason: 'Quota exceeded: ' + action + ' used ' + used + '/' + limit, quota: entry };
  }
  entry.used[action] = used + 1;
  saveQuotas();
  return { allowed: true, quota: entry };
}

export function rollbackQuota(token: string, action: QuotaAction) {
  if (!quotas[token]) return;
  const used = quotas[token].used[action] ?? 0;
  if (used > 0) quotas[token].used[action] = used - 1;
  saveQuotas();
}

export function listQuotas(): Record<string, QuotaEntry> {
  return quotas;
}


const POOL_FILE = path.join(DATA_DIR, 'sessionids.json');
const STATS_FILE = path.join(DATA_DIR, 'usage-stats.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth-tokens.json');

// ============================================================
// Auth Token 管理
// ============================================================

interface AuthTokenEntry {
  token: string;
  label?: string;        // 客户备注，如 "客户A"
  createdAt: string;
}

let authTokens: AuthTokenEntry[] = [];

function loadAuthTokens(): AuthTokenEntry[] {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    }
  } catch {}
  // 从环境变量加载初始值
  const envTokens = process.env.AUTH_TOKENS || '';
  if (envTokens) {
    const list: AuthTokenEntry[] = envTokens.split(',').map(t => t.trim()).filter(Boolean).map(t => ({
      token: t,
      label: '',
      createdAt: new Date().toISOString(),
    }));
    if (list.length > 0) {
      saveAuthTokens(list);
      logger.info(`TokenPool: 从环境变量 AUTH_TOKENS 加载了 ${list.length} 个 auth token`);
    }
    return list;
  }
  return [];
}

function saveAuthTokens(tokens: AuthTokenEntry[]) {
  fs.ensureDirSync(DATA_DIR);
  fs.writeFileSync(AUTH_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
}

/** 验证 auth token，返回 label 或 null */
export function validateAuthToken(authorization: string): { valid: boolean; label: string; token: string } {
  const bearer = authorization.replace('Bearer ', '').trim();
  const entry = authTokens.find(t => t.token === bearer);
  if (entry) {
    return { valid: true, label: entry.label || entry.token.substring(0, 8), token: entry.token };
  }
  return { valid: false, label: '', token: '' };
}

/** 添加 auth token */
export function addAuthToken(token: string, label?: string): boolean {
  if (!token.trim()) return false;
  if (authTokens.some(t => t.token === token.trim())) return false;
  authTokens.push({ token: token.trim(), label: label || '', createdAt: new Date().toISOString() });
  quotas[token.trim()] = { quotas: { ...DEFAULT_QUOTA }, used: { 'videos-cn': 0, 'videos-international': 0, 'images': 0 } };
  saveQuotas();
  saveAuthTokens(authTokens);
  return true;
}

/** 删除 auth token */
export function removeAuthToken(token: string): boolean {
  const idx = authTokens.findIndex(t => t.token === token);
  if (idx === -1) return false;
  authTokens.splice(idx, 1);
  saveAuthTokens(authTokens);
  return true;
}

/** 列出所有 auth token（脱敏） */
export function listAuthTokens(): { token: string; label: string; createdAt: string }[] {
  return authTokens.map(t => ({
    token: t.token.substring(0, 8) + '****',
    label: t.label,
    createdAt: t.createdAt,
  }));
}

// ============================================================
// Session ID 池管理（消耗制，用完即弃）
// ============================================================

export interface SessionEntry {
  id: string;             // 唯一 ID，用于管理
  token: string;          // sessionid 原始值，如 "sg-xxxxx"
  type: 'cn' | 'international';  // 区分国内/国际
  addedAt: string;
  usedAt?: string;        // 使用时间
  usedBy?: string;        // 哪个 auth token 使用的
}

let sessionPool: SessionEntry[] = [];
let usedSessions: SessionEntry[] = [];

function loadSessions() {
  try {
    if (fs.existsSync(POOL_FILE)) {
      const data = JSON.parse(fs.readFileSync(POOL_FILE, 'utf-8'));
      sessionPool = data.pool || [];
      usedSessions = data.used || [];
      return;
    }
  } catch {}
  // 从环境变量加载初始值
  const envSessions = process.env.SESSION_TOKENS || '';
  if (envSessions) {
    const list: SessionEntry[] = envSessions.split(',').map(t => t.trim()).filter(Boolean).map((t, i) => ({
      id: `init-${i}-${Date.now()}`,
      token: t,
      type: isInternationalPrefix(t) ? 'international' : 'cn',
      addedAt: new Date().toISOString(),
    }));
    sessionPool = list;
    saveSessions();
    logger.info(`TokenPool: 从环境变量 SESSION_TOKENS 加载了 ${list.length} 个 sessionid`);
  }
}

function saveSessions() {
  fs.ensureDirSync(DATA_DIR);
  fs.writeFileSync(POOL_FILE, JSON.stringify({ pool: sessionPool, used: usedSessions }, null, 2), 'utf-8');
}

/** 消耗一个 sessionid（先进先出）。返回 null 表示池子空了 */

/**
 * 根据 sessionid 前缀判断是否为国际版
 * 国际版前缀: sg-, hk-, jp-, it-, al-, az-, bh-, ca-, cl-, de-, gb-, gy-, il-, iq-, jo-, kg-, om-, pk-, pt-, sa-, se-, tr-, tz-, uz-, ve-, xk-
 * 其余均为国内版
 */
function isInternationalPrefix(token: string): boolean {
  const lower = token.toLowerCase();
  return [
    'sg-', 'hk-', 'jp-', 'it-', 'al-', 'az-', 'bh-', 'ca-', 'cl-', 'de-', 'gb-', 'gy-', 'il-', 'iq-', 'jo-', 'kg-', 'om-', 'pk-', 'pt-', 'sa-', 'se-', 'tr-', 'tz-', 'uz-', 've-', 'xk-'
  ].some(prefix => lower.startsWith(prefix));
}

/** 列出所有 session（可用 + 已用），可选过滤 */
export function listSessions(includeUsed = true): { available: SessionEntry[]; used: SessionEntry[] } {
  return {
    available: sessionPool,
    used: includeUsed ? usedSessions : [],
  };
}

export function consumeSession(preferType?: 'cn' | 'international'): SessionEntry | null {
  if (sessionPool.length === 0) return null;

  // 优先取指定类型，没有就取任一
  let idx = preferType ? sessionPool.findIndex(s => s.type === preferType) : 0;
  if (idx === -1) idx = 0;

  const session = sessionPool.splice(idx, 1)[0];
  session.usedAt = new Date().toISOString();
  usedSessions.push(session);
  saveSessions();
  logger.info(`TokenPool: 消耗 sessionid [${session.type}] ${session.token.substring(0, 12)}..., 剩余 ${sessionPool.length}`);
  return session;
}

/** 标记 session 使用成功，记录使用者 */
export function markSessionUsed(sessionId: string, authLabel: string) {
  const entry = usedSessions.find(s => s.id === sessionId);
  if (entry) {
    entry.usedBy = authLabel;
    saveSessions();
  }
}

/** 标记 session 使用失败，归还池子 */
export function returnSession(sessionId: string) {
  const idx = usedSessions.findIndex(s => s.id === sessionId);
  if (idx === -1) return;
  const entry = usedSessions.splice(idx, 1)[0];
  delete entry.usedAt;
  delete entry.usedBy;
  sessionPool.unshift(entry); // 放回头部
  saveSessions();
  logger.info(`TokenPool: 归还 sessionid [${entry.type}] ${entry.token.substring(0, 12)}..., 当前 ${sessionPool.length}`);
}

/** 批量添加 sessionid */
export function addSessions(tokens: string[]): { added: number; skipped: number } {
  let added = 0, skipped = 0;
  for (const t of tokens) {
    const trimmed = t.trim();
    if (!trimmed) { skipped++; continue; }
    // 跳过已存在的（池中 + 已用中）
    if (sessionPool.some(s => s.token === trimmed) || usedSessions.some(s => s.token === trimmed)) {
      skipped++; continue;
    }
    sessionPool.push({
      id: `add-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      token: trimmed,
      type: isInternationalPrefix(trimmed) ? 'international' : 'cn',
      addedAt: new Date().toISOString(),
    });
    added++;
  }
  if (added > 0) saveSessions();
  return { added, skipped };
}

/** 获取池子状态 */
export function getPoolStatus(): {
  available: { total: number; cn: number; international: number };
  used: { total: number; cn: number; international: number };
  recentUsed: { token: string; type: string; usedAt: string; usedBy: string }[];
} {
  const countByType = (list: SessionEntry[]) => ({
    total: list.length,
    cn: list.filter(s => s.type === 'cn').length,
    international: list.filter(s => s.type === 'international').length,
  });
  return {
    available: countByType(sessionPool),
    used: countByType(usedSessions),
    recentUsed: usedSessions.slice(-20).reverse().map(s => ({
      token: s.token.substring(0, 12) + '...',
      type: s.type,
      usedAt: s.usedAt || '',
      usedBy: s.usedBy || '',
    })),
  };
}

// ============================================================
// 用量统计
// ============================================================

interface UsageRecord {
  authLabel: string;
  timestamp: string;
  type: 'image' | 'video';
  region: 'cn' | 'international';
  duration?: number;       // 视频时长（秒）
  model?: string;
}

interface AuthStats {
  imageRequests: { cn: number; international: number };
  videoRequests: { cn: number; international: number };
  videoSeconds: { cn: number; international: number };
  lastActiveAt: string;
}

export interface AllStats {
  tokens: Record<string, AuthStats>;
}

let stats: AllStats = { tokens: {} };

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
      return;
    }
  } catch {}
  stats = { tokens: {} };
}

function saveStats() {
  fs.ensureDirSync(DATA_DIR);
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
}

function ensureAuthStats(label: string): AuthStats {
  if (!stats.tokens[label]) {
    stats.tokens[label] = {
      imageRequests: { cn: 0, international: 0 },
      videoRequests: { cn: 0, international: 0 },
      videoSeconds: { cn: 0, international: 0 },
      lastActiveAt: '',
    };
  }
  return stats.tokens[label];
}

/** 记录一次成功请求 */
export function recordUsage(authLabel: string, record: UsageRecord) {
  const s = ensureAuthStats(authLabel);
  s.lastActiveAt = record.timestamp;
  if (record.type === 'image') {
    s.imageRequests[record.region]++;
  } else {
    s.videoRequests[record.region]++;
    s.videoSeconds[record.region] += (record.duration || 0);
  }
  saveStats();
}

/** 获取所有用量统计 */
export function getUsageStats(): AllStats {
  return stats;
}

/** 获取某个 auth token 的统计 */
export function getAuthTokenStats(label: string): AuthStats | null {
  return stats.tokens[label] || null;
}

// ============================================================
// 初始化
// ============================================================

export function initTokenPool() {
  fs.ensureDirSync(DATA_DIR);
  authTokens = loadAuthTokens();
  quotas = loadQuotas();
  // 给所有 auth token 初始化默认配额（存量 token 也需要）
  for (const t of authTokens) {
    if (!quotas[t.token]) {
      quotas[t.token] = { quotas: { ...DEFAULT_QUOTA }, used: { 'videos-cn': 0, 'videos-international': 0, 'images': 0 } };
    }
  }
  if (Object.keys(quotas).length > 0) saveQuotas();
  loadSessions();
  loadStats();
  logger.info(`TokenPool: 初始化完成. Auth tokens: ${authTokens.length}, 可用 sessionid: ${sessionPool.length}, 已用 sessionid: ${usedSessions.length}, 配额配置: ${Object.keys(quotas).length}`);
}
