import { DEPLOY_TOOLS } from './lib/deploy-agent.mjs';
export const name = 'qqbot-deploy-only';
export const inject = ['tools'];
export function apply(ctx) {
  if (typeof ctx.tools.guard !== 'function') throw new Error('DSH 版本不支持部署执行守卫');
  const allowed = new Set(DEPLOY_TOOLS.map(t => t.name));
  ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : '部署任务只允许 deploy_status/deploy_step/deploy_verify');
  for (const tool of DEPLOY_TOOLS) ctx.tools.register({
    name: tool.name, description: tool.description, parameters: tool.inputSchema,
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const url = new URL(process.env.QQBOT_DEPLOY_URL);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('部署地址必须为本机');
      const response = await fetch(url.origin + '/api/deploy/tool', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.QQBOT_DEPLOY_CAPABILITY },
        body: JSON.stringify({ name: tool.name, args }), signal: AbortSignal.timeout(660000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '部署工具调用失败');
      return result;
    },
  });
}
