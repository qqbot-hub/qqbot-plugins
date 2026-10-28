/* Node.js 运行时：只检查，不代替你装（官方安装器要管理员点下一步） */
export default {
  id: 'node',
  title: 'Node.js 运行时',
  kind: 'prereq',
  steps: [
    {
      key: 'version',
      title: '检查 Node 版本',
      hint: '去 https://nodejs.org/zh-cn/download 装 LTS（20 以上），装完关掉所有终端重开',
      async run(ctx) {
        const v = process.version;
        const major = Number((v.match(/v(\d+)/) || [])[1] || 0);
        if (major >= 18) return { status: 'ok', detail: `已安装 ${v}（${process.execPath}）` };
        return { status: 'fail', detail: `版本太低：${v}，本市场要求 18 以上` };
      },
    },
    {
      key: 'core',
      title: '检查内置模块可用',
      async run(ctx) {
        const need = ['http', 'net', 'crypto', 'child_process'];
        const bad = [];
        for (const m of need) {
          try { await import('node:' + m); } catch { bad.push(m); }
        }
        if (bad.length) return { status: 'fail', detail: '缺少模块：' + bad.join(', '), hint: 'Node 安装不完整，建议重新安装官方 LTS 版本' };
        return { status: 'ok', detail: `${need.length} 个内置模块正常` };
      },
    },
  ],
};
