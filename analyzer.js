/* X-T50 recipe engine: pure functions, no DOM state.
   analyzeImage(bitmap) -> stats
   recommend(stats)     -> recipe
*/
(function (global) {
  'use strict';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v) => Math.round(v);
  const roundHalf = (v) => Math.round(v * 2) / 2;
  const roundThird = (v) => Math.round(v * 3) / 3;

  // ---------- color helpers ----------
  function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 1e-6) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max > 1e-6 ? d / max : 0;
    return [h, s, max];
  }
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const i = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  // ---------- image sampling ----------
  function drawScaled(bitmap, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function drawCenterCrop(bitmap, size) {
    const w = Math.min(size, bitmap.width), h = Math.min(size, bitmap.height);
    const sx = Math.floor((bitmap.width - w) / 2), sy = Math.floor((bitmap.height - h) / 2);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, sx, sy, w, h, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function toGray(img) {
    const { width: w, height: h, data } = img;
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      g[j] = luma(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
    }
    return { w, h, g };
  }

  function boxBlur(src, w, h, r) {
    // separable box blur, edge-clamped
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[y * w + clamp(k, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / n;
        const addX = clamp(x + r + 1, 0, w - 1), subX = clamp(x - r, 0, w - 1);
        acc += src[y * w + addX] - src[y * w + subX];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / n;
        const addY = clamp(y + r + 1, 0, h - 1), subY = clamp(y - r, 0, h - 1);
        acc += tmp[addY * w + x] - tmp[subY * w + x];
      }
    }
    return out;
  }

  // ---------- palette ----------
  function extractPalette(img, count) {
    const { data } = img;
    const levels = 8, bins = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r * levels / 256) | 0) * levels * levels + ((g * levels / 256) | 0) * levels + ((b * levels / 256) | 0);
      let e = bins.get(key);
      if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; bins.set(key, e); }
      e.n++; e.r += r; e.g += g; e.b += b;
    }
    const sorted = [...bins.values()].sort((a, b) => b.n - a.n)
      .map(e => ({ n: e.n, r: e.r / e.n, g: e.g / e.n, b: e.b / e.n }));
    const total = data.length / 4;
    const picked = [];
    for (const c of sorted) {
      if (picked.length >= count) break;
      const far = picked.every(p => Math.hypot(p.r - c.r, p.g - c.g, p.b - c.b) > 48);
      if (far) picked.push({ ...c, share: c.n / total });
    }
    return picked.map(p => ({
      hex: '#' + [p.r, p.g, p.b].map(v => round(v).toString(16).padStart(2, '0')).join(''),
      share: p.share,
    }));
  }

  // ---------- main analysis ----------
  function analyzeImage(bitmap) {
    const small = drawScaled(bitmap, 360);
    const { width: w, height: h, data } = small;
    const N = w * h;

    const Y = new Float32Array(N);
    const hist = new Uint32Array(256);
    const rHist = new Uint32Array(256), gHist = new Uint32Array(256), bHist = new Uint32Array(256);
    let satSum = 0, satN = 0, colorfulN = 0;
    let rgSum = 0, ybSum = 0, rgSq = 0, ybSq = 0;
    const hueBins = new Float32Array(24); // 15 degrees each, weighted by saturation
    let blueN = 0, blueHueSum = 0, greenN = 0, greenHueSum = 0, skinN = 0, warmN = 0;

    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const y = luma(r, g, b);
      Y[j] = y;
      hist[(y * 255) | 0]++; rHist[data[i]]++; gHist[data[i + 1]]++; bHist[data[i + 2]]++;
      const [hh, s, v] = rgbToHsv(r, g, b);
      if (v > 0.08 && v < 0.98) { satSum += s; satN++; }
      if (s > 0.5 && v > 0.2) colorfulN++;
      const rg = r - g, yb = 0.5 * (r + g) - b;
      rgSum += rg; ybSum += yb; rgSq += rg * rg; ybSq += yb * yb;
      if (s > 0.12 && v > 0.1) {
        hueBins[(hh / 15) | 0] += s;
        if (hh >= 185 && hh <= 265) { blueN++; blueHueSum += hh; }
        if (hh >= 65 && hh <= 165) { greenN++; greenHueSum += hh; }
        if (hh >= 5 && hh <= 45) { warmN++; if (s >= 0.2 && s <= 0.65 && v >= 0.3 && v <= 0.95) skinN++; }
      }
    }

    const sortedY = Float32Array.from(Y).sort();
    const p = (q) => percentile(sortedY, q);
    const meanY = sortedY.reduce((a, v) => a + v, 0) / N;
    let varY = 0; for (let i = 0; i < N; i++) varY += (Y[i] - meanY) ** 2;
    const stdY = Math.sqrt(varY / N);

    const P = { p1: p(0.01), p5: p(0.05), p25: p(0.25), p50: p(0.5), p75: p(0.75), p95: p(0.95), p99: p(0.99) };
    let clipHi = 0, clipLo = 0;
    for (let i = 0; i < N; i++) { if (Y[i] > 0.98) clipHi++; if (Y[i] < 0.02) clipLo++; }
    clipHi /= N; clipLo /= N;

    // zone casts: warmth = (r-b)/luma, tint = (g - (r+b)/2)/luma
    // Toning is measured on the less-saturated pixels of each zone so that strongly
    // coloured subjects (a blue carpet, a red wall) do not read as split toning.
    const mk = () => ({ all: [0, 0, 0], low: [0, 0, 0] });
    const zone = { sh: mk(), mid: mk(), hi: mk(), neu: [0, 0, 0] };
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const y = Y[j]; if (y < 0.03 || y > 0.97) continue;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const wv = (r - b) / y, tv = (g - (r + b) / 2) / y;
      const s = rgbToHsv(r, g, b)[1];
      let z = null;
      if (y < P.p25) z = zone.sh; else if (y > P.p75) z = zone.hi; else if (y > P.p25 + (P.p75 - P.p25) * 0.3 && y < P.p75 - (P.p75 - P.p25) * 0.3) z = zone.mid;
      if (z) {
        z.all[0] += wv; z.all[1] += tv; z.all[2]++;
        if (s < 0.35) { z.low[0] += wv; z.low[1] += tv; z.low[2]++; }
      }
      if (s < 0.18 && y > 0.12 && y < 0.9) { zone.neu[0] += wv; zone.neu[1] += tv; zone.neu[2]++; }
    }
    const avg = (z) => z[2] > 0 ? { warm: z[0] / z[2], tint: z[1] / z[2], n: z[2] } : { warm: 0, tint: 0, n: 0 };
    const pick = (z) => avg(z.low[2] > N * 0.02 ? z.low : z.all);
    const sh = pick(zone.sh), mid = pick(zone.mid), hi = pick(zone.hi), neu = avg(zone.neu);
    // global cast: prefer near-neutral pixels, fall back to midtone gray-world with damping
    const neuFrac = neu.n / N;
    const neuW = clamp(neuFrac / 0.15, 0, 1);
    const cast = {
      warm: neuW * neu.warm + (1 - neuW) * mid.warm * 0.6,
      tint: neuW * neu.tint + (1 - neuW) * mid.tint * 0.6,
      fromNeutrals: neuW,
    };

    const meanSat = satN ? satSum / satN : 0;
    const colorful = Math.sqrt(rgSq / N - (rgSum / N) ** 2 + ybSq / N - (ybSum / N) ** 2)
      + 0.3 * Math.hypot(rgSum / N, ybSum / N);

    // clarity: mid-frequency local contrast on the downscaled gray
    const gray = toGray(small);
    const b9 = boxBlur(gray.g, w, h, 4);
    let lc = 0, lcN = 0;
    for (let i = 0; i < N; i++) { if (gray.g[i] > 0.05 && gray.g[i] < 0.95) { lc += Math.abs(gray.g[i] - b9[i]); lcN++; } }
    const localContrast = lcN ? lc / lcN : 0;

    // grain + sharpness from a native-resolution center crop
    const crop = drawCenterCrop(bitmap, 640);
    const cg = toGray(crop);
    const cw = cg.w, ch = cg.h;
    const b1 = boxBlur(cg.g, cw, ch, 1), b3 = boxBlur(cg.g, cw, ch, 3);
    // gradient of the blurred image tells us where edges are
    const gradMag = new Float32Array(cw * ch);
    for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) {
      const i = y * cw + x;
      gradMag[i] = Math.hypot(b1[i + 1] - b1[i - 1], b1[i + cw] - b1[i - cw]);
    }
    let fineSum = 0, fineN = 0, coarseSum = 0;
    for (let i = 0; i < cw * ch; i++) {
      if (gradMag[i] < 0.01 && cg.g[i] > 0.08 && cg.g[i] < 0.92) {
        fineSum += (cg.g[i] - b1[i]) ** 2; coarseSum += (b1[i] - b3[i]) ** 2; fineN++;
      }
    }
    const noiseFine = fineN > 200 ? Math.sqrt(fineSum / fineN) : 0;
    const noiseCoarse = fineN > 200 ? Math.sqrt(coarseSum / fineN) : 0;
    const grainSizeRatio = noiseFine > 1e-5 ? noiseCoarse / noiseFine : 0;

    // sharpness: how steep are the strongest edges relative to a blurred version
    const rawGrad = new Float32Array(cw * ch);
    for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) {
      const i = y * cw + x;
      rawGrad[i] = Math.hypot(cg.g[i + 1] - cg.g[i - 1], cg.g[i + cw] - cg.g[i - cw]);
    }
    const gSorted = Float32Array.from(rawGrad).sort();
    const gTop = percentile(gSorted, 0.97);
    let acut = 0, acutN = 0;
    for (let i = 0; i < cw * ch; i++) if (rawGrad[i] >= gTop && gradMag[i] > 1e-4) { acut += rawGrad[i] / (gradMag[i] + 1e-4); acutN++; }
    const acutance = acutN ? acut / acutN : 1; // ~1 soft, >1.6 crisp

    const palette = extractPalette(small, 7);
    const hueTotal = hueBins.reduce((a, v) => a + v, 0) || 1;

    return {
      width: bitmap.width, height: bitmap.height,
      meanY, stdY, ...P, clipHi, clipLo,
      meanSat, colorful, colorfulFrac: colorfulN / N,
      sh, mid, hi, neu, cast,
      blueFrac: blueN / N, blueHue: blueN ? blueHueSum / blueN : 0,
      greenFrac: greenN / N, greenHue: greenN ? greenHueSum / greenN : 0,
      skinFrac: skinN / N, warmFrac: warmN / N,
      hueBins: Array.from(hueBins, v => v / hueTotal),
      localContrast, noiseFine, noiseCoarse, grainSizeRatio, acutance,
      hist: Array.from(hist), rHist: Array.from(rHist), gHist: Array.from(gHist), bHist: Array.from(bHist),
      palette,
    };
  }

  // ---------- film simulation library ----------
  // sat / con on 0..1 where 0.5 is "normal"; tints are relative to the image's own white balance
  const FILM_SIMS = [
    { id: 'PROVIA', name: 'PROVIA / Standard', sat: 0.50, con: 0.50, shWarm: 0.00, hiWarm: 0.00, fade: 0.10, onDial: true, desc: 'Neutral, all-purpose colour and contrast.' },
    { id: 'VELVIA', name: 'Velvia / Vivid', sat: 0.82, con: 0.70, shWarm: 0.00, hiWarm: 0.00, fade: 0.00, onDial: true, desc: 'Punchy saturation and deep shadows.' },
    { id: 'ASTIA', name: 'ASTIA / Soft', sat: 0.56, con: 0.40, shWarm: 0.05, hiWarm: 0.10, fade: 0.15, onDial: true, desc: 'Soft tonality, gentle skin, slightly lifted colour.' },
    { id: 'CLASSIC_CHROME', name: 'Classic Chrome', sat: 0.32, con: 0.60, shWarm: -0.35, hiWarm: 0.05, fade: 0.20, onDial: true, desc: 'Muted, documentary look: cool shadows, hard midtones.' },
    { id: 'REALA_ACE', name: 'REALA ACE', sat: 0.50, con: 0.58, shWarm: 0.00, hiWarm: 0.00, fade: 0.05, onDial: true, desc: 'Faithful colour with hard tonality.' },
    { id: 'PRO_NEG_HI', name: 'PRO Neg. Hi', sat: 0.45, con: 0.52, shWarm: 0.05, hiWarm: 0.10, fade: 0.20, onDial: false, desc: 'Portrait film: slightly punchy, smooth skin.' },
    { id: 'PRO_NEG_STD', name: 'PRO Neg. Std', sat: 0.35, con: 0.35, shWarm: 0.05, hiWarm: 0.10, fade: 0.35, onDial: false, desc: 'Flat and low-saturation, studio portrait.' },
    { id: 'CLASSIC_NEG', name: 'Classic Neg.', sat: 0.40, con: 0.68, shWarm: -0.25, hiWarm: 0.35, fade: 0.25, onDial: true, desc: 'Hard tonality, cyan shadows, warm highlights, strong hue shifts.' },
    { id: 'NOSTALGIC_NEG', name: 'Nostalgic Neg.', sat: 0.48, con: 0.45, shWarm: 0.15, hiWarm: 0.50, fade: 0.30, onDial: true, desc: 'Amber highlights and rich warm shadows, 1970s print look.' },
    { id: 'ETERNA', name: 'ETERNA / Cinema', sat: 0.22, con: 0.30, shWarm: -0.10, hiWarm: 0.05, fade: 0.45, onDial: false, desc: 'Flat, desaturated, cinematic.' },
    { id: 'ETERNA_BB', name: 'ETERNA Bleach Bypass', sat: 0.15, con: 0.75, shWarm: -0.10, hiWarm: 0.00, fade: 0.05, onDial: false, desc: 'Desaturated yet high-contrast.' },
    { id: 'ACROS', name: 'ACROS', mono: true, onDial: true, con: 0.62, desc: 'Rich monochrome with fine grain and deep tones.' },
    { id: 'MONOCHROME', name: 'Monochrome', mono: true, onDial: false, con: 0.50, desc: 'Straight black and white.' },
  ];

  // ---------- recommendation ----------
  function recommend(s) {
    const R = { settings: {}, reasons: {}, notes: [], alternatives: [] };

    // normalized image features
    const imgSat = clamp(s.meanSat / 0.65, 0, 1);
    const imgCon = clamp(0.5 * (s.stdY / 0.40) + 0.5 * ((s.p95 - s.p5) / 1.6), 0, 1);
    const shadowLift = clamp(s.p1 / 0.2, 0, 1);
    const hiComp = clamp((1 - s.p99) / 0.25, 0, 1);
    const imgFade = clamp(0.6 * shadowLift + 0.4 * hiComp, 0, 1);
    const shWarmRel = clamp((s.sh.warm - s.mid.warm) / 0.6, -1, 1);
    const hiWarmRel = clamp((s.hi.warm - s.mid.warm) / 0.6, -1, 1);
    const isMono = s.meanSat < 0.045;

    R.features = { imgSat, imgCon, shadowLift, hiComp, imgFade, shWarmRel, hiWarmRel, isMono };

    // score film sims
    const scored = FILM_SIMS.filter(f => !!f.mono === isMono).map(f => {
      let d;
      if (f.mono) {
        d = Math.abs(imgCon - f.con) * 1.5;
      } else {
        d = 2.0 * Math.abs(imgSat - f.sat)
          + 1.2 * Math.abs(imgCon - f.con)
          + 0.6 * Math.abs(shWarmRel - f.shWarm)
          + 0.6 * Math.abs(hiWarmRel - f.hiWarm)
          + 0.8 * Math.abs(imgFade - f.fade);
        // hue-character nudges
        if (s.blueFrac > 0.04 && s.blueHue < 208 && ['CLASSIC_CHROME', 'CLASSIC_NEG', 'ETERNA'].includes(f.id)) d -= 0.08;
        if (s.greenFrac > 0.04 && s.greenHue < 95 && ['CLASSIC_NEG', 'NOSTALGIC_NEG'].includes(f.id)) d -= 0.08;
        if (s.skinFrac > 0.12 && ['ASTIA', 'PRO_NEG_HI', 'PRO_NEG_STD'].includes(f.id)) d -= 0.06;
        if (s.colorfulFrac > 0.25 && f.id === 'VELVIA') d -= 0.06;
      }
      return { sim: f, d };
    }).sort((a, b) => a.d - b.d);

    R.scores = scored.map(x => ({ id: x.sim.id, d: +x.d.toFixed(3) }));
    const best = scored[0].sim;
    const conf = clamp(1 - scored[0].d / 1.4, 0.15, 0.97);
    R.filmSim = best;
    R.confidence = conf;
    R.alternatives = scored.slice(1, 4).map(x => ({ sim: x.sim, fit: clamp(1 - x.d / 1.4, 0.05, 0.97) }));

    const set = (key, value, reason) => { R.settings[key] = value; R.reasons[key] = reason; };

    set('filmSim', best.name, `${best.desc} Fit ${Math.round(conf * 100)}%.`);

    // --- tone curve ---
    const conDelta = (imgCon - (best.mono ? best.con : best.con)) * 3;
    let hTone = s.clipHi * 45 - hiComp * 2.6 + conDelta * 0.6;
    let sTone = s.clipLo * 45 - shadowLift * 2.8 + conDelta * 0.6;
    hTone = clamp(roundHalf(hTone), -2, 4);
    sTone = clamp(roundHalf(sTone), -2, 4);
    set('highlight', hTone,
      hiComp > 0.35 ? `Brightest 1% sits at ${Math.round(s.p99 * 100)}%: highlights are rolled off, so soften the curve.`
        : s.clipHi > 0.02 ? `${(s.clipHi * 100).toFixed(1)}% of pixels are clipped white: highlights are hard.`
          : 'Highlights are near the film simulation default.');
    set('shadow', sTone,
      shadowLift > 0.4 ? `Darkest 1% sits at ${Math.round(s.p1 * 100)}%: shadows are lifted and faded.`
        : s.clipLo > 0.02 ? `${(s.clipLo * 100).toFixed(1)}% of pixels are crushed black: shadows are deep.`
          : 'Shadows are near the film simulation default.');

    // --- colour ---
    if (!best.mono) {
      const color = clamp(round((imgSat - best.sat) * 10), -4, 4);
      set('color', color, `Mean saturation ${Math.round(s.meanSat * 100)}% vs ${best.name} baseline.`);
    } else {
      set('color', 0, 'Not used for monochrome simulations.');
    }

    // --- white balance ---
    const wv = s.cast.warm, tv = s.cast.tint;
    let wbR = clamp(round(wv * 28 - tv * 28), -9, 9);
    let wbB = clamp(round(-wv * 28 - tv * 28), -9, 9);
    let wbMode;
    if (wbR >= 6) { wbMode = 'Shade'; wbR -= 3; wbB += 2; }
    else if (wv > 0.045) wbMode = 'Daylight';
    else if (wv < -0.05) wbMode = 'Kelvin 4300K';
    else wbMode = 'Auto (White Priority)';
    set('wbMode', wbMode, s.cast.fromNeutrals > 0.5
      ? 'Cast measured from near-neutral pixels in the image.'
      : 'Few neutral pixels: cast estimated from midtones and damped.');
    set('wbShift', { r: wbR, b: wbB },
      `${wv > 0.02 ? 'Warm' : wv < -0.02 ? 'Cool' : 'Neutral'} cast (${(wv * 100).toFixed(0)}), ${tv > 0.015 ? 'green' : tv < -0.015 ? 'magenta' : 'no'} tint.`);

    // --- dynamic range ---
    const dr = hiComp > 0.35 && s.clipHi < 0.01 ? 'DR400' : hiComp > 0.12 || s.clipHi < 0.003 ? 'DR200' : 'DR100';
    set('dynamicRange', dr, dr === 'DR100' ? 'Highlights are hard, keep the native curve.' : 'Highlights hold detail; DR extends the highlight rolloff.');
    if (dr === 'DR200') R.notes.push('DR200 needs ISO 250 or higher on the X-T50.');
    if (dr === 'DR400') R.notes.push('DR400 needs ISO 500 or higher on the X-T50.');

    // --- grain ---
    const nf = s.noiseFine;
    let grainRough = nf < 0.011 ? 'Off' : nf < 0.024 ? 'Weak' : 'Strong';
    let grainSize = s.grainSizeRatio > 0.72 ? 'Large' : 'Small';
    if (grainRough === 'Off') grainSize = '—';
    set('grain', { roughness: grainRough, size: grainSize },
      `Noise in flat areas: ${(nf * 100).toFixed(1)}% (${grainRough === 'Off' ? 'clean' : grainRough === 'Weak' ? 'lightly textured' : 'clearly grainy'}).`);

    // --- colour chrome effects ---
    if (!best.mono) {
      const cce = s.colorfulFrac > 0.18 && imgSat > 0.55 ? 'Strong' : s.colorfulFrac > 0.06 ? 'Weak' : 'Off';
      set('colorChrome', cce, `${Math.round(s.colorfulFrac * 100)}% of pixels are strongly saturated.`);
      const ccb = s.blueFrac > 0.14 ? 'Strong' : s.blueFrac > 0.05 ? 'Weak' : 'Off';
      set('colorChromeBlue', ccb, `${Math.round(s.blueFrac * 100)}% of pixels are blue-leaning.`);
    } else {
      set('colorChrome', 'Off', 'Not used for monochrome.');
      set('colorChromeBlue', 'Off', 'Not used for monochrome.');
    }

    // --- monochrome toning ---
    if (best.mono) {
      const wc = clamp(round(wv * 60), -18, 18);
      const mg = clamp(round(tv * 60), -18, 18);
      set('monoColor', { wc, mg }, `Warm/cool ${wc} (positive is warm), magenta/green ${mg} (positive is green), from the image tint.`);
      if (best.id === 'ACROS') R.notes.push('ACROS filters: try +Ye for lighter skin, +R for darker skies, +G for lighter foliage.');
    }

    // --- clarity ---
    const clarity = clamp(round((s.localContrast - 0.046) / 0.011), -5, 5);
    set('clarity', clarity, `Mid-frequency local contrast ${(s.localContrast * 100).toFixed(1)}%.`);
    if (clarity !== 0) R.notes.push('Clarity other than 0 slows write speed; set it to 0 for bursts and Q-menu it back.');

    // --- sharpness ---
    const sharp = clamp(round((s.acutance - 1.25) / 0.14), -4, 4);
    set('sharpness', clamp(sharp, -2, 2), `Edge acutance ${s.acutance.toFixed(2)}. Rough estimate, resized images read softer.`);

    // --- noise reduction ---
    set('noiseReduction', grainRough === 'Off' ? -2 : -4, grainRough === 'Off' ? 'Mild NR keeps a clean look.' : 'Keep texture; let the grain show.');

    // --- exposure ---
    const ev = clamp(roundThird((s.meanY - 0.44) / 0.09), -2, 2);
    set('exposureComp', ev, `Mean luminance ${Math.round(s.meanY * 100)}% (mid-grey is about 44%).`);

    if (!best.onDial) R.notes.push(`${best.name} has no position on the Film Simulation dial. Either assign it to FS1, FS2 or FS3 (IQ › FILM SIMULATION DIAL SETTING), or turn the dial to C, the last click after FS3, which tells the camera to take the film simulation from IQ › FILM SIMULATION or your custom bank instead of the dial.`);
    return R;
  }

  function formatEV(ev) {
    if (Math.abs(ev) < 0.01) return '±0';
    const sign = ev > 0 ? '+' : '−';
    const a = Math.abs(ev), whole = Math.floor(a + 1e-6), frac = a - whole;
    const fs = frac > 0.6 ? '2/3' : frac > 0.2 ? '1/3' : '';
    return sign + (whole ? whole : '') + (whole && fs ? ' ' : '') + (fs || (whole ? '' : '0'));
  }

  const DEFAULT_CURRENT = {
    filmSim: 'PROVIA / Standard', highlight: 0, shadow: 0, color: 0, wbMode: 'Auto', wbShift: { r: 0, b: 0 },
    dynamicRange: 'DR100', grain: { roughness: 'Off', size: '—' }, colorChrome: 'Off', colorChromeBlue: 'Off',
    clarity: 0, sharpness: 0, noiseReduction: 0, exposureComp: 0, monoColor: { wc: 0, mg: 0 },
  };

  global.XT50 = { analyzeImage, recommend, FILM_SIMS, DEFAULT_CURRENT, formatEV };
})(window);
