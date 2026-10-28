/* NapCat 协议端（可选替代 SnowLuma）
 *
 * 它走 QQ NT 客户端注入，有公开 Release，所以这一步是真的自动下载 + 解压：
 *   latest release → NapCat.Shell.zip → runtimes/napcat → 解压
 * 装完仍然需要你在它面板里登录 QQ、开 HTTP/WS —— 任何协议端都绕不过登录。
 */
import path from 'node:path';
import fs from 'node:fs';
import { httpJson } from './../scripts/lib/net.mjs';

const REPO = 'NapNeko/NapCatQQ';

export default {
  id: 'napcat',
  title: 'NapCat 协议端',
  kind: 'protocol',
  steps: [
    {
      key: 'detect',
      title: '检查是否已安装',
      async run(ctx) {
        const dir = ctx.paths.runtimeDir('napcat');
        const marker = path.join(dir, 'napcat.mjs');
        const alt = path.join(dir, 'NapCatWinBootMain.exe');
        if (fs.existsSync(dir) && (fs.existsSync(marker) || fs.existsSync(alt) || fs.existsSync(path.join(dir, 'package.json')))) {
          ctx.state.dir = dir;
          return { status: 'ok', detail: '已装在 ' + dir };
        }
        ctx.state.dir = dir;
        return { status: 'skip', detail: '还没装，进入下载步骤' };
      },
    },
    {
      key: 'release',
      title: '查询最新发行版',
      hint: '打不开 GitHub 就手动去 https://github.com/NapNeko/NapCatQQ/releases 下载 NapCat.Shell.zip，解压到 runtimes\\napcat',
      async run(ctx) {
        if (ctx.state.dir && fs.existsSync(ctx.state.dir) && fs.existsSync(path.join(ctx.state.dir, 'package.json'))) {
          return { status: 'skip', detail: '已装，跳过下载' };
        }
        let resp;
        try {
          resp = await httpJson(`https://api.github.com/repos/${REPO}/releases/latest`, {
            headers: { 'User-Agent': 'qqbot-plugins-installer', Accept: 'application/vnd.github+json' },
          });
        } catch (e) {
          return { status: 'fail', detail: '查不到发行版信息：' + e.message };
        }
        /* httpJson 返回的是 { ok, status, data } 包装对象，真实数据在 .data 里 */
        if (!resp || !resp.ok) {
          return {
            status: 'fail',
            detail: `GitHub 返回 ${resp ? resp.status : '无响应'}${resp && resp.status === 403 ? '（接口限流，稍后再试）' : ''}`,
            hint: '打不开 GitHub 就手动去 https://github.com/NapNeko/NapCatQQ/releases 下载 NapCat.Shell.zip，解压到 runtimes\\napcat',
          };
        }
        const data = resp.data || {};
        if (!Array.isArray(data.assets)) {
          return {
            status: 'fail',
            detail: 'GitHub 返回的内容里没有 assets（可能是接口被拦截或返回了错误页）',
            hint: '手动下载 https://github.com/NapNeko/NapCatQQ/releases 的 NapCat.Shell.zip，解压到 runtimes\\napcat 再点一次安装',
          };
        }
        const zip = data.assets.find((a) => /Shell\.zip$/i.test(a.name) && !/framework/i.test(a.name))
          || data.assets.find((a) => /\.zip$/i.test(a.name));
        if (!zip) return { status: 'fail', detail: '这次发行版里没有 zip 包，只有：' + data.assets.map((a) => a.name).join(', ') };
        ctx.state.zipUrl = zip.browser_download_url;
        ctx.state.version = data.tag_name || '';
        ctx.state.sizeMB = Math.round((zip.size || 0) / 1048576);
        return { status: 'ok', detail: `${data.tag_name} · ${zip.name} · ${ctx.state.sizeMB} MB` };
      },
    },
    {
      key: 'download',
      title: '下载安装包',
      hint: '网络不稳就手动下载后放到 runtimes\\napcat 里再点一次安装',
      async run(ctx) {
        if (!ctx.state.zipUrl) return { status: 'skip', detail: '已装或无需下载' };
        const dir = ctx.state.dir;
        fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, '_napcat.zip');
        // 用 curl 下（Node 原生 fetch 在这台机器的 TLS 代理下会证书校验失败）
        const r = await ctx.exec('curl', ['-L', '--ssl-no-revoke', '--retry', '2', '-m', '600', '-o', out, ctx.state.zipUrl], { timeoutMs: 620000 });
        if (r.code !== 0 || !fs.existsSync(out)) return { status: 'fail', detail: '下载失败：' + (r.stderr || '').slice(0, 200) };
        const mb = Math.round(fs.statSync(out).size / 1048576);
        ctx.state.zip = out;
        return { status: 'ok', detail: `已下载 ${mb} MB` };
      },
    },
    {
      key: 'extract',
      title: '解压到 runtimes/napcat',
      hint: '手动右键解压那个 zip 到 runtimes\\napcat 目录即可',
      async run(ctx) {
        if (!ctx.state.zip) return { status: 'skip', detail: '没有待解压的包' };
        const dir = ctx.state.dir;
        const r = await ctx.exec('powershell.exe', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath '${ctx.state.zip}' -DestinationPath '${dir}' -Force`], { timeoutMs: 180000 });
        if (r.code !== 0) return { status: 'fail', detail: '解压失败：' + ((r.stderr || r.stdout || '').slice(0, 200)) };
        try { fs.unlinkSync(ctx.state.zip); } catch { /* 删不掉留着也没事 */ }
        const items = fs.readdirSync(dir).filter((n) => n !== '_napcat.zip');
        return { status: 'ok', detail: `解压出 ${items.length} 项：${items.slice(0, 6).join(', ')}` };
      },
    },
    {
      key: 'login',
      title: '等你在面板里登录 QQ',
      hint: '启动 NapCat（runtimes\\napcat 里的启动脚本），在它的 WebUI 里登录 QQ 并开启 HTTP 3000 / WS 3001，然后点一次安装',
      async run(ctx) {
        const open = await ctx.portOpen('127.0.0.1', 3000);
        if (open) return { status: 'ok', detail: 'HTTP 3000 已就绪' };
        return { status: 'manual', detail: '文件已就位，剩下登录必须在 NapCat 面板里完成（扫码/密码，无法代劳）' };
      },
    },
  ],
};
