import { pluginHealth } from '../scripts/lib/plugin-health.mjs';
import { registered, profileFile } from '../scripts/lib/dsh-registration.mjs';
/* 通用插件安装：本市场的每个插件都走这一份脚本
 *
 * 参数：{ id }  插件 id（对应 data/catalog/plugins.json 里的 id 与 plugins/<id>.mjs）
 *
 * 它做的事，就是「点安装」背后的全部真动作：
 *   1. 校验插件文件在不在、能不能被加载（加载不了就别写状态，免得装个坏的）
 *   2. 检查插件声明的必填配置（没填就停下来让你填，而不是装完一用就报错）
 *   3. 写安装状态（data/state/plugins.json）
 *   4. 确认 DSH 侧 MCP 已注册（没注册自动补，这是「装了却用不了」的根源）
 *   5. 自检：能列出几个工具，就算真的可用
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { dataPath, readJson, writeJson } from '../scripts/lib/paths.mjs';

const loadCatalog = () => readJson('plugins', []) || [];

export default {
  id: 'plugin',
  title: '安装插件',
  kind: 'plugin',
  steps: [
    {
      key: 'lookup',
      title: '查插件清单',
      hint: '把插件 id 传对：node scripts/installer.mjs run plugin --id=clock',
      async run(ctx) {
        const id = String(ctx.params.id || '').trim();
        if (!id) return { status: 'fail', detail: '没给插件 id' };
        const meta = loadCatalog().find((p) => p.id === id);
        if (!meta) return { status: 'fail', detail: `清单里没有 ${id} 这个插件` };
        ctx.state.id = id;
        ctx.state.meta = meta;
        const tools = (meta.tools || []).map((t) => t.name);
        return { status: 'ok', detail: `${meta.name}（${meta.category}）· 提供 ${tools.length} 个工具${tools.length ? '：' + tools.join(', ') : ''}` };
      },
    },
    {
      key: 'file',
      title: '校验插件文件',
      hint: '仓库不完整：git pull 拉最新代码后再装',
      async run(ctx) {
        const file = path.join(ctx.paths.root, 'plugins', ctx.state.id + '.mjs');
        if (!fs.existsSync(file)) return { status: 'fail', detail: `缺少 plugins/${ctx.state.id}.mjs` };
        try {
          const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
          const t = (mod.default && mod.default.tools) || [];
          if (!t.length) return { status: 'fail', detail: '插件加载成功但没声明任何工具' };
          ctx.state.toolCount = t.length;
          return { status: 'ok', detail: `${t.length} 个工具可加载` };
        } catch (e) {
          return { status: 'fail', detail: '加载失败：' + e.message, hint: '这个插件代码有问题，先别装；把报错发给我' };
        }
      },
    },
    {
      key: 'config',
      title: '检查必填配置',
      hint: '在市场页面打开这个插件的「配置」把必填项填上，再点一次安装',
      async run(ctx) {
        const file = path.join(ctx.paths.root, 'plugins', ctx.state.id + '.mjs');
        let mod;
        try { mod = await import(pathToFileURL(file).href + '?t=' + Date.now()); } catch { return { status: 'skip', detail: '拿不到 schema，跳过检查' }; }
        const settings = (mod.default && mod.default.settings) || null;
        if (!settings || !Array.isArray(settings.fields)) return { status: 'ok', detail: '不需要配置' };
        const values = (ctx.cfg().plugins || {})[ctx.state.id] || {};
        const requiredFields = settings.fields.filter((f) => f.required);
        const missing = requiredFields
          .filter((f) => !String(values[f.key] ?? '').trim())
          .map((f) => f.label || f.key);
        if (missing.length) return { status: 'manual', detail: `还差必填项：${missing.join('、')}` };
        /* 没有必填项时不能说「N 项配置齐全」——那是在暗示已经配好了。
         * 装得上 ≠ 配好了：接口 Key 这类留空的插件，装完调用时会自己提示去填。 */
        if (!requiredFields.length) {
          return { status: 'ok', detail: `没有必填项（另有 ${settings.fields.length} 项可选，可在「⚙ 配置」里填）` };
        }
        return { status: 'ok', detail: `${requiredFields.length} 项必填已填` };
      },
    },
    {
      key: 'record',
      title: '写入安装状态',
      async run(ctx) {
        const st = readJson('state', {}) || {};
        st[ctx.state.id] = Object.assign({}, st[ctx.state.id], {
          installed: true,
          enabled: true,
          installedAt: new Date().toISOString(),
        });
        const p = writeJson('state', st);
        return { status: 'ok', detail: '已记录到 ' + path.relative(ctx.paths.root, p) };
      },
    },
    {
      key: 'mcp',
      title: '确认已注册进 DSH',
      hint: '跑 node scripts/register-dsh.mjs desktop 手动注册，然后完全退出 DSH 再打开',
      async run(ctx) {
        const profile = (ctx.cfg().dsh && ctx.cfg().dsh.profile) || 'desktop';
        const yml = profileFile(profile);
        if (!fs.existsSync(path.dirname(yml))) return { status: 'skip', detail: '这台机器没装 DSH，插件状态已存好；装好 DSH 后再跑一次本安装' };
        const has = registered(profile);
        if (has) return { status: 'ok', detail: 'MCP 已在 DSH 配置里' };
        const r = await ctx.exec(process.execPath, [path.join('scripts', 'register-dsh.mjs'), profile], { timeoutMs: 30000 });
        if (r.code !== 0) return { status: 'fail', detail: '自动注册失败：' + (r.stdout + r.stderr).slice(0, 200) };
        ctx.state.needRestart = true;
        return { status: 'ok', detail: `已自动注册到 profile ${profile}` };
      },
    },
    {
      key: 'verify',
      title: '自检',
      async run(ctx) {
        const st = readJson('state', {}) || {};
        const ok = !!(st[ctx.state.id] && st[ctx.state.id].installed);
        if (!ok) return { status: 'fail', detail: '状态没写进去' };
        const health = await pluginHealth(ctx.state.id, ctx.cfg(), { root: ctx.paths.root });
        st[ctx.state.id].health = health; writeJson('state', st);
        if (['config', 'unsupported', 'offline', 'error','bridge_denied','policy_denied'].includes(health.code)) return { status: 'manual', detail: health.detail, hint: '插件安装状态已保留；请处理配置、协议能力或登录问题后重新检查' };
        return { status: 'ok', detail: health.detail + '；安装不等于 DSH 已加载或所有动作可用' };
      },
    },
  ],
};
