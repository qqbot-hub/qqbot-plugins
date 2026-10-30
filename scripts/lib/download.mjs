import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export async function downloadVerified(url, target, { sha256, maxBytes = 200 * 1024 * 1024 } = {}) {
  if (!/^https:\/\//.test(url) || !/^[a-f0-9]{64}$/i.test(sha256 || '')) throw new Error('HTTPS URL and release SHA256 are required');
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error('Download failed: HTTP ' + response.status);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.partial'; let size = 0; const hash = crypto.createHash('sha256');
  const fd = fs.openSync(tmp, 'w');
  try {
    for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) throw new Error('Download exceeds size limit'); hash.update(chunk); fs.writeSync(fd, chunk); }
  } catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); throw e; }
  fs.closeSync(fd);
  if (hash.digest('hex').toLowerCase() !== sha256.toLowerCase()) { fs.rmSync(tmp, { force: true }); throw new Error('Release checksum mismatch'); }
  fs.renameSync(tmp, target); return { size };
}
export async function extractVerified(ctx, archive, target) {
  const listing = await ctx.exec('tar', ['-tf', archive], { quiet: true, timeoutMs: 30000 });
  if (listing.code !== 0) throw new Error('Cannot inspect archive');
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.some(name => /(^[\\/]|:|(^|[\\/])\.\.([\\/]|$))/i.test(name) || name.split(/[\\/]/).some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part)))) throw new Error('Unsafe archive paths');
  const verbose = await ctx.exec('tar', ['-tvf', archive], { quiet: true, timeoutMs: 30000 });
  if (verbose.code !== 0 || verbose.stdout.split(/\r?\n/).some(line => /^[lh]/.test(line))) throw new Error('Archive links are not allowed');
  fs.mkdirSync(target, { recursive: true });
  const result = await ctx.exec('tar', ['-xf', archive, '-C', target], { quiet: true, timeoutMs: 120000 });
  if (result.code !== 0) throw new Error('Extraction failed');
}
