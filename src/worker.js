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
          for (let i = 0; i < 3; i++) {
            try {
              const kv = getKV(env);
              await kv.put('data', JSON.stringify(dataToSave));
              // 简单验证写入
              // 注意：KV 最终一致性可能导致立即读取仍是旧值，这里主要捕获网络/权限错误
              lastError = null;
              break;
            } catch (e) {
              lastError = e;
              await new Promise(r => setTimeout(r, 200 * (i + 1))); // 指数退避
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
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
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
      return new Response(html, {
        headers: { ...noCacheHeaders, 'Content-Type': 'text/html;charset=UTF-8' }
      });
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
  } catch (_) {}
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
       { name: "哔哩哔哩", url: "https://www.bilibili.com", icon: "📺", category: "media" },
       { name: "腾讯视频", url: "https://v.qq.com", icon: "🎬", category: "media" },
       { name: "微信读书", url: "https://weread.qq.com", icon: "📖", category: "books" },
       { name: "知乎", url: "https://www.zhihu.com", icon: "🧠", category: "books" }
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
  } catch(e) {
    return defaultData;
  }
}

// 辅助函数：渲染主页
function renderHome(data) {
  const links = data.links || [];
  const categoryNames = data.categories || {};
  
  // 对数据进行分组
  const categories = {};
  // 默认分类
  const defaultCategory = '其他';
  
  links.forEach(link => {
    const cat = link.category || defaultCategory;
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(link);
  });

  // 生成 HTML 片段
  let categoriesHtml = '';
  
  // 决定展示顺序：
  // 1. 优先使用配置中的分类顺序 (用户在后台定义的顺序)
  // 2. 补充那些存在于链接中但未在配置中定义的分类
  const definedKeys = Object.keys(categoryNames);
  const usedKeys = Object.keys(categories);
  const extraKeys = usedKeys.filter(k => !definedKeys.includes(k));
  
  const order = [...definedKeys, ...extraKeys];

  order.forEach(catKey => {
    const items = categories[catKey] || [];

    const displayName = categoryNames[catKey] || catKey; // 如果有映射则用映射，否则用 key

    const itemsHtml = items.length > 0
      ? items.map(site => `
          <div class="site-item">
            <a href="${site.url}" target="_blank" rel="noopener noreferrer">
              <span class="site-icon">${site.icon || '🔗'}</span>
              <span>${site.name}</span>
            </a>
          </div>
        `).join('')
      : `<div class="site-item" style="color:#888;">暂无链接</div>`;

    categoriesHtml += `
      <div class="category">
        <div class="category-header active" onclick="toggleCategory(this)">
          ${displayName}
        </div>
        <div class="sites active">
          ${itemsHtml}
        </div>
      </div>
    `;
  });

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>个人导航页</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🧭</text></svg>">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: linear-gradient(135deg, #f9f9fb 0%, #f0f2f5 100%);
      color: #1d1d1f;
      line-height: 1.6;
      padding: 30px 20px;
      max-width: 840px;
      margin: 0 auto;
    }
    h1 { text-align: center; font-size: 32px; margin: 24px 0 32px; font-weight: 700; color: #2c2c2e; }
    .search-box { display: flex; margin: 0 auto 36px; max-width: 520px; border-radius: 14px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
    .search-box input { flex: 1; padding: 14px 20px; border: none; font-size: 16px; outline: none; background: white; }
    .search-box button { padding: 14px 24px; background: #007AFF; color: white; border: none; font-size: 16px; cursor: pointer; font-weight: 600; transition: background 0.2s; }
    .search-box button:hover { background: #0062cc; }
    .category { margin-bottom: 28px; background: white; border-radius: 18px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06); transition: transform 0.2s; }
    .category:hover { transform: translateY(-2px); }
    .category-header { padding: 18px 24px; font-size: 20px; font-weight: 600; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; background: #fafafa; border-bottom: 1px solid #eee; }
    .category-header::after { content: '▼'; font-size: 14px; color: #888; transition: transform 0.3s; }
    .category-header.active::after { transform: rotate(180deg); }
    .sites { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 20px; padding: 24px; display: none; }
    .sites.active { display: grid; }
    .site-item { text-align: center; padding: 12px 8px; transition: transform 0.2s, opacity 0.2s; }
    .site-item:hover { transform: scale(1.05); opacity: 0.9; }
    .site-item a { text-decoration: none; color: #1d1d1f; display: block; font-size: 14px; line-height: 1.4; font-weight: 500; }
    .site-icon { font-size: 32px; margin-bottom: 8px; display: block; line-height: 1; }
    footer { text-align: center; margin-top: 48px; padding: 24px 0; color: #86868b; font-size: 14px; border-top: 1px solid #eee; }
    @media (max-width: 480px) {
      .sites { grid-template-columns: repeat(3, 1fr); padding: 20px 16px; }
      h1 { font-size: 26px; }
    }
  </style>
</head>
<body>
  <h1>✨ 个人导航页</h1>

  <div class="search-box">
    <input type="text" id="searchInput" placeholder="输入关键词，按回车搜索..." />
    <button onclick="search()">搜索</button>
  </div>

  ${categoriesHtml}

  <footer>
    Designed with ❤️ | Powered by ESA Edge Routine | <a href="/admin">管理后台</a>
  </footer>

  <script>
    function toggleCategory(header) {
      const sites = header.nextElementSibling;
      header.classList.toggle('active');
      sites.classList.toggle('active');
    }

    function search() {
      const input = document.getElementById('searchInput');
      const query = input.value.trim();
      if (query) {
        window.open('https://www.google.com/search?q=' + encodeURIComponent(query), '_blank');
      }
    }
    
    document.getElementById('searchInput').addEventListener('keypress', function (e) {
      if (e.key === 'Enter') {
        search();
      }
    });
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
        <div id="linkList"></div>
        <div style="margin-top: 20px; text-align: right;">
            <button onclick="saveAll()" id="saveBtn">💾 保存所有更改 (链接+分类)</button>
        </div>
    </div>

    <script>
        let links = [];
        let categories = {}; // 新增分类数据
        let token = localStorage.getItem('esa_nav_token') || '';
        let editingIndex = null;
        const presetIcons = ['📺','🎬','📖','🧠','🛠️','💻','📰','🎧','🛒','✈️','📈','🎮','📷','🔍','💬','🌐','📚','🧭','🧩'];
        const presetCategories = ['media','books','tools','dev','news','music','shopping','travel','finance','games','photo','search','social','learning','work'];
        function populatePresets() {
            const iconSel = document.getElementById('iconSelect');
            presetIcons.forEach(i => { const o = document.createElement('option'); o.value = i; o.textContent = i; iconSel.appendChild(o); });
            const catSel = document.getElementById('categorySelect');
            presetCategories.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o); });
        }
        populatePresets();

        if (token) {
            validateAndInit();
        }

        async function login() {
            const input = document.getElementById('authPassword').value.trim();
            if (!input) return;
            try {
                const res = await fetch('/api/auth', { headers: { 'Authorization': 'Bearer ' + input } });
                if (res.ok) {
                    token = input;
                    localStorage.setItem('esa_nav_token', token);
                    document.getElementById('authModal').classList.add('hidden');
                    fetchLinks();
                } else {
                    alert('密码错误');
                    localStorage.removeItem('esa_nav_token');
                }
            } catch (e) {
                alert('网络错误');
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

        function renderCategoryList() {
            const el = document.getElementById('categoryList');
            el.innerHTML = '';
            Object.keys(categories).forEach(key => {
                const item = document.createElement('div');
                item.className = 'list-item';
                item.style.padding = '8px';
                item.innerHTML = \`
                    <div><span class="tag">\${key}</span> <strong>\${categories[key]}</strong></div>
                    <button class="danger" onclick="removeCategory('\${key}')" style="padding: 4px 8px; font-size: 12px;">删除</button>
                \`;
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
                // 尝试获取分类名称
                const catName = categories[link.category] || link.category || '其他';
                // 注意：这里的反斜杠是必须的，因为我们要输出 \${} 到客户端 JS 中
                item.innerHTML = \`
                    <div>
                        <span style="margin-right: 8px; font-size: 1.2em;">\${link.icon || '🔗'}</span>
                        <strong>\${link.name}</strong> 
                        <span class="tag">\${catName}</span>
                        <div style="font-size:12px; color:#888;">\${link.url}</div>
                    </div>
                    <div>
                        <button onclick="editLink(\${index})" style="padding: 6px 12px; font-size: 12px; margin-right: 5px; background: #007AFF;">编辑</button>
                        <button class="danger" onclick="removeLink(\${index})" style="padding: 6px 12px; font-size: 12px;">删除</button>
                    </div>
                \`;
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
            const icon = iconCustom || iconSel;
            const category = categoryCustom || categorySel;

            if (!name || !url) return alert('名称和 URL 必填');

            if (editingIndex !== null) {
                // 修改
                links[editingIndex] = { name, url, icon, category };
                cancelEdit(); // 退出编辑模式
            } else {
                // 新增
                links.push({ name, url, icon, category });
                // 清空表单
                ['linkName', 'linkUrl', 'linkIcon', 'linkCategory'].forEach(id => document.getElementById(id).value = '');
                document.getElementById('iconSelect').value = '';
                document.getElementById('categorySelect').value = '';
            }
            
            renderList();
        }

        function editLink(index) {
            const link = links[index];
            document.getElementById('linkName').value = link.name;
            document.getElementById('linkUrl').value = link.url;
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
            ['linkName', 'linkUrl', 'linkIcon', 'linkCategory'].forEach(id => document.getElementById(id).value = '');
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
