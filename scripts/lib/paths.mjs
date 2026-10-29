/* ============================================================
 * paths.mjs —— 项目里所有数据文件的唯一路径出口
 *
 * 为什么要有这个文件：
 *   早先 scripts / server / mcp-server 各自拼 'data/plugins.json' 这类字符串，
 *   目录一改就要全仓库找路径。现在统一从这里取，且**优先新结构、回退旧位置**，
 *   老部署升级上来不会因为文件搬家而读不到数据。
 *
 * 目录结构（data/）：
 *   catalog/plugins.json      50 个自有插件（能装进机器人，走 MCP 暴露工具）
 *   catalog/companions.json   3 个配套程序（桌面宠物 / TTS 引擎 / 调音台，独立运行）
 *   catalog/components.json   链路上的运行时组件（协议端 / 桥 / DSH / 市场本体）
 *   sources/external.json     外部插件源定义（GitHub 查询式）
 *   snapshots/hub.json        外部源抓取快照
 *   state/plugins.json        插件安装状态（installed / enabled / 安装时间）
 *   state/jobs.json           安装任务记录（最近若干次，供页面回看）
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA = path.join(ROOT, 'data');

/* 新位置 → 旧位置的候选表（按顺序探测，先命中先用） */
const MAP = {
  plugins: ['catalog/plugins.json', 'plugins.json'],
  companions: ['catalog/companions.json'],
  components: ['catalog/components.json'],
  sources: ['sources/external.json', 'sources.json'],
  hub: ['snapshots/hub.json', 'hub.json'],
  state: ['state/plugins.json', 'state.json'],
  jobs: ['state/jobs.json'],
  koishiPlugins: ['state/koishi-plugins.json'],
  /* 生态插件安装登记：都是本机运行时状态（含包名/路径），必须落在 state/ 下、不入库 */
  nonebotPlugins: ['state/nonebot-plugins.json'],
  astrbotPlugins: ['state/astrbot-plugins.json'],
};

/** 返回某个逻辑数据文件的真实路径（不存在时返回首选新路径，便于首次写入）
 *
 * 两个环境变量可以把「本机运行时状态」重定向到别处：
 *   QQBOT_STATE_FILE  安装状态（server.js 本来就用它）
 *   QQBOT_JOBS_FILE   安装任务记录
 * 这样「装一遍试试」的测试不会把任务历史写进用户的 data/state，
 * 也不会顺手把 clock 装到用户机器上。 */
const ENV_OVERRIDE = { state: 'QQBOT_STATE_FILE', jobs: 'QQBOT_JOBS_FILE' };

export function dataPath(key) {
  const envName = ENV_OVERRIDE[key];
  if (envName && process.env[envName]) return path.resolve(process.env[envName]);
  const list = MAP[key] || [key];
  for (const rel of list) {
    const p = path.join(DATA, rel);
    if (fs.existsSync(p)) return p;
  }
  return path.join(DATA, list[0]);
}

export function readJson(key, fallback) {
  try { return JSON.parse(fs.readFileSync(dataPath(key), 'utf8')); } catch { return fallback; }
}

export function writeJson(key, obj) {
  const p = dataPath(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  return p;
}

/** 市场自己的配置（连接渠道 / 插件参数 / 口令），留在根目录，用户好找 */
export const CFG_FILE = path.join(ROOT, 'config.json');

export function readCfg(fallback = {}) {
  try { return Object.assign(fallback, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch { return fallback; }
}

export function writeCfg(cfg) {
  const body = Object.assign({}, cfg);
  delete body.templates;
  fs.writeFileSync(CFG_FILE, JSON.stringify(body, null, 2) + '\n');
}

/** 安装目录：第三方运行时（协议端/桥/调音台）默认装到这里的 <id>/ 下 */
export const RUNTIMES = path.join(ROOT, 'runtimes');
