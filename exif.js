/* Reads Fujifilm in-camera settings from a JPEG's EXIF maker note.
   readFujiSettings(arrayBuffer) -> { make, model, settings, raw } | null
   Tag maps follow ExifTool's Image::ExifTool::FujiFilm. */
(function (global) {
  'use strict';

  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 };

  function readIFD(view, base, offset, le, limit) {
    const entries = new Map();
    if (offset + 2 > view.byteLength) return entries;
    const n = view.getUint16(offset, le);
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > view.byteLength) break;
      const tag = view.getUint16(e, le), type = view.getUint16(e + 2, le), count = view.getUint32(e + 4, le);
      const size = (TYPE_SIZE[type] || 1) * count;
      const valPos = size <= 4 ? e + 8 : base + view.getUint32(e + 8, le);
      entries.set(tag, { type, count, valPos, inlinePos: e + 8 });
    }
    return entries;
  }

  function readValues(view, ent, le) {
    const { type, count, valPos } = ent;
    const out = [];
    const sz = TYPE_SIZE[type] || 1;
    if (valPos + sz * count > view.byteLength) return out;
    for (let i = 0; i < count; i++) {
      const p = valPos + i * sz;
      switch (type) {
        case 1: case 7: out.push(view.getUint8(p)); break;
        case 2: out.push(String.fromCharCode(view.getUint8(p))); break;
        case 3: out.push(view.getUint16(p, le)); break;
        case 4: out.push(view.getUint32(p, le)); break;
        case 5: out.push(view.getUint32(p, le) / (view.getUint32(p + 4, le) || 1)); break;
        case 6: out.push(view.getInt8(p)); break;
        case 8: out.push(view.getInt16(p, le)); break;
        case 9: out.push(view.getInt32(p, le)); break;
        case 10: out.push(view.getInt32(p, le) / (view.getInt32(p + 4, le) || 1)); break;
        default: out.push(view.getUint8(p));
      }
    }
    return out;
  }
  const str = (view, ent, le) => readValues(view, ent, le).join('').replace(/\0+$/, '').trim();

  function findExifSegment(view) {
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return -1;
    let p = 2;
    while (p + 4 <= view.byteLength) {
      if (view.getUint8(p) !== 0xff) return -1;
      const marker = view.getUint8(p + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      const len = view.getUint16(p + 2);
      if (marker === 0xe1 && p + 10 <= view.byteLength && view.getUint32(p + 4) === 0x45786966) return p + 10; // "Exif"
      if (marker === 0xda) return -1; // start of scan, no EXIF
      p += 2 + len;
    }
    return -1;
  }

  // ---- value maps (ExifTool FujiFilm.pm) ----
  const FILM_MODE = { 0x000: 'PROVIA / Standard', 0x120: 'ASTIA / Soft', 0x200: 'Velvia / Vivid', 0x400: 'Velvia / Vivid', 0x500: 'PRO Neg. Std', 0x501: 'PRO Neg. Hi', 0x600: 'Classic Chrome', 0x700: 'ETERNA / Cinema', 0x800: 'Classic Neg.', 0x900: 'ETERNA Bleach Bypass', 0xa00: 'Nostalgic Neg.', 0xb00: 'REALA ACE' };
  const SATURATION = { 0x0: 0, 0x80: 1, 0x100: 2, 0xc0: 3, 0xe0: 4, 0x180: -1, 0x200: -2, 0x400: -2, 0x4c0: -3, 0x4e0: -4 };
  const MONO_SAT = { 0x300: 'Monochrome', 0x301: 'Monochrome', 0x302: 'Monochrome', 0x303: 'Monochrome', 0x310: 'Sepia', 0x500: 'ACROS', 0x501: 'ACROS', 0x502: 'ACROS', 0x503: 'ACROS' };
  const MONO_FILTER = { 0x301: 'R', 0x302: 'Ye', 0x303: 'G', 0x501: 'R', 0x502: 'Ye', 0x503: 'G' };
  const SHARPNESS = { 0x00: -4, 0x01: -3, 0x02: -2, 0x03: 0, 0x04: 2, 0x05: 3, 0x06: 4, 0x82: -1, 0x84: 1 };
  const NOISE_RED = { 0x000: 0, 0x100: 2, 0x180: 1, 0x1c0: 3, 0x1e0: 4, 0x200: -2, 0x280: -1, 0x2c0: -3, 0x2e0: -4 };
  const WB = { 0x0: 'Auto', 0x1: 'Auto (White Priority)', 0x2: 'Auto (Ambience Priority)', 0x100: 'Daylight', 0x200: 'Shade', 0x300: 'Fluorescent 1', 0x301: 'Fluorescent 2', 0x302: 'Fluorescent 3', 0x400: 'Incandescent', 0x500: 'Flash', 0x600: 'Underwater', 0xf00: 'Custom', 0xf01: 'Custom', 0xf02: 'Custom', 0xf03: 'Custom', 0xf04: 'Custom' };
  const TRI = { 0: 'Off', 32: 'Weak', 64: 'Strong' };
  const GRAIN_SIZE = { 0: '—', 16: 'Small', 32: 'Large' };
  const DR_SETTING = { 0x000: 'Auto', 0x100: 'DR100', 0x200: 'DR200', 0x201: 'DR400' };

  function readFujiSettings(buffer) {
    const view = new DataView(buffer);
    const tiff = findExifSegment(view);
    if (tiff < 0 || tiff + 8 > view.byteLength) return null;
    const le = view.getUint16(tiff) === 0x4949;
    if (view.getUint16(tiff + 2, le) !== 0x2a) return null;
    const ifd0 = readIFD(view, tiff, tiff + view.getUint32(tiff + 4, le), le);
    const make = ifd0.has(0x010f) ? str(view, ifd0.get(0x010f), le) : '';
    const model = ifd0.has(0x0110) ? str(view, ifd0.get(0x0110), le) : '';
    if (!ifd0.has(0x8769)) return null;
    const exif = readIFD(view, tiff, tiff + readValues(view, ifd0.get(0x8769), le)[0], le);
    const exposureComp = exif.has(0x9204) ? readValues(view, exif.get(0x9204), le)[0] : null;
    const mn = exif.get(0x927c);
    if (!mn) return null;
    const base = mn.valPos;
    if (base + 12 > view.byteLength) return null;
    let sig = ''; for (let i = 0; i < 8; i++) sig += String.fromCharCode(view.getUint8(base + i));
    if (sig !== 'FUJIFILM') return null;
    const fuji = readIFD(view, base, base + view.getUint32(base + 8, true), true);
    const get = (tag) => fuji.has(tag) ? readValues(view, fuji.get(tag), true) : null;
    const first = (tag) => { const v = get(tag); return v && v.length ? v[0] : undefined; };
    const int8At = (tag) => fuji.has(tag) ? view.getInt8(fuji.get(tag).inlinePos) : undefined;

    const raw = {};
    for (const [tag, ent] of fuji) raw['0x' + tag.toString(16)] = readValues(view, ent, true).slice(0, 4);

    const s = {};
    const filmMode = first(0x1401), sat = first(0x1003);
    if (sat !== undefined && MONO_SAT[sat]) {
      s.filmSim = MONO_SAT[sat];
      if (MONO_FILTER[sat]) s.monoFilter = MONO_FILTER[sat];
    } else if (filmMode !== undefined && FILM_MODE[filmMode]) s.filmSim = FILM_MODE[filmMode];
    if (sat !== undefined && SATURATION[sat] !== undefined) s.color = SATURATION[sat];
    const sh = first(0x1001); if (sh !== undefined && SHARPNESS[sh] !== undefined) s.sharpness = SHARPNESS[sh];
    const nr = first(0x100e); if (nr !== undefined && NOISE_RED[nr] !== undefined) s.noiseReduction = NOISE_RED[nr];
    const cl = first(0x100f); if (cl !== undefined) s.clarity = Math.round(cl / 1000);
    const ht = first(0x1041); if (ht !== undefined) s.highlight = -ht / 16;
    const st = first(0x1040); if (st !== undefined) s.shadow = -st / 16;
    const gr = first(0x1047), gs = first(0x104c);
    if (gr !== undefined) s.grain = { roughness: TRI[gr] || 'Off', size: (TRI[gr] || 'Off') === 'Off' ? '—' : (GRAIN_SIZE[gs] || 'Small') };
    const cce = first(0x1048); if (cce !== undefined) s.colorChrome = TRI[cce] || 'Off';
    const ccb = first(0x104e); if (ccb !== undefined) s.colorChromeBlue = TRI[ccb] || 'Off';
    const wb = first(0x1002);
    if (wb !== undefined) {
      if (wb === 0xff0) { const k = first(0x1005); s.wbMode = k ? `Kelvin ${k}K` : 'Kelvin 5500K'; }
      else if (WB[wb]) s.wbMode = WB[wb];
    }
    const assumed = [];
    const ft = get(0x100a);
    if (ft && ft.length >= 2) s.wbShift = { r: Math.round(ft[0] / 20), b: Math.round(ft[1] / 20) };
    else { s.wbShift = { r: 0, b: 0 }; assumed.push('WB shift'); }
    if (s.noiseReduction === undefined) { const legacy = first(0x100b); if (legacy === 0x80) s.noiseReduction = 0; else if (legacy === 0x40) s.noiseReduction = -2; if (legacy !== undefined) assumed.push('High ISO NR'); }
    const wc = int8At(0x1049), mg = int8At(0x104b);
    if (wc !== undefined || mg !== undefined) s.monoColor = { wc: wc || 0, mg: mg || 0 };
    const drs = first(0x1402), drd = first(0x1403);
    if (drs === 0) s.dynamicRange = 'Auto';
    else if (drd && [100, 200, 400].includes(drd)) s.dynamicRange = 'DR' + drd;
    else if (drs !== undefined && DR_SETTING[drs]) s.dynamicRange = DR_SETTING[drs];
    if (exposureComp !== null && Number.isFinite(exposureComp)) s.exposureComp = Math.round(exposureComp * 3) / 3;

    if (Object.keys(s).length === 0) return null;
    return { make, model, settings: s, assumed, raw };
  }

  const api = { readFujiSettings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.XT50Exif = api;
})(typeof window !== 'undefined' ? window : null);
