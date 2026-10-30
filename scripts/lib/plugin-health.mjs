import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataPath, readJson } from './paths.mjs';
import { registered } from './dsh-registration.mjs';
import { decrypt } from './secrets.mjs';
import { createOneBot } from '../../plugins/_bridge.mjs';
export function stateSignature() {
  const state = readJson('state', {});
  return crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(state).map(([id, s]) => [id, { installed: !!s.installed, enabled: !!s.enabled }])))).digest('hex');
}
export function observedTools(root) {
  const dir = path.join(path.dirname(dataPath('state')), 'mcp-observers');
  const names = new Set();
  try { for (const f of fs.readdirSync(dir)) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (r.root !== root || r.signature !== stateSignature() || Date.now() - r.at > 10000 || !/deepseek|harness|dsh/i.test(r.client || '')) continue;
      process.kill(r.pid, 0);
      for (const name of r.tools || []) names.add(name);
    } catch {}
  } } catch {}
  return names;
}
export async function pluginHealth(id, cfg, { root, probe, call, loaded = observedTools(root), now = Date.now() } = {}) {
  const values = Object.fromEntries(Object.entries(cfg.plugins?.[id] || {}).map(([k, v]) => [k, typeof v === 'string' ? decrypt(v) : v]));
  const sl = cfg.snowluma || {}, ob = cfg.onebot || {};
  const client = createOneBot({ ...ob, httpUrl: ob.httpUrl || sl.httpUrl, accessToken: decrypt(cfg.secrets?.['snowluma-dsh.onebotToken'] || ob.accessToken || sl.accessToken || ''), timeoutMs: 2000 });
  const invoke = call || ((a, args) => client.onebot(a, args));
  const hb = probe || (() => client.heartbeat({ force: true }));
  const state = readJson('state', {})[id];
  const meta = readJson('plugins', []).find(p => p.id === id);
  const reg = registered(cfg.dsh?.profile || 'desktop');
  const names = (meta?.tools || []).map(t => t.name);
  const isLoaded = names.length > 0 && names.every(n => loaded.has(n));
  const result = (code, detail, checked = false) => ({ code, detail, checked, installed: !!state?.installed, registered: reg, loaded: isLoaded, at: now });
  if (!state?.installed || !state.enabled) return result('uninstalled', '未安装或已停用');
  if (id === 'voice' && (values.provider || 'openai') === 'openai' && !values.apiKey) return result('config', '未配置语音 API Key；也可选择本地后端');
  if (id === 'vision' && (values.provider || 'siliconflow') !== 'ollama' && !values.apiKey) return result('config', '未配置识图 API Key；也可选择 Ollama');
  if (id === 'video' && !values.apiKey) return result('partial', '视频链接解析可用性待验证；视频理解缺 API Key');
  if (['voice', 'vision', 'video'].includes(id)) return result('configured', '后端参数已配置，尚未验证真实调用；不自动发起付费请求');
  try {
    if (['qzone', 'group_admin', 'group_info'].includes(id)) {
      const h = await hb();
      if (!h.online) return result('offline', '协议端未通过登录验证');
      const actions = h.capabilities?.onebotActions || cfg.onebot?.capabilities?.onebotActions;
      if (actions) {
        const supports = action => Array.isArray(actions) ? actions.includes(action) : actions[action] === true;
        if ((meta?.requires?.onebotActions || []).some(action => !supports(action))) return result('unsupported', '协议端声明缺少此插件所需接口');
      }
      if (id === 'qzone' && /snowluma/i.test(h.app + ' ' + h.impl) && Number(String(h.version).replace(/^v/i, '').split('.')[0]) >= 2) return result('unsupported', 'SnowLuma 2.x 未提供空间接口');
      const action = id === 'qzone' ? 'get_qq_zone_feeds' : 'get_group_list';
      await invoke(action, {}); await invoke(action, {});
      return result(isLoaded && reg ? 'ready' : 'checked', id === 'qzone' ? '空间读取检查通过；发布动作未验证' : '群列表读取检查通过；禁言、踢人等写操作未验证', true);
    }
    if (id === 'sticker') {
      const { default: def } = await import('../../plugins/sticker.mjs');
      const tool = def.tools.find(t => t.name === 'qq_sticker_list');
      await tool.run({}, { cfg: values }); await tool.run({}, { cfg: values });
      return result(isLoaded && reg ? 'ready' : 'checked', '表情库只读检查通过；发送能力另需协议端', true);
    }
    return result(isLoaded ? 'loaded' : reg ? 'registered' : 'installed', isLoaded ? 'DSH 客户端已列出工具，功能尚未实测' : reg ? '已注册，等待 DSH 客户端列出工具' : '已安装，尚未注册到 DSH');
  } catch (e) {
    return result(/unknown action|不支持|unsupported/i.test(e.message) ? 'unsupported' : 'error', '只读检查未通过；请检查协议能力、连接及权限');
  }
}
