// Isolated integration tests; this does not claim real QQ/VM acceptance.
import { spawnSync } from 'node:child_process';
for (const file of ['scripts/test-deploy-integration.mjs', 'scripts/test-snowluma.mjs', 'scripts/test-deploy-agent.mjs']) {
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
