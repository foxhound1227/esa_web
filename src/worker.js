/**
 * 阿里云 ESA 边缘函数 - 个人导航页 (单文件版)
 * 
 * 功能：
 * 1. 首页 (/)：服务端渲染 (SSR) 导航页，数据从 KV 读取。
 * 2. 后台 (/admin)：内嵌的管理页面，支持 Token 认证和数据管理。
 * 3. API (/api/links)：提供数据的读写接口。
 * 
 * 部署配置：
 * 1. 绑定 KV 命名空间到变量 "LINKS_KV"。
 * 2. 设置环境变量 "ADMIN_PASSWORD"。
 */

// ==========================================
// 配置常量区域
// ==========================================

/**
 * KV 操作配置
 */
const KV_CONFIG = {
  MAX_RETRIES: 3,           // KV 写入最大重试次数
  RETRY_BASE_DELAY: 200,    // 重试基础延迟（毫秒）
};

/**
 * 缓存策略配置
 */
const CACHE_CONFIG = {
  // 首页缓存时间（秒）
  // 建议值：300 (5分钟) - 平衡性能和数据新鲜度
  // 设置为 0 则禁用缓存
  HOME_PAGE_MAX_AGE: 300,

  // 边缘缓存时间（秒）
  // s-maxage 控制 CDN 边缘节点的缓存时间
  HOME_PAGE_S_MAX_AGE: 300,
};

/**
 * 安全配置
 */
const SECURITY_CONFIG = {
  // CORS 允许的来源
  // 生产环境建议设置为具体域名，如：['https://yourdomain.com']
  // 开发环境可以使用 ['*']
  ALLOWED_ORIGINS: ['*'],
};

export default {
  async fetch(request, env, ctx) {
    // 确保 env 存在
    env = env || {};

    const url = new URL(request.url);
    const path = url.pathname;

    // 允许跨域 (方便调试)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    const noCacheHeaders = {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ==========================================
    // 路由 1: API 接口
    // ==========================================
    if (path === '/api/links') {
      try {
        if (request.method === 'GET') {
          let data = await getLinksFromKV(env);
          return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, ...noCacheHeaders, 'Content-Type': 'application/json' }
          });
        } else if (request.method === 'POST') {
          // 鉴权
          const authHeader = request.headers.get('Authorization');
          const expectedPassword = await getAdminPassword(env);

          if (!authHeader || authHeader !== `Bearer ${expectedPassword}`) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          const body = await request.json();
          // 支持更新链接列表或分类配置
          // 如果 body 是数组，认为是更新链接列表
          // 如果 body 是对象且包含 links 或 categories，认为是全量更新
          let dataToSave = {};

          // 获取现有数据以保留未变更部分
          const currentData = await getLinksFromKV(env);

          if (Array.isArray(body)) {
            dataToSave = { ...currentData, links: body };
          } else if (typeof body === 'object') {
            dataToSave = { ...currentData, ...body };
          } else {
            throw new Error('Invalid data format');
          }

          // 写入 KV (增加重试机制)
          let lastError;
          for (let i = 0; i < KV_CONFIG.MAX_RETRIES; i++) {
            try {
              const kv = getKV(env);
              await kv.put('data', JSON.stringify(dataToSave));
              // 简单验证写入
              lastError = null;
              break;
            } catch (e) {
              lastError = e;
              await new Promise(r => setTimeout(r, KV_CONFIG.RETRY_BASE_DELAY * (i + 1))); // 指数退避
            }
          }

          if (lastError) {
            throw lastError;
          }

          return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, ...noCacheHeaders, 'Content-Type': 'application/json' }
          });
        }
      } catch (e) {
        // 返回详细错误信息
        const errorDetails = {
          error: e.message,
          cause: e.cause ? String(e.cause) : undefined, // EdgeKV 往往在 cause 里放错误详情
          stack: e.stack
        };
        return new Response(JSON.stringify(errorDetails), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // ==========================================
    // 路由: 修改密码 (/api/password)
    // ==========================================
    if (path === '/api/password' && request.method === 'POST') {
      try {
        const authHeader = request.headers.get('Authorization');
        const expectedPassword = await getAdminPassword(env);

        if (!authHeader || authHeader !== `Bearer ${expectedPassword}`) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const body = await request.json();
        const newPassword = body.password;
        if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 1) {
          return new Response(JSON.stringify({ error: 'Invalid password' }), { status: 400, headers: corsHeaders });
        }

        const kv = getKV(env);
        await kv.put('ADMIN_PASSWORD', newPassword);

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, ...noCacheHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        const errorDetails = {
          error: e.message,
          cause: e.cause ? String(e.cause) : undefined,
          stack: e.stack
        };
        return new Response(JSON.stringify(errorDetails), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/api/auth') {
      const authHeader = request.headers.get('Authorization');
      const expectedPassword = await getAdminPassword(env);
      if (!authHeader || authHeader !== `Bearer ${expectedPassword}`) {
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 401,
          headers: { ...corsHeaders, ...noCacheHeaders, 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ authenticated: true }), {
        headers: { ...corsHeaders, ...noCacheHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ==========================================
    // 路由 2: 管理后台 (/admin)
    // ==========================================
    if (path === '/admin') {
      return new Response(getAdminHtml(), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // ==========================================
    // 路由 3: 首页 (SSR)
    // ==========================================
    if (path === '/' || path === '/index.html') {
      const data = await getLinksFromKV(env);
      const html = renderHome(data);

      // 缓存策略：根据配置决定是否启用缓存
      const cacheHeaders = CACHE_CONFIG.HOME_PAGE_MAX_AGE > 0 ? {
        'Cache-Control': `public, max-age=${CACHE_CONFIG.HOME_PAGE_MAX_AGE}, s-maxage=${CACHE_CONFIG.HOME_PAGE_S_MAX_AGE}`,
        'Content-Type': 'text/html;charset=UTF-8'
      } : {
        ...noCacheHeaders,
        'Content-Type': 'text/html;charset=UTF-8'
      };

      return new Response(html, { headers: cacheHeaders });
    }

    return new Response('Not Found', { status: 404 });
  }
};

function getKV(env) {
  const ns = (env && env.EDGEKV_NAMESPACE) ? env.EDGEKV_NAMESPACE : 'links_store';
  if (typeof EdgeKV === 'undefined') throw new Error('EdgeKV unavailable');
  return new EdgeKV({ namespace: ns });
}

async function getAdminPassword(env) {
  try {
    const kv = getKV(env);
    const v = await kv.get('ADMIN_PASSWORD');
    if (v && typeof v === 'string' && v.length > 0) return v;
  } catch (_) { }
  if (env && env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD;
  return 'admin';
}
// 辅助函数：获取数据
async function getLinksFromKV(env) {
  let dataStr = null;
  try {
    const kv = getKV(env);
    dataStr = await kv.get('data');
  } catch (e) {
    console.error('KV Get Error:', e);
  }

  // 默认数据结构
  const defaultData = {
    links: [
      { name: "哔哩哔哩", url: "https://www.bilibili.com", icon: "📺", category: "media", description: "二次元弹幕视频网站" },
      { name: "腾讯视频", url: "https://v.qq.com", icon: "🎬", category: "media", description: "中国领先的在线视频媒体平台", url_intranet: "" },
      { name: "微信读书", url: "https://weread.qq.com", icon: "📖", category: "books", description: "深度阅读，即刻出发" },
      { name: "知乎", url: "https://www.zhihu.com", icon: "🧠", category: "books", description: "有问题，就会有答案" },
      { name: "GitHub", url: "https://github.com", icon: "💻", category: "dev", description: "全球最大的代码托管平台" },
      { name: "阿里云", url: "https://www.aliyun.com", icon: "☁️", category: "tools", description: "全球领先的云计算及人工智能科技公司" }
    ],
    categories: {
      'media': '🎬 影音媒体',
      'books': '📚 图书资源',
      'tools': '🛠️ 常用工具',
      'dev': '💻 开发资源'
    }
  };

  if (!dataStr) {
    return defaultData;
  }

  // 兼容旧格式（纯数组）
  try {
    const parsed = JSON.parse(dataStr);
    if (Array.isArray(parsed)) {
      return { ...defaultData, links: parsed };
    }
    return { ...defaultData, ...parsed }; // 合并默认值以防缺少字段
  } catch (e) {
    return defaultData;
  }
}


// 辅助函数：渲染主页 (企业工作台风格)

// 辅助函数：HTML 转义（防止 XSS）
function escapeHtml(unsafe) {
  if (typeof unsafe !== 'string') return '';
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 辅助函数：渲染主页 (企业工作台风格)
function renderHome(data) {
  const links = data.links || [];
  const categoryNames = data.categories || {};

  // 默认分类
  const defaultCategory = '其他';
  const categories = {};

  links.forEach(link => {
    const cat = link.category || defaultCategory;
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(link);
  });

  const definedKeys = Object.keys(categoryNames);
  const usedKeys = Object.keys(categories);
  const extraKeys = usedKeys.filter(k => !definedKeys.includes(k));
  const order = [...definedKeys, ...extraKeys];

  // 生成左侧侧边栏分类项
  let sidebarItemsHtml = `<div class="sidebar-item active" data-cat="all" onclick="filterCategory('all', this)">
      <span class="icon">💻</span> 全部应用
      <span class="count">${links.length}</span>
  </div>`;

  order.forEach((catKey) => {
    const items = categories[catKey] || [];
    if (items.length === 0) return;
    const rawName = categoryNames[catKey] || catKey;
    const name = escapeHtml(rawName);
    sidebarItemsHtml += `
      <div class="sidebar-item" data-cat="${escapeHtml(catKey)}" onclick="filterCategory('${escapeHtml(catKey)}', this)">
        <span class="icon">📂</span> ${name}
        <span class="count">${items.length}</span>
      </div>
    `;
  });

  // 生成右侧所有卡片
  let cardsHtml = '';
  // 按照分类顺序排序链接，或者直接全部输出，依靠 JS 过滤
  // 为了方便，我们这里直接输出所有卡片，带上 data-category 属性

  // 按照分类分组展示顺序来排一下，体验更好
  order.forEach(catKey => {
    const items = categories[catKey] || [];
    items.forEach(site => {
      cardsHtml += renderCard(site, catKey);
    });
  });
  // 还有那些不在配置分类里的
  // (Data structure logic ensures all are in categories map)

  function renderCard(site, catKey) {
    // 随机背景色生成 (基于名字)
    const colors = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];
    const colorIndex = (site.name.charCodeAt(0) || 0) % colors.length;
    const bgColor = colors[colorIndex];

    const safeName = escapeHtml(site.name);
    const safeDesc = escapeHtml(site.description || '暂无描述');
    const safeUrl = escapeHtml(site.url); // Though URL often needs specific URL encoding, strict HTML escape is a good start for attributes
    // However, for href, simple HTML escaping isn't enough to prevent javascript: pseudo-protocol, 
    // but for this personal dashboard, we mainly care about breaking out of quotes.
    // For attributes like data-name, we definitely need escaping.

    // safeUrl for href should be careful, but assuming reasonable input for now. 
    // Primarily fixing the HTML injection in title/desc.

    return `
        <a href="${site.url}" target="_blank" class="app-card" 
           data-category="${escapeHtml(catKey)}" 
           data-name="${safeName.toLowerCase()}" 
           data-desc="${(site.description || '').toLowerCase()}"
           data-url-ext="${site.url}"
           data-url-int="${site.url_intranet || ''}">
          <div class="app-icon-box" style="background-color: ${bgColor}">
             ${site.icon || safeName.slice(0, 1)}
          </div>
          <div class="app-info">
             <div class="app-title">${safeName}</div>
             <div class="app-desc">${safeDesc}</div>
          </div>
        </a>
      `;
  }

  const today = new Date();
  const dateStr = today.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  // 生成个性化问候语
  const hour = today.getHours();
  let greeting = '早上好';
  let greetingEmoji = '🌅';
  if (hour >= 12 && hour < 18) {
    greeting = '下午好';
    greetingEmoji = '☀️';
  } else if (hour >= 18) {
    greeting = '晚上好';
    greetingEmoji = '🌙';
  }

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>我的工作台 - My Workbench</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      /* 极简现代配色 (Linear/Vercel Style) */
      --primary-gradient-start: #4f46e5;
      --primary-gradient-end: #6366f1;
      --accent-color: #6366f1;
      
      --sidebar-bg: rgba(255, 255, 255, 0.6);
      /* 外网背景：清新的淡蓝/靛青渐变，与内网绿色对应 */
      --main-bg: linear-gradient(135deg, #e0e7ff 0%, #eff6ff 100%);
      
      /* 面板颜色：半透明白，透出背景蓝 */
      --panel-bg: rgba(255, 255, 255, 0.6);
      --panel-border: rgba(255, 255, 255, 0.8);
      
      --text-primary: #111827;
      --text-secondary: #6b7280;
      --primary-color: #4f46e5;
      --border-color: #e5e7eb;
      --hover-bg: rgba(0, 0, 0, 0.04);
      
      /* 卡片图标渐变 (保持鲜艳) */
      --gradient-media: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      --gradient-books: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
      --gradient-tools: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);
      --gradient-dev: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
    }
    
    * { 
      margin: 0; 
      padding: 0; 
      box-sizing: border-box; 
    }
    
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--main-bg);
      color: var(--text-primary);
      height: 100vh;
      display: flex;
      overflow: hidden;
      transition: background 0.5s; /* 延长过渡时间，更加平滑 */
      position: relative;
    }
    
    /* 背景装饰元素 */
    body::before {
      content: '';
      position: absolute;
      top: -50%;
      right: -50%;
      width: 100%;
      height: 100%;
      background: radial-gradient(circle, rgba(99, 102, 241, 0.05) 0%, transparent 60%);
      pointer-events: none;
      animation: float 30s ease-in-out infinite;
    }
    
    @keyframes float {
      0%, 100% { transform: translate(0, 0) rotate(0deg); }
      50% { transform: translate(-40px, -20px) rotate(10deg); }
    }
    
    body.intranet-mode {
       --sidebar-bg: rgba(240, 253, 244, 0.5);
       --primary-color: #059669;
       /* 内网背景：清新的绿色渐变 */
       --main-bg: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%);
       
       /* 内网面板：半透明的淡绿，与背景融合 */
       --panel-bg: rgba(255, 255, 255, 0.25);
       --panel-border: rgba(255, 255, 255, 0.4);
    }
    
    .logo {
      font-size: 20px;
      color: #0f172a;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 40px;
    }
    .sb-section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #94a3b8;
      margin-bottom: 12px;
      margin-top: 24px;
    }
    .sb-section-title:first-of-type { margin-top: 0; }
    
    
    /* 自定义滚动条 */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(0, 0, 0, 0.1);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(0, 0, 0, 0.2);
    }
    
    /* 侧边栏 */
    .sidebar {
      width: 250px;
      /* background: transparent; */ /* 让它融入背景 */
      padding: 32px 20px;
      overflow-y: auto;
      flex-shrink: 0;
      z-index: 10;
      display: flex;
      flex-direction: column;
    }
    
    .logo {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 40px;
      padding-left: 12px;
      opacity: 0.9;
    }
    
    .sb-section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #9ca3af; /* Cool Gray 400 */
      margin-bottom: 16px;
      margin-top: 24px;
      padding-left: 12px;
    }
    .sb-section-title:first-of-type { margin-top: 0; }
    
    .sidebar-item {
      display: flex;
      align-items: center;
      padding: 10px 12px;
      border-radius: 12px;
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      margin-bottom: 4px;
    }
    
    /* 移除左侧指示条，改用背景色 */
    .sidebar-item:hover {
      background: rgba(0, 0, 0, 0.04);
      color: var(--text-primary);
    }
    
    /* 激活态设计：极简的灰色背景 + 深色文字 */
    .sidebar-item.active {
      background: rgba(0, 0, 0, 0.06);
      color: var(--text-primary);
      font-weight: 600;
    }
    
    .sidebar-item .icon {
      margin-right: 12px;
      font-size: 18px;
      width: 24px;
      text-align: center;
      opacity: 0.8;
    }
    
    .sidebar-item.active .icon {
      opacity: 1;
      transform: scale(1.1);
    }
    
    .sidebar-item .count {
      margin-left: auto;
      font-size: 11px;
      color: #9ca3af;
      font-weight: 500;
      opacity: 0;
      transition: opacity 0.2s;
    }
    
    .sidebar-item:hover .count,
    .sidebar-item.active .count {
      opacity: 1;
    }
    
    /* 开关样式 */
    .net-switch {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        padding: 4px 12px;
        background: #f1f5f9;
        border-radius: 20px;
        transition: background 0.3s;
    }
    .net-switch:hover { background: #e2e8f0; }
    .switch-label { font-size: 12px; font-weight: 600; user-select: none; }
    .toggle-track {
        width: 36px;
        height: 20px;
        background: #cbd5e1;
        border-radius: 10px;
        position: relative;
        transition: background 0.3s;
    }
    .toggle-thumb {
        width: 16px;
        height: 16px;
        background: white;
        border-radius: 50%;
        position: absolute;
        top: 2px;
        left: 2px;
        transition: transform 0.3s;
        box-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }
    .net-switch.active .toggle-track { background: #16a34a; }
    .net-switch.active .toggle-thumb { transform: translateX(16px); }

    .user-avatar {
      width: 32px;
      height: 32px;
      background: #000;
      color: #fff;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      cursor: pointer;
    }

    
    /* 主区域 */
    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      position: relative;
    }

    /* 顶部悬浮功能区 */
    .top-nav {
      position: absolute;
      top: 24px;
      right: 32px;
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 20px;
    }

    /* 应用容器 - 面板式设计 */
    .apps-container {
      flex: 1;
      padding: 0 40px;
      overflow-y: auto;
      scroll-behavior: smooth;
      
      /* 使用 CSS 变量以支持暗色/内网模式 */
      background: var(--panel-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      margin: 20px 30px 30px 0; /* 右下留白 */
      border-radius: 32px;
      /* 增强阴影，突显层级 */
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.04);
      border: 1px solid var(--panel-border);
      transition: background 0.5s, border-color 0.5s, box-shadow 0.5s; /* 添加过渡动画 */
    }

    /* 移动端适配 */
    @media (max-width: 768px) {
      .apps-container {
        margin: 0;
        border-radius: 0;
        background: transparent;
        backdrop-filter: none;
        padding: 20px;
      }
      .top-nav {
         right: 20px;
         top: 20px;
      }
    }
    
    /* Hero 区域 */
    .hero-section {
      padding: 60px 0 40px; /* 稍微减小 padding 以适应面板 */
      max-width: 800px;
      margin: 0 auto;
      text-align: center;
      animation: fadeInDown 0.8s ease-out;
    }
    
    .hero-content {
      margin-bottom: 40px;
    }

    .page-title {
      font-size: 32px;
      font-weight: 800;
      color: var(--text-primary);
      margin-bottom: 12px;
      letter-spacing: -0.02em;
      background: linear-gradient(135deg, var(--text-primary) 0%, #475569 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    
    .page-subtitle {
      color: var(--text-secondary);
      font-size: 16px;
      font-weight: 500;
    }

    /* 搜索框 */
    .search-wrapper {
      position: relative;
      max-width: 500px;
      margin: 0 auto;
    }
    
    .search-input {
      width: 100%;
      padding: 18px 24px 18px 56px;
      border: 1px solid rgba(0,0,0,0.05);
      border-radius: 24px;
      font-size: 16px;
      outline: none;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      background: white;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
    }
    
    .search-input:focus {
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.05), 0 10px 10px -5px rgba(0, 0, 0, 0.02);
      transform: translateY(-2px);
    }
    
    .search-icon {
      position: absolute;
      left: 24px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--primary-color);
      font-size: 20px;
      opacity: 0.8;
    }

    /* 卡片网格 */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 24px;
      padding-bottom: 60px;
      max-width: 1200px;
      margin: 0 auto;
      animation: fadeInUp 0.8s ease-out 0.2s both;
    }

    .app-card {
      background: white;
      border: 1px solid rgba(0,0,0,0.02);
      border-radius: 20px;
      padding: 24px;
      display: flex;
      align-items: center;
      gap: 20px;
      text-decoration: none;
      color: inherit;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -1px rgba(0, 0, 0, 0.02);
    }
    
    .app-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.05), 0 10px 10px -5px rgba(0, 0, 0, 0.01);
    }
    
    .app-card:active {
      transform: scale(0.98);
    }

    .app-icon-box {
      width: 52px;
      height: 52px;
      border-radius: 14px; /* iOS Squircle style */
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 26px;
      color: white;
      flex-shrink: 0;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      transition: transform 0.3s;
    }
    
    .app-card:hover .app-icon-box {
      transform: scale(1.1) rotate(6deg);
    }
      flex-shrink: 0;
    }

    .app-info {
      flex: 1;
      min-width: 0; /* 防止文本溢出 */
    }
    .app-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .app-desc {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    @media (max-width: 768px) {
      .sidebar { display: none; } /* 移动端简单处理：隐藏侧边栏 */
      .header { padding: 0 16px; }
      .apps-container { padding: 16px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <!-- 左侧导航 -->
  <div class="sidebar">
    <div class="logo">
      <span>✨ &nbsp; ESA WORKBENCH</span>
    </div>

    <div class="sb-section-title">APPLICATIONS</div>
    <div id="sidebar-menu">
      ${sidebarItemsHtml}
    </div>
  </div>

  <!-- 主内容 -->
  <div class="main-content">
    
  <!-- 主内容 -->
  <div class="main-content">
    
    <div class="apps-container">
      <!-- 顶部功能区 (悬浮) -->
      <div class="top-nav">
        <div class="net-switch" onclick="toggleNetwork()" id="netSwitch">
            <span class="switch-label" id="netLabel">外网</span>
            <div class="toggle-track"><div class="toggle-thumb"></div></div>
        </div>
        <div class="user-avatar">AD</div>
      </div>

      <!-- Hero 区域 -->
      <div class="hero-section">
        <div class="hero-content">
           <h1 class="page-title">${greetingEmoji} ${greeting}，欢迎回来！</h1>
           <div class="page-subtitle">${dateStr}</div>
        </div>
        
        <!-- 搜索框 (居中) -->
        <div class="search-wrapper">
          <span class="search-icon">🔍</span>
          <input type="text" class="search-input" id="appSearch" placeholder="搜索我的应用..." oninput="filterApps()">
        </div>
      </div>

    <div class="apps-container">
      


      <!-- 网格 -->
      <div class="grid" id="appsGrid">
        ${cardsHtml}
      </div>


      <footer style="margin-top: 60px; text-align: center; color: #94a3b8; font-size: 12px;">
         Powered by Aliyun ESA Edge Routine | <a href="/admin" style="color: inherit; text-decoration: underline;">管理后台</a>
      </footer>
    </div>
  </div>

  <script>
    function filterCategory(cat, el) {
      // 高亮处理
      document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
      el.classList.add('active');

      const cards = document.querySelectorAll('.app-card');
      cards.forEach(card => {
        if (cat === 'all' || card.getAttribute('data-category') === cat) {
          card.style.display = 'flex';
        } else {
          card.style.display = 'none';
        }
      });
      
      // 更新标题 (由于移除了 page-title 的动态更新需求，这里可以简化，或者更新 hero title)
      // document.querySelector('.page-title').textContent = ... 
      // 在新设计中，我们保持 Hero Title 为问候语，不随分类变化，这更像 Dashboard。
      // 如果需要反馈分类变化，可以在搜索框或 Grid 上方加一个小标签，但保持 Hero 不动更加大气。
    }

    function filterApps() {
      const query = document.getElementById('appSearch').value.toLowerCase();
      const cards = document.querySelectorAll('.app-card');
      
      // 如果正在搜索，优先显示搜索结果（忽略分类过滤，或者在当前分类下搜索）
      // 这里为了简单，搜索是全局搜索
      
      cards.forEach(card => {
        const name = card.getAttribute('data-name');
        const desc = card.getAttribute('data-desc');
        const match = name.includes(query) || desc.includes(query);
        
        if (match) {
           card.style.display = 'flex';
        } else {
           card.style.display = 'none';
        }
      });
      
      // 如果搜索框清空，恢复当前选中的分类视图？
      // 简单起见，搜索时重置分类选中状态到 "全部" 可能是更好的交互，或者仅仅过滤可见元素
      if (!query) {
         // 触发当前激活的分类点击以恢复状态
         document.querySelector('.sidebar-item.active').click();
      }
    }
    
    // 内外网切换逻辑
    let isIntranet = false;
    function toggleNetwork() {
        isIntranet = !isIntranet;
        const switchEl = document.getElementById('netSwitch');
        const labelEl = document.getElementById('netLabel');
        const body = document.body;
        
        if (isIntranet) {
            switchEl.classList.add('active');
            labelEl.textContent = '内网';
            body.classList.add('intranet-mode');
        } else {
            switchEl.classList.remove('active');
            labelEl.textContent = '外网';
            body.classList.remove('intranet-mode');
        }
        
        updateCardLinks();
    }
    
    function updateCardLinks() {
        const cards = document.querySelectorAll('.app-card');
        cards.forEach(card => {
            const extUrl = card.getAttribute('data-url-ext');
            const intUrl = card.getAttribute('data-url-int');
            
            if (isIntranet && intUrl) {
                card.href = intUrl;
                card.title = '内网地址: ' + intUrl;
            } else {
                card.href = extUrl;
                card.title = '外网地址: ' + extUrl;
            }
        });
    }
  </script>
</body>
</html>
  `;
}

// ----------------------------------------------------------------
// 后台管理页面 HTML (内嵌)
// ----------------------------------------------------------------
function getAdminHtml() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>导航页管理后台</title>
    <style>
        :root { --primary: #007AFF; --bg: #f5f5f7; --card: #fff; --text: #1d1d1f; }
        body { font-family: -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 20px; max-width: 800px; margin: 0 auto; }
        .auth-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
        .auth-box { background: white; padding: 2rem; border-radius: 12px; width: 90%; max-width: 400px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
        .hidden { display: none !important; }
        .card { background: var(--card); padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); margin-bottom: 20px; }
        h1 { margin: 0 0 20px; font-size: 24px; }
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
        .full-width { grid-column: span 2; }
        input { width: 100%; padding: 10px; border: 1px solid #d2d2d7; border-radius: 8px; font-size: 14px; box-sizing: border-box; }
        button { background: var(--primary); color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: 500; }
        button:hover { opacity: 0.9; }
        button.danger { background: #ff3b30; }
        .list-item { background: #fafafa; padding: 12px; border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid #eee; }
        .tag { display: inline-block; background: #e5e5ea; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-left: 8px; }
    </style>
</head>
<body>
    <div id="authModal" class="auth-overlay">
        <div class="auth-box">
            <h2 style="margin-bottom: 1rem;">管理员登录</h2>
            <input type="password" id="authPassword" placeholder="输入密码" style="margin-bottom: 1rem;">
            <button onclick="login()" style="width: 100%;">登录</button>
        </div>
    </div>

    <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <h1>🔗 链接管理</h1>
            <a href="/" target="_blank" style="color:var(--primary); text-decoration:none;">查看主页 &rarr;</a>
        </div>
        
        <div class="form-grid">
            <input type="text" id="linkName" placeholder="名称 (如: B站)">
            <input type="text" id="linkUrl" placeholder="URL (如: https://...)">
            <select id="iconSelect">
                <option value="">选择图标</option>
            </select>
            <input type="text" id="linkIcon" placeholder="自定义图标 (Emoji 或 URL)">
            <select id="categorySelect">
                <option value="">选择分类</option>
            </select>
            <input type="text" id="linkCategory" placeholder="自定义分类 ID (如: media)">

            <input type="text" id="linkDesc" class="full-width" placeholder="描述 (简短介绍，支持卡片展示)">
            <input type="text" id="linkUrlInt" class="full-width" placeholder="内网 URL (选填，切换到内网模式时使用)">
        </div>
        <button id="submitBtn" onclick="submitLink()">添加链接</button>
        <button id="cancelBtn" onclick="cancelEdit()" style="background: #8e8e93; display: none; margin-left: 10px;">取消修改</button>
    </div>

    <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <h1>🏷️ 分类管理</h1>
            <button onclick="toggleCatManager()" style="background:transparent; color:#007AFF; padding:0;">展开/收起</button>
        </div>
        <div id="catManager" class="hidden" style="margin-top: 10px;">
            <div id="categoryList"></div>
            <div class="form-grid" style="margin-top: 10px;">
                <input type="text" id="newCatKey" placeholder="分类 ID (如: mycat)">
                <input type="text" id="newCatName" placeholder="显示名称 (如: ✨ 我的分类)">
            </div>
            <button onclick="addCategory()">添加/更新分类</button>
        </div>
    </div>
    
    <div class="card">
         <div style="display:flex; justify-content:space-between; align-items:center;">
             <h1>🔐 安全设置</h1>
             <button onclick="togglePwdManager()" style="background:transparent; color:#007AFF; padding:0;">展开/收起</button>
         </div>
         <div id="pwdManager" class="hidden" style="margin-top: 10px;">
            <div class="form-grid">
               <input type="password" id="newAdminPassword" placeholder="新密码">
               <button onclick="changePassword()">修改管理员密码</button>
            </div>
         </div>
    </div>

    <div class="card">
        <div id="linkList"></div>
        <div style="margin-top: 20px; text-align: right;">
            <button onclick="saveAll()" id="saveBtn">💾 保存所有更改 (链接+分类)</button>
        </div>
    </div>

    <script>
        // 全局错误捕获
        window.onerror = function(msg, url, line, col, error) {
           alert("JS Error: " + msg + "\\\\nLine: " + line);
           return false;
        };
        
 

        let links = [];
        let categories = {}; // 新增分类数据
        let token = localStorage.getItem('esa_nav_token') || '';
        let editingIndex = null;
        const presetIcons = ['📺','🎬','📖','🧠','🛠️','💻','📰','🎧','🛒','✈️','📈','🎮','📷','🔍','💬','🌐','📚','🧭','🧩'];
        const presetCategories = ['media','books','tools','dev','news','music','shopping','travel','finance','games','photo','search','social','learning','work'];
        function populatePresets() {
            try {
                const iconSel = document.getElementById('iconSelect');
                presetIcons.forEach(i => { const o = document.createElement('option'); o.value = i; o.textContent = i; iconSel.appendChild(o); });
                const catSel = document.getElementById('categorySelect');
                presetCategories.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o); });
            } catch(e) { alert('Preset Error: ' + e.message); }
        }
        populatePresets();

        if (token) {
            validateAndInit();
        }

        async function login() { 
            const input = document.getElementById('authPassword').value.trim();
            if (!input) {
                return alert('请输入密码');
            }
            const btn = document.querySelector('button[onclick="login()"]');
            btn.disabled = true;
            btn.textContent = '登录中...';
            
            try {
                const res = await fetch('/api/auth', { headers: { 'Authorization': 'Bearer ' + input } });
                
                if (res.ok) {
                    token = input;
                    localStorage.setItem('esa_nav_token', token);
                    document.getElementById('authModal').classList.add('hidden');
                    alert('登录成功');
                    fetchLinks();
                } else {
                    alert('密码错误 (服务器返回状态: ' + res.status + ')');
                    localStorage.removeItem('esa_nav_token');
                }
            } catch (e) {
                alert('网络错误: ' + e.message);
            } finally {
                btn.disabled = false;
                btn.textContent = '登录';
            }
        }

        async function validateAndInit() {
            try {
                const res = await fetch('/api/auth', { headers: { 'Authorization': 'Bearer ' + token } });
                if (res.ok) {
                    document.getElementById('authModal').classList.add('hidden');
                    fetchLinks();
                } else {
                    localStorage.removeItem('esa_nav_token');
                }
            } catch (_) {}
        }

        async function fetchLinks() {
            try {
                const res = await fetch('/api/links');
                if (res.ok) {
                    const data = await res.json();
                    // 兼容旧格式（纯数组）或新格式（对象）
                    if (Array.isArray(data)) {
                        links = data;
                        categories = {
                            'media': '🎬 影音媒体',
                            'books': '📚 图书资源',
                            'tools': '🛠️ 常用工具',
                            'dev': '💻 开发资源'
                        };
                    } else {
                        links = data.links || [];
                        categories = data.categories || {};
                    }
                    renderList();
                    renderCategoryList();
                }
            } catch (e) { console.error(e); }
        }

        function toggleCatManager() {
            document.getElementById('catManager').classList.toggle('hidden');
        }
        
        function togglePwdManager() {
            document.getElementById('pwdManager').classList.toggle('hidden');
        }

        async function changePassword() {
            const pwd = document.getElementById('newAdminPassword').value.trim();
            if (!pwd) return alert('密码不能为空');
            
            if (!confirm('确定要修改密码吗？修改后需要重新登录。')) return;

            try {
               const res = await fetch('/api/password', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                  body: JSON.stringify({ password: pwd })
               });
               
               if (res.ok) {
                  alert('密码修改成功，请重新登录');
                  localStorage.removeItem('esa_nav_token');
                  location.reload();
               } else {
                  let msg = '修改失败';
                  try {
                     const d = await res.json();
                     if (d.error) msg += ': ' + d.error;
                     if (d.cause) msg += '\\n原因: ' + d.cause;
                  } catch(_) {}
                  alert(msg);
               }
            } catch(e) {
               alert('请求失败');
            }
        }

        function escapeHtml(unsafe) {
            if (typeof unsafe !== 'string') return '';
            return unsafe
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        function renderCategoryList() {
            const el = document.getElementById('categoryList');
            el.innerHTML = '';
            Object.keys(categories).forEach(key => {
                const item = document.createElement('div');
                item.className = 'list-item';
                item.style.padding = '8px';
                
                const contentDiv = document.createElement('div');
                const tag = document.createElement('span');
                tag.className = 'tag';
                tag.textContent = key;
                const strong = document.createElement('strong');
                strong.textContent = categories[key];
                contentDiv.appendChild(tag);
                contentDiv.appendChild(document.createTextNode(' '));
                contentDiv.appendChild(strong);
                
                const btn = document.createElement('button');
                btn.className = 'danger';
                btn.textContent = '删除';
                btn.style.cssText = 'padding: 4px 8px; font-size: 12px;';
                btn.onclick = function() { removeCategory(key); };
                
                item.appendChild(contentDiv);
                item.appendChild(btn);
                el.appendChild(item);
            });
        }

        function addCategory() {
            const key = document.getElementById('newCatKey').value.trim();
            const name = document.getElementById('newCatName').value.trim();
            if (!key || !name) return alert('ID 和名称必填');
            categories[key] = name;
            renderCategoryList();
            document.getElementById('newCatKey').value = '';
            document.getElementById('newCatName').value = '';
        }

        function removeCategory(key) {
            if (confirm('确定删除分类配置吗？(不会删除该分类下的链接)')) {
                delete categories[key];
                renderCategoryList();
            }
        }

        function renderList() {
            const listEl = document.getElementById('linkList');
            listEl.innerHTML = '';
            links.forEach((link, index) => {
                const item = document.createElement('div');
                item.className = 'list-item';
                const catName = categories[link.category] || link.category || '其他';
                
                // 左侧内容区
                const leftDiv = document.createElement('div');
                
                const iconSpan = document.createElement('span');
                iconSpan.style.cssText = 'margin-right: 8px; font-size: 1.2em;';
                iconSpan.textContent = link.icon || '🔗';
                
                const nameStrong = document.createElement('strong');
                nameStrong.textContent = link.name;
                
                const catTag = document.createElement('span');
                catTag.className = 'tag';
                catTag.textContent = catName;
                
                const descDiv = document.createElement('div');
                descDiv.style.cssText = 'font-size:12px; color:#666; margin-top:2px;';
                descDiv.textContent = link.description || '(无描述)';
                
                const urlDiv = document.createElement('div');
                urlDiv.style.cssText = 'font-size:12px; color:#ccc;';
                urlDiv.textContent = link.url;
                
                leftDiv.appendChild(iconSpan);
                leftDiv.appendChild(nameStrong);
                leftDiv.appendChild(document.createTextNode(' '));
                leftDiv.appendChild(catTag);
                leftDiv.appendChild(descDiv);
                leftDiv.appendChild(urlDiv);
                
                if (link.url_intranet) {
                    const intDiv = document.createElement('div');
                    intDiv.style.cssText = 'font-size:11px; color:#16a34a;';
                    intDiv.textContent = '🔒 内网: ' + link.url_intranet;
                    leftDiv.appendChild(intDiv);
                }
                
                // 右侧按钮区
                const rightDiv = document.createElement('div');
                
                const editBtn = document.createElement('button');
                editBtn.textContent = '编辑';
                editBtn.style.cssText = 'padding: 6px 12px; font-size: 12px; margin-right: 5px; background: #007AFF;';
                editBtn.onclick = function() { editLink(index); };
                
                const delBtn = document.createElement('button');
                delBtn.className = 'danger';
                delBtn.textContent = '删除';
                delBtn.style.cssText = 'padding: 6px 12px; font-size: 12px;';
                delBtn.onclick = function() { removeLink(index); };
                
                rightDiv.appendChild(editBtn);
                rightDiv.appendChild(delBtn);
                
                item.appendChild(leftDiv);
                item.appendChild(rightDiv);
                listEl.appendChild(item);
            });
        }

        function submitLink() {
            const name = document.getElementById('linkName').value;
            const url = document.getElementById('linkUrl').value;
            const iconSel = document.getElementById('iconSelect').value.trim();
            const iconCustom = document.getElementById('linkIcon').value.trim();
            const categorySel = document.getElementById('categorySelect').value.trim();
            const categoryCustom = document.getElementById('linkCategory').value.trim();
            const description = document.getElementById('linkDesc').value.trim();
            const urlInt = document.getElementById('linkUrlInt').value.trim();
            const icon = iconCustom || iconSel;
            const category = categoryCustom || categorySel;

            if (!name || !url) return alert('名称和 URL 必填');

            if (editingIndex !== null) {
                // 修改
                links[editingIndex] = { name, url, icon, category, description, url_intranet: urlInt };
                cancelEdit(); // 退出编辑模式
            } else {
                // 新增
                links.push({ name, url, icon, category, description, url_intranet: urlInt });
                // 清空表单
                ['linkName', 'linkUrl', 'linkIcon', 'linkCategory', 'linkDesc', 'linkUrlInt'].forEach(id => document.getElementById(id).value = '');
                document.getElementById('iconSelect').value = '';
                document.getElementById('categorySelect').value = '';
            }
            
            renderList();
        }

        function editLink(index) {
            const link = links[index];
            document.getElementById('linkName').value = link.name;
            document.getElementById('linkUrl').value = link.url;
            document.getElementById('linkDesc').value = link.description || '';
            document.getElementById('linkUrlInt').value = link.url_intranet || '';
            const iconSel = document.getElementById('iconSelect');
            const catSel = document.getElementById('categorySelect');
            if (presetIcons.includes(link.icon)) {
                iconSel.value = link.icon;
                document.getElementById('linkIcon').value = '';
            } else {
                iconSel.value = '';
                document.getElementById('linkIcon').value = link.icon || '';
            }
            if (presetCategories.includes(link.category)) {
                catSel.value = link.category;
                document.getElementById('linkCategory').value = '';
            } else {
                catSel.value = '';
                document.getElementById('linkCategory').value = link.category || '';
            }
            
            editingIndex = index;
            document.getElementById('submitBtn').textContent = '保存修改';
            document.getElementById('cancelBtn').style.display = 'inline-block';
            
            // 滚动到顶部
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function cancelEdit() {
            editingIndex = null;
            ['linkName', 'linkUrl', 'linkIcon', 'linkCategory', 'linkDesc', 'linkUrlInt'].forEach(id => document.getElementById(id).value = '');
            document.getElementById('iconSelect').value = '';
            document.getElementById('categorySelect').value = '';
            document.getElementById('submitBtn').textContent = '添加链接';
            document.getElementById('cancelBtn').style.display = 'none';
        }

        function removeLink(index) {
            if (confirm('确定删除吗？')) {
                links.splice(index, 1);
                // 如果删除的是当前正在编辑的项，取消编辑状态
                if (editingIndex === index) {
                    cancelEdit();
                } else if (editingIndex !== null && index < editingIndex) {
                    // 如果删除项在编辑项之前，编辑项索引减1
                    editingIndex--;
                }
                renderList();
            }
        }

        async function saveAll() {
            const btn = document.getElementById('saveBtn');
            const originalText = btn.textContent;
            btn.textContent = '保存中...';
            btn.disabled = true;

            try {
                // 同时保存链接和分类配置
                const dataToSave = {
                    links: links,
                    categories: categories
                };

                const res = await fetch('/api/links', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify(dataToSave)
                });
                if (res.ok) {
                    alert('保存成功！');
                } else {
                    // 解析服务器的错误信息，便于定位问题
                    let msg = '';
                    try {
                        const data = await res.json();
                        msg = (data && data.error) ? data.error : '';
                        if (data && data.cause) {
                           msg += '\\n[Cause]: ' + data.cause;
                        }
                    } catch (_) {}
                    
                    if (res.status === 401) {
                        alert('密码错误');
                        localStorage.removeItem('esa_nav_token');
                        location.reload();
                    } else {
                        alert((msg || '保存失败') + ' (HTTP ' + res.status + ')');
                    }
                }
            } catch (e) { alert(e.message); }
            finally {
                btn.textContent = originalText;
                btn.disabled = false;
            }
        }
    </script>
</body>
</html>
  `;
}
