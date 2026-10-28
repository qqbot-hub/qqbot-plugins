/* ============================================================
 * toml-lite.mjs —— 只做一件事：读写 pyproject.toml 里的
 *                  [tool.nonebot] plugins 数组
 *
 * 为什么不用现成的 TOML 库：
 *   整个项目零依赖（Node 原生 http，没有 node_modules）。为了改一个数组
 *   引入 @iarna/toml 不划算，而且库会重排整个文件、吃掉用户注释。
 *
 * 这里的做法是「外科手术」：只在 plugins = [...] 这个表达式上动手，
 * 其余字节原样保留 —— 用户自己写的 [project]、注释、其他段都不受影响。
 * ============================================================ */

const SECTION_RE = /^[ \t]*\[tool\.nonebot\][ \t]*$/m;

/** 找 [tool.nonebot] 段的范围（不含段标题行）；找不到返回 null */
function sectionRange(text) {
  const m = SECTION_RE.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  /* 段内遇到下一个表头（[xxx]）就结束；数组里的 [ ] 不会出现在行首，不会被误判 */
  const next = /^[ \t]*\[/m.exec(rest);
  return { start, end: next ? start + next.index : text.length };
}

/** 从 `plugins = [` 开始找到配对的 `]`，跳过引号内的字符 */
function findArrayEnd(text, openIdx) {
  let i = openIdx + 1;
  let quote = null;
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[') depth++;
    if (c === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** 解析数组表达式里的字符串元素，支持双引号/单引号，忽略注释 */
export function parseTomlStringArray(expr) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m;
  while ((m = re.exec(expr))) {
    const raw = m[1] != null ? m[1] : m[2];
    out.push(String(raw).replace(/\\(["\\])/g, '$1'));
  }
  return out;
}

/** 读 [tool.nonebot] plugins；没有段/没有键 → 空数组 */
export function readNonebotPlugins(text) {
  const range = sectionRange(text);
  if (!range) return [];
  const body = text.slice(range.start, range.end);
  const key = /^[ \t]*plugins[ \t]*=[ \t]*\[/m.exec(body);
  if (!key) return [];
  const openIdx = range.start + key.index + key[0].length - 1;
  const closeIdx = findArrayEnd(text, openIdx);
  if (closeIdx < 0) return [];
  return parseTomlStringArray(text.slice(openIdx, closeIdx + 1));
}

const fmt = (names) => (names.length
  ? '[' + names.map((n) => '"' + String(n).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(', ') + ']'
  : '[]');

/**
 * 把插件清单写成 names（去重、保持原顺序）。
 * 返回 { text, changed, before }；changed=false 表示内容本来就一致，不必写盘。
 */
export function upsertNonebotPlugins(text, names) {
  const list = [];
  for (const n of names || []) {
    const v = String(n || '').trim();
    if (v && !list.includes(v)) list.push(v);
  }
  const before = readNonebotPlugins(text);
  const same = before.length === list.length && before.every((v, i) => v === list[i]);
  if (same) return { text, changed: false, before };

  const range = sectionRange(text);
  const line = `plugins = ${fmt(list)}`;
  if (!range) {
    const trimmed = text.replace(/\s*$/, '');
    return {
      text: (trimmed ? trimmed + '\n\n' : '') + '[tool.nonebot]\n' + line + '\n',
      changed: true,
      before,
    };
  }
  const body = text.slice(range.start, range.end);
  const key = /^[ \t]*plugins[ \t]*=[ \t]*\[/m.exec(body);
  if (!key) {
    /* 段在、键不在：插在段标题下一行 */
    return {
      text: text.slice(0, range.start) + '\n' + line + text.slice(range.start),
      changed: true,
      before,
    };
  }
  const openIdx = range.start + key.index + key[0].length - 1;
  const closeIdx = findArrayEnd(text, openIdx);
  if (closeIdx < 0) {
    /* 数组没闭合：这文件本身坏了，不做猜测性修复 */
    throw new Error('pyproject.toml 里 plugins = [ 没有闭合的 ]，请手动修好再装');
  }
  return {
    text: text.slice(0, range.start + key.index) + line + text.slice(closeIdx + 1),
    changed: true,
    before,
  };
}
