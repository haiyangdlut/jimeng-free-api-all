import {
  validateAuthToken as _validateAuthToken,
  addAuthToken,
  removeAuthToken,
  listAuthTokens,
  listSessions,
  addSessions,
  returnSession,
  getPoolStatus,
  getUsageStats,
  getTokenQuota,
  setTokenQuota,
  listQuotas,
} from '@/lib/token-pool.ts';

// Admin 路由 — 所有接口需要一个 master key 鉴权
const MASTER_KEY = process.env.ADMIN_KEY || 'admin-secret-key';

function adminAuth(request: any) {
  const auth = request.headers['x-admin-key'] || request.headers['X-Admin-Key'] || '';
  if (auth !== MASTER_KEY) {
    throw new Error('Admin 鉴权失败：请提供正确的 X-Admin-Key header');
  }
}

export default {
  prefix: '/v1/admin',

  get: {

    // 查看所有 auth token
    '/auth-tokens': async (request: any) => {
      adminAuth(request);
      return listAuthTokens();
    },

    // 查看池子状态
    '/pool': async (request: any) => {
      adminAuth(request);
      return getPoolStatus();
    },

    // 查看所有 token 配额概览
    '/quota': async (request: any) => {
      adminAuth(request);
      return listQuotas();
    },

    // 查看某个 token 的配额详情
    '/quota/:token': async (request: any) => {
      adminAuth(request);
      const token = request.params?.token;
      if (!token) throw new Error('缺少 token 参数');
      const quota = getTokenQuota(token);
      if (!quota) throw new Error('该 token 未配置配额');
      return quota;
    },

    // 查看所有 session 详情（可选 ?used=0 排除已用）
    '/sessions': async (request: any) => {
      adminAuth(request);
      const includeUsed = request.query?.used !== '0';
      return listSessions(includeUsed);
    },

    // 查看用量统计
    '/stats': async (request: any) => {
      adminAuth(request);
      return getUsageStats();
    },
  },

  post: {

    // 添加 auth token
    '/auth-tokens': async (request: any) => {
      adminAuth(request);
      const { token, label } = request.body;
      if (!token) throw new Error('缺少 token 字段');
      const ok = addAuthToken(token, label);
      return { success: ok, message: ok ? '已添加' : 'token 已存在或为空' };
    },

    // 设置配额上限
    // body: { token, action: 'videos-cn'|'videos-international'|'images', limit: number }
    '/quota': async (request: any) => {
      adminAuth(request);
      const { token, action, limit } = request.body;
      if (!token || !action || limit === undefined) throw new Error('缺少 token/action/limit 字段');
      const validActions = ['videos-cn', 'videos-international', 'images'];
      if (!validActions.includes(action)) throw new Error('action 必须是 videos-cn / videos-international / images');
      setTokenQuota(token, action, Number(limit));
      return { success: true, message: '已设置 ' + token + ' 的 ' + action + ' = ' + limit };
    },

    // 添加 sessionid
    '/sessions': async (request: any) => {
      adminAuth(request);
      const { tokens, tokens_csv } = request.body;
      const list = tokens || (typeof tokens_csv === 'string' ? tokens_csv.split(',').map((t: string) => t.trim()) : []);
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error('缺少 tokens 数组或 tokens_csv 字符串');
      }
      const result = addSessions(list);
      return { success: true, ...result, poolSize: getPoolStatus().available.total };
    },

    // 归还 sessionid（使用失败的回退）
    '/sessions/return': async (request: any) => {
      adminAuth(request);
      const { id } = request.body;
      if (!id) throw new Error('缺少 id 字段');
      returnSession(id);
      return { success: true };
    },
  },

  delete: {

    // 删除 auth token
    '/auth-tokens': async (request: any) => {
      adminAuth(request);
      const { token } = request.body || request.query;
      if (!token) throw new Error('缺少 token 字段');
      const ok = removeAuthToken(token);
      return { success: ok, message: ok ? '已删除' : 'token 不存在' };
    },
  },
};
