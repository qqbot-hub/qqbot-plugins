import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseDocument, isMap, isSeq, visit } from 'yaml';
export function profileFile(profile = 'desktop', home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh')) {
  if (!/^[\w.-]+$/.test(profile) || ['.', '..'].includes(profile)) throw new Error('Invalid DSH profile');
  return path.join(home, 'profiles', profile, 'cordis.patch.yml');
}
export function parsePatch(text) {
  const doc = parseDocument(text || '[]', { uniqueKeys: true });
  if (doc.errors.length) throw new Error('Invalid DSH YAML: ' + doc.errors[0].message);
  if (!doc.contents) doc.contents = doc.createNode([]);
  if (!isSeq(doc.contents)) throw new Error('DSH patch must be a sequence');
  return doc;
}
export function registrationCount(text) {
  let count = 0;
  visit(parsePatch(text), { Map(_key, node) { if (node.get('id') === 'mcp-qqbot') count++; } });
  return count;
}
export function registered(profile) {
  try { return registrationCount(fs.readFileSync(profileFile(profile), 'utf8')) === 1; } catch { return false; }
}
export function updateRegistration(text, entry) {
  const doc = parsePatch(text);
  visit(doc, { Map(_key, node) { if (node.get('id') === 'mcp-qqbot') return visit.REMOVE; } });
  // Remove empty insert operations left by deleting a managed entry.
  doc.contents.items = doc.contents.items.filter(n => !(isMap(n) && isSeq(n.get('insert', true)) && n.get('insert', true).items.length === 0));
  if (entry) doc.contents.add(doc.createNode({ insert: [entry] }));
  return doc.toString();
}
export function registerMarket({ profile = 'desktop', remove = false, node = process.execPath, script, file = profileFile(profile) }) {
  if (!fs.existsSync(path.dirname(file))) throw new Error('DSH profile does not exist: ' + profile);
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]';
  const entry = remove ? null : { id: 'mcp-qqbot', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'qqbot', transport: 'stdio', command: node, args: [script], toolCallTimeoutMs: 725000 } };
  const next = updateRegistration(old, entry);
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.' + Date.now() + '.bak');
  fs.writeFileSync(file, next);
  return { file, count: registrationCount(next) };
}
