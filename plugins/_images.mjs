/* _images —— 图片字节的纯解析工具（不联网、不写盘）
 *
 * 三个插件都要判断「这串东西到底是不是图、多大、什么格式」：
 *   vision  识图前确认拿到的是真图片，别把一段 HTML 错误页交给模型
 *   sticker 收藏表情包时校验格式与体积，顺手记下尺寸
 *   video   封面图取回后先看一眼是不是图
 *
 * 只看文件头，不做解码——解码要引入依赖，这个项目是零依赖的。
 * 认不出的格式一律返回空串，让调用方自己决定怎么办，不猜。
 */
'use strict';

/** 从字节里认出图片格式；认不出返回空串 */
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  /* QQ 有些表情是 APNG，头就是 PNG，上面已覆盖 */
  return '';
}

/** 读宽高（PNG / GIF / JPEG / WebP / BMP）；读不出返回 null */
export function sniffSize(buf) {
  const mime = sniffMime(buf);
  try {
    if (mime === 'image/png') {
      /* IHDR 固定在第 16~23 字节：宽 4 字节、高 4 字节，都是大端 */
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/bmp') {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (mime === 'image/webp') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fourcc === 'VP8X') {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width: w, height: h };
      }
      return null;
    }
    if (mime === 'image/jpeg') {
      /* JPEG 要一截一截找 SOF 段，尺寸只在那里 */
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSOF) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
  } catch { /* 文件头被截断，就当读不出 */ }
  return null;
}

/** 尺寸给人看：320×240 */
export function sizeLabel(buf) {
  const s = sniffSize(buf);
  return s && s.width && s.height ? `${s.width}×${s.height}` : '';
}

/** 把工具参数里各种写法的图片统一成 { kind, value }：
 *    data:image/png;base64,xxx  → { kind:'dataurl' }
 *    base64://xxx / 裸 base64   → { kind:'base64', mime }
 *    http(s)://…                → { kind:'url' }
 *    1A2B3C.image 这种 file 名   → { kind:'file' }
 *  空串返回 null。 */
export function parseImageInput(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  /* 任何 data:...;base64, 都算 data URL —— 包括 data:text/plain 这种「自称不是图片的」。
   * 以前只认 data:image/*，其它 data: 会掉到下面的 file 分支，报「这像是 OneBot 的 file 值」，
   * 把一句明显的错误说成了另一件事。这里先认出来，交给调用方去 sniff 里子。 */
  if (/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(s)) return { kind: 'dataurl', value: s };
  if (/^base64:\/\//i.test(s)) {
    const b = s.replace(/^base64:\/\//i, '').replace(/\s+/g, '');
    const buf = Buffer.from(b, 'base64');
    return { kind: 'base64', value: b, mime: sniffMime(buf) };
  }
  if (/^https?:\/\//i.test(s)) return { kind: 'url', value: s };
  /* 裸 base64：够长、只有 base64 字符、能解出图片头，才算 */
  if (s.length >= 64 && /^[A-Za-z0-9+/=\r\n]+$/.test(s)) {
    const b = s.replace(/\s+/g, '');
    const buf = Buffer.from(b, 'base64');
    if (sniffMime(buf)) return { kind: 'base64', value: b, mime: sniffMime(buf) };
  }
  return { kind: 'file', value: s };
}

/** base64 → data URL（交给多模态接口用） */
export function toDataUrl(b64, mime) {
  const buf = Buffer.from(String(b64), 'base64');
  const m = mime || sniffMime(buf) || 'image/png';
  return `data:${m};base64,${buf.toString('base64')}`;
}
