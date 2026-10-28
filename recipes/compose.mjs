/* ============================================================
 * compose.mjs —— 通用 Docker Compose 部署
 *
 * 不针对某一条方法写死，而是读 data/catalog/methods.json 里该方法的 deploy.compose
 * 指向的 compose 文件，真跑 `docker compose up -d`，然后按方法声明的端口逐个探测。
 *
 * 这个脚本在本机的诚实结局：没有 Docker 时第一步就 fail，并给出安装指引。
 * 它不会假装成功 —— 也就不会留下"点了没反应"的假按钮。
 *
 * 参数：{ method }  方法 id，例如 napcat-astrbot
 * ============================================================ */
import path from 'node:path';
import fs from 'node:fs';
import { loadMethods } from '../scripts/lib/methods.mjs';

const readMethod = (id) => loadMethods().find((m) => m.id === id) || null;

export default {
  id: 'compose',
  title: 'Docker Compose 部署',
  kind: 'method',
  steps: [
    {
      key: 'lookup',
      title: '查部署方法',
      hint: '传对方法 id：node scripts/installer.mjs run compose --method=napcat-astrbot',
      async run(ctx) {
        const id = String(ctx.params.method || '').trim();
        if (!id) return { status: 'fail', detail: '没给 method 参数' };
        const m = readMethod(id);
        if (!m) return { status: 'fail', detail: `methods.json 里没有 ${id}` };
        const rel = (m.deploy && m.deploy.compose) || '';
        if (!rel) return { status: 'fail', detail: `${m.name} 没有 compose 文件（它可能只是步骤指引）` };
        const file = path.join(ctx.paths.root, rel);
        if (!fs.existsSync(file)) return { status: 'fail', detail: `compose 文件不存在：${rel}`, hint: 'git pull 拉最新代码' };
        ctx.state.method = m;
        ctx.state.file = file;
        return { status: 'ok', detail: `${m.name} → ${rel}` };
      },
    },
    {
      key: 'docker',
      title: '检查 Docker',
      hint: 'Windows 装 Docker Desktop（要开 WSL2 后端）；装完启动它，托盘图标变绿再点部署',
      async run(ctx) {
        const v = await ctx.exec('docker', ['--version'], { timeoutMs: 15000, quiet: true });
        if (v.code !== 0) {
          return { status: 'fail', detail: '这台机器没有 docker 命令', hint: 'https://docs.docker.com/desktop/setup/install/windows-install/ 装完重启终端' };
        }
        const c = await ctx.exec('docker', ['compose', 'version'], { timeoutMs: 15000, quiet: true });
        if (c.code !== 0) return { status: 'fail', detail: 'docker 有了，但没有 compose v2 插件', hint: '升级 Docker Desktop；或装 docker-compose-plugin' };
        /* docker --version 成功但守护进程没起时，compose 会报 Cannot connect to the Docker daemon */
        const info = await ctx.exec('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20000, quiet: true });
        if (info.code !== 0) {
          return { status: 'fail', detail: 'Docker 装了但守护进程没起来', hint: '打开 Docker Desktop，等托盘变绿（显示 Engine running）再点部署' };
        }
        return { status: 'ok', detail: `${String(v.stdout).trim()} · Engine ${String(info.stdout).trim()}` };
      },
    },
    {
      key: 'up',
      title: 'docker compose up -d',
      hint: '网络拉不动镜像就配镜像加速，或先 docker pull 对应镜像再重试',
      async run(ctx) {
        const r = await ctx.exec('docker', ['compose', '-f', ctx.state.file, 'up', '-d'], { timeoutMs: 900000 });
        ctx.record({ kind: 'compose', value: ctx.state.file, why: '本次拉起的 Compose 项目' });
        if (r.code !== 0) {
          return { status: 'fail', detail: 'compose 起不来：' + String(r.stderr || r.stdout).slice(-500) };
        }
        return { status: 'ok', detail: '容器已启动（后台运行）' };
      },
    },
    {
      key: 'ports',
      title: '探测端口',
      hint: '容器 Up 但端口不通：docker compose logs 看日志；端口冲突就改 compose 的映射',
      async run(ctx) {
        const ports = (ctx.state.method.ports || []).map((p) => p.port).filter((n) => n > 0);
        if (!ports.length) return { status: 'skip', detail: '这条方法没有需要探测的固定端口' };
        const up = [];
        for (let i = 0; i < 12; i++) {
          for (const p of ports) {
            if (!up.includes(p) && await ctx.portOpen('127.0.0.1', p)) up.push(p);
          }
          if (up.length === ports.length) break;
          await new Promise((res) => setTimeout(res, 2500));
        }
        if (!up.length) return { status: 'fail', detail: `等了 30 秒，端口一个都没通：${ports.join(', ')}` };
        const miss = ports.filter((p) => !up.includes(p));
        return {
          status: miss.length ? 'manual' : 'ok',
          detail: `已通：${up.join(', ')}${miss.length ? ` · 未通：${miss.join(', ')}` : ''}`,
          hint: miss.length ? '未通的端口通常是"还要在面板里手动开一下"，例如 NapCat 的 HTTP/WS 默认是关的' : '',
        };
      },
    },
    {
      key: 'next',
      title: '剩下的手工步骤',
      hint: '这些是设计上必须你做的：扫码登录、填 API Key、配回调',
      async run(ctx) {
        const steps = (ctx.state.method.deploy && ctx.state.method.deploy.manualSteps) || [];
        if (!steps.length) return { status: 'skip', detail: '没有额外手工步骤' };
        return { status: 'manual', detail: `容器已起来，还有 ${steps.length} 步必须人工：${steps[0]}`, hint: steps.join(' → ') };
      },
    },
  ],
};
