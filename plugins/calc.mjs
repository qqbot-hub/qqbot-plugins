/* calc —— 算数/单位换算类的小计算 */
'use strict';
/* 无 eval 的递归下降表达式求值器：数字与 + - * / % ( ) ^ */
function evaluate(expr) {
  let i = 0;
  const s = expr.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/');
  if (!/^[\d.+\-*/%()^]+$/.test(s)) throw new Error('只支持数字与 + - * / % ( ) ^');
  const peek = () => s[i];
  function parseExpr() {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = parseTerm(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  function parseTerm() {
    let v = parsePow();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = s[i++]; const r = parsePow();
      if ((op === '/' || op === '%') && r === 0) throw new Error('除数不能为 0');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function parsePow() {
    const base = parseUnary();
    if (peek() === '^') { i++; return Math.pow(base, parsePow()); }
    return base;
  }
  function parseUnary() {
    if (peek() === '-') { i++; return -parseUnary(); }
    if (peek() === '+') { i++; return parseUnary(); }
    return parseAtom();
  }
  function parseAtom() {
    if (peek() === '(') {
      i++; const v = parseExpr();
      if (peek() !== ')') throw new Error('括号不配对');
      i++; return v;
    }
    const m = /^[\d.]+/.exec(s.slice(i));
    if (!m) throw new Error('位置 ' + i + ' 处不是合法表达式');
    i += m[0].length;
    const n = parseFloat(m[0]);
    if (!Number.isFinite(n)) throw new Error('数字不合法');
    return n;
  }
  const v = parseExpr();
  if (i < s.length) throw new Error('位置 ' + i + ' 处有多余字符');
  return v;
}

export default {
  meta: { id: 'calc', name: 'calc', description: '算数/单位换算类的小计算', category: '工具' },
  tools: [{
    name: 'qq_calc',
    description: '算一个算式（群里问"这几样加起来多少钱/打八折多少"时用）。只支持数字与 + - * / % ( ) ^。',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: '算式，如 3.5*8+12*(1-0.2)' } },
      required: ['expression'],
    },
    run: async ({ expression }) => {
      const v = evaluate(String(expression));
      const out = Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(6)));
      return `${expression} = ${out}`;
    },
  }],
};
