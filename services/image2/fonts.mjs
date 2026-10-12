/** CSS weight must describe the actual registered face, never a synthetic UI request. */
export function fontWeight(face) {
  const value = Number(face['OS/2']?.usWeightClass);
  return Number.isFinite(value) && value >= 1 && value <= 1000 ? Math.round(value) : 400;
}

/** PDFKit cannot subset transformed WOFF2 glyf/loca tables directly. */
export async function pdfFontBytes(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'wOF2') return bytes;
  const declared = bytes.length >= 48 ? bytes.readUInt32BE(16) : 0;
  if (!declared || declared > 64 * 1024 * 1024) throw Object.assign(new Error('字体展开尺寸超过64MB或WOFF2头部无效'), { status:422, code:'invalid_font_asset' });
  let decoded;
  try {
    const { default: decompress } = await import('wawoff2/decompress.js');
    decoded = Buffer.from(await decompress(bytes));
  } catch { throw Object.assign(new Error('WOFF2字体无法展开为PDF字体'), { status:422, code:'invalid_font_asset' }); }
  if (decoded.length < 4 || decoded.length > 64 * 1024 * 1024 || ![0x00010000,0x4f54544f,0x74727565].includes(decoded.readUInt32BE(0))) throw Object.assign(new Error('WOFF2展开结果无效'), { status:422, code:'invalid_font_asset' });
  return decoded;
}
