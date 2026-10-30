#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerMarket } from './lib/dsh-registration.mjs';
const args = process.argv.slice(2);
try {
 const result = registerMarket({ profile: args.find(a => !a.startsWith('--')) || 'desktop', remove: args.includes('--remove'), script: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp-server.mjs') });
 console.log(JSON.stringify(result));
 console.log('MCP registration saved. Reload the DSH profile if this is the first registration. Installed plugin tools refresh automatically.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
