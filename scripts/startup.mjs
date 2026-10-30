import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './lib/paths.mjs';
if (process.platform !== 'win32') throw new Error('Windows login startup only');
const startup = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'Microsoft/Windows/Start Menu/Programs/Startup/qqbot-plugins.cmd');
const mode = process.argv[2];
if (mode === '--disable') { fs.rmSync(startup, { force: true }); console.log('Login startup disabled'); }
else if (mode === '--enable') {
  if (/[\r\n%]/.test(ROOT)) throw new Error('Unsafe cmd project path');
  fs.mkdirSync(path.dirname(startup), { recursive: true });
  fs.writeFileSync(startup, '@echo off\r\nstart "qqbot-plugins" /min "' + path.join(ROOT, 'start.bat') + '"\r\n');
  console.log('Login startup enabled: ' + startup);
} else console.log('Usage: node scripts/startup.mjs --enable | --disable');
