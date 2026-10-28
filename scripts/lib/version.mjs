/* ============================================================
 * version.mjs —— 只回答一个问题：有没有更新的版本
 *
 * 为什么不用现成的 semver 包：
 *   1) 本项目是零依赖，进一个包就破坏约定；
 *   2) 真实生态里的版本号根本不干净 —— PyPI 会给 "2.7.8rc1"，
 *      npm 的 dist-tags 是干净的但用户填的可能是 "^1.2.3"，
 *      AstrBot 的 metadata.yaml 经常写成 "v1.3.0"。
 *   所以这里做的是「宽松解析 + 保守比较」：解析不出来就返回 null，
 *   由调用方决定"版本未知就不提示更新"，绝不猜。
 *
 * 注意 pre-release 的大小关系（这是最容易写错的一段）：
 *   1.0.0-rc1 < 1.0.0-rc2 < 1.0.0
 * 有 prerel 的永远小于同号正式版。
 * ============================================================ */

/** 去掉前缀噪声：^ ~ = > < v 空格 */
export function normalizeVer(v) {
  return String(v == null ? '' : v)
    .trim()
    .replace(/^[\^~=><\s]+/, '')
    .replace(/^[vV]/, '')
    .trim();
}

/**
 * 解析成 { nums:[major,minor,patch], pre:string }；解析不出来返回 null
 * 接受：1 / 1.2 / 1.2.3 / v1.2.3 / 1.2.3rc1 / 1.2.3-beta.1 / 1.2.3+build
 */
export function parseVer(v) {
  const s = normalizeVer(v);
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/.exec(s);
  if (!m) return null;
  /* 剩下的尾巴只认 pre-release：-xxx / rc1 / b1 / alpha 这类；
   * 带 + 的 build metadata 按 semver 规则不参与比较，直接丢掉 */
  let rest = String(m[4] || '');
  const plus = rest.indexOf('+');
  if (plus >= 0) rest = rest.slice(0, plus);
  rest = rest.replace(/^[-_.]/, '');
  return {
    nums: [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)],
    pre: rest,
  };
}

/** -1 / 0 / 1；任一侧解析不出来返回 null（调用方据此放弃比较） */
export function cmpVer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  }
  /* 主版本号相同，比 pre-release：没 pre 的更大（1.0.0 > 1.0.0-rc1） */
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre === y.pre ? 0 : (x.pre > y.pre ? 1 : -1);
}

/** latest 是否比 current 新；current 为空视为"没装过"，返回 true */
export function isNewer(latest, current) {
  const cur = normalizeVer(current);
  if (!cur) return !!normalizeVer(latest);
  const c = cmpVer(latest, cur);
  /* 比不了就不提示更新 —— 宁可漏报，也别天天弹"有新版本"结果装上去一样 */
  return c == null ? false : c > 0;
}

/** 展示用：统一带 v 前缀，避免页面上出现 vv1.3.0 */
export function fmtVer(v) {
  const s = normalizeVer(v);
  return s ? 'v' + s : '';
}

/** 从 pip show / npm ls 之类的输出里抓版本号（抓不到返回 ''） */
export function grabVersion(text, key) {
  const t = String(text || '');
  if (key) {
    const re = new RegExp('^' + key + ':\\s*(\\S+)', 'm');
    const m = re.exec(t);
    if (m) return normalizeVer(m[1]);
  }
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.]+)?)/.exec(t);
  return m ? normalizeVer(m[1]) : '';
}
