(function () {
  'use strict';
  const { analyzeImage, recommend, FILM_SIMS, DEFAULT_CURRENT, formatEV } = window.XT50;
  const { readFujiSettings } = window.XT50Exif;
  const $ = (id) => document.getElementById(id);

  const STORAGE_KEY = 'xt50.currentSettings.v1';
  let current = loadCurrent();
  let lastRecipe = null, lastStats = null, lastFileName = '';

  function loadCurrent() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return deepMerge(structuredClone(DEFAULT_CURRENT), JSON.parse(raw));
    } catch (_) { /* ignore */ }
    return structuredClone(DEFAULT_CURRENT);
  }
  function saveCurrent() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (_) { /* ignore */ } }
  function deepMerge(base, over) {
    for (const k of Object.keys(over || {})) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) base[k] = deepMerge(base[k] || {}, over[k]);
      else base[k] = over[k];
    }
    return base;
  }

  const signed = (v, d = 0) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d).replace(/\.0$/, '');
  const fmtTone = (v) => (Number.isInteger(v) ? signed(v) : signed(v, 1));

  // Row definitions: how each setting is labelled, formatted, and compared
  const ROWS = [
    { key: 'filmSim', name: 'Film Simulation', path: 'Top dial, or IQ › FILM SIMULATION', fmt: v => v },
    { key: 'monoColor', name: 'Monochromatic Color', path: 'IQ › MONOCHROMATIC COLOR', monoOnly: true, fmt: v => `WC ${signed(v.wc)}  MG ${signed(v.mg)}`, eq: (a, b) => a.wc === b.wc && a.mg === b.mg },
    { key: 'grain', name: 'Grain Effect', path: 'IQ › GRAIN EFFECT', fmt: v => v.roughness === 'Off' ? 'Off' : `${v.roughness} / ${v.size}`, eq: (a, b) => a.roughness === b.roughness && (a.roughness === 'Off' || a.size === b.size) },
    { key: 'colorChrome', name: 'Color Chrome Effect', path: 'IQ › COLOR CHROME EFFECT', colorOnly: true, fmt: v => v },
    { key: 'colorChromeBlue', name: 'Color Chrome FX Blue', path: 'IQ › COLOR CHROME FX BLUE', colorOnly: true, fmt: v => v },
    { key: 'wbMode', name: 'White Balance', path: 'IQ › WHITE BALANCE', fmt: v => v },
    { key: 'wbShift', name: 'WB Shift', path: 'IQ › WHITE BALANCE › shift', fmt: v => `R ${signed(v.r)}  B ${signed(v.b)}`, eq: (a, b) => a.r === b.r && a.b === b.b },
    { key: 'dynamicRange', name: 'Dynamic Range', path: 'IQ › DYNAMIC RANGE', fmt: v => v },
    { key: 'highlight', name: 'Highlight Tone', path: 'IQ › TONE CURVE › H', fmt: fmtTone },
    { key: 'shadow', name: 'Shadow Tone', path: 'IQ › TONE CURVE › S', fmt: fmtTone },
    { key: 'color', name: 'Color', path: 'IQ › COLOR', colorOnly: true, fmt: v => signed(v) },
    { key: 'sharpness', name: 'Sharpness', path: 'IQ › SHARPNESS', fmt: v => signed(v) },
    { key: 'noiseReduction', name: 'High ISO NR', path: 'IQ › HIGH ISO NR', fmt: v => signed(v) },
    { key: 'clarity', name: 'Clarity', path: 'IQ › CLARITY', fmt: v => signed(v) },
    { key: 'exposureComp', name: 'Exposure Comp.', path: 'Exposure compensation dial', fmt: formatEV, eq: (a, b) => Math.abs(a - b) < 0.01 },
  ];

  // ---------- file handling ----------
  async function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) { toast('That is not an image file.'); return; }
    lastFileName = file.name || 'image';
    let bitmap;
    try { bitmap = await createImageBitmap(file); }
    catch (e) { toast('Could not decode this image. HEIC and RAW are not supported; export a JPEG.'); return; }

    const url = URL.createObjectURL(file);
    const img = $('preview');
    img.onload = () => URL.revokeObjectURL(url);
    img.src = url; img.hidden = false;
    $('dropzone').classList.add('has-image');

    checkExif(file);
    const t0 = performance.now();
    lastStats = analyzeImage(bitmap);
    lastRecipe = recommend(lastStats);
    bitmap.close();
    render();
    if (!$('guide').hidden) renderGuide();
    $('btnCopy').disabled = false;
    toast(`Analysed ${lastFileName} in ${Math.round(performance.now() - t0)} ms`);
  }

  // ---------- camera settings from EXIF ----------
  let pendingExif = null;
  async function parseExif(file) {
    try { return readFujiSettings(await file.arrayBuffer()); } catch (_) { return null; }
  }
  async function checkExif(file) {
    const banner = $('exifBanner');
    banner.hidden = true; pendingExif = null;
    const info = await parseExif(file);
    if (!info) return;
    pendingExif = info;
    const n = Object.keys(info.settings).length;
    $('exifBannerTitle').textContent = `Shot on ${info.make} ${info.model}: ${info.settings.filmSim || 'film simulation unknown'}`;
    $('exifBannerSub').textContent = `${n} camera settings found in the file${info.assumed.length ? ` (${info.assumed.join(', ')} not recorded, assumed default)` : ''}.`;
    banner.hidden = false;
  }
  function applyImported(info, fileName) {
    current = deepMerge(current, info.settings);
    saveCurrent();
    const n = Object.keys(info.settings).length;
    $('importInfo').textContent = `Read ${n} settings from ${fileName} (${info.make} ${info.model}).`;
    if (!$('modal').hidden) buildForm();
    if (lastRecipe) renderSettings();
    toast(`Current settings set from ${fileName}`);
  }
  async function importExifFile(file) {
    if (!file) return;
    const info = await parseExif(file);
    if (!info) { toast('No Fujifilm camera settings in that file. Use a JPEG straight from the camera.'); return; }
    applyImported(info, file.name);
  }

  // ---------- rendering ----------
  function render() {
    if (!lastRecipe) return;
    const R = lastRecipe, s = lastStats;
    $('uploader').hidden = true; $('main').hidden = $('guide').hidden ? false : true; $('result').hidden = false; $('analysis').hidden = false;

    $('heroName').textContent = R.filmSim.name;
    $('heroDial').textContent = R.filmSim.onDial ? 'On the dial' : 'Dial: FS1–FS3 or C';
    $('heroDesc').textContent = R.filmSim.desc;
    $('confFill').style.width = `${Math.round(R.confidence * 100)}%`;
    $('confText').textContent = `${Math.round(R.confidence * 100)}% fit`;
    $('alts').innerHTML = R.alternatives.map(a => `<span class="alt">also close: <b>${a.sim.name}</b> ${Math.round(a.fit * 100)}%</span>`).join('');

    renderSettings();
    renderPalette(s.palette);
    renderHistogram(s);
    renderFeatures(s, R.features);

    $('notes').innerHTML = R.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('');
    $('notesCard').hidden = R.notes.length === 0;
  }

  function renderSettings() {
    const R = lastRecipe, mono = !!R.filmSim.mono;
    let changes = 0;
    const rows = ROWS.filter(r => !(r.monoOnly && !mono) && !(r.colorOnly && mono)).map(r => {
      const rec = R.settings[r.key], cur = current[r.key];
      const same = r.eq ? r.eq(rec, cur) : rec === cur;
      if (!same) changes++;
      return `<tr class="${same ? '' : 'diff'}">
        <td><div class="s-name">${r.name}</div><div class="s-path">${r.path}</div><div class="s-why">${escapeHtml(R.reasons[r.key] || '')}</div></td>
        <td class="val">${r.fmt(rec)}</td>
        <td class="val cur">${r.fmt(cur)}</td>
        <td><span class="tag ${same ? 'same' : ''}">${same ? 'keep' : 'change'}</span></td>
      </tr>`;
    });
    $('settingsBody').innerHTML = rows.join('');
    const cc = $('changeCount');
    cc.textContent = changes === 0 ? 'nothing to change' : `${changes} change${changes === 1 ? '' : 's'}`;
    cc.classList.toggle('hot', changes > 0);
  }

  function renderPalette(p) {
    $('palette').innerHTML = p.map(c => `<div class="sw" style="background:${c.hex};flex-grow:${Math.max(1, Math.round(c.share * 10))}"><span>${c.hex}</span></div>`).join('');
  }

  function renderHistogram(s) {
    const c = $('hist'), ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    const max = Math.max(...s.hist.slice(2, 254), 1);
    const draw = (hist, color, fill) => {
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo(i / 255 * W, H - Math.min(H, hist[i] / max * H));
      ctx.lineTo(W, H); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
    };
    ctx.globalCompositeOperation = 'multiply';
    draw(s.rHist, 'rgba(216,91,49,.75)', 'rgba(216,91,49,.14)');
    draw(s.gHist, 'rgba(60,150,90,.75)', 'rgba(60,150,90,.14)');
    draw(s.bHist, 'rgba(60,110,200,.75)', 'rgba(60,110,200,.14)');
    ctx.globalCompositeOperation = 'source-over';
    draw(s.hist, 'rgba(41,40,39,.9)', 'rgba(41,40,39,.10)');
    // percentile markers
    ctx.fillStyle = 'rgba(216,91,49,.8)';
    for (const q of [s.p1, s.p50, s.p99]) ctx.fillRect(q * W - 0.5, 0, 1, H);
  }

  function renderFeatures(s, f) {
    const pct = (v) => `${Math.round(v * 100)}%`;
    const items = [
      ['Mean brightness', pct(s.meanY)], ['Contrast (σ)', pct(s.stdY)], ['Black point p1', pct(s.p1)],
      ['White point p99', pct(s.p99)], ['Clipped white', `${(s.clipHi * 100).toFixed(1)}%`], ['Crushed black', `${(s.clipLo * 100).toFixed(1)}%`],
      ['Saturation', pct(s.meanSat)], ['Colourful pixels', pct(s.colorfulFrac)], ['Blue share', pct(s.blueFrac)],
      ['Cast (warm +)', (s.cast.warm * 100).toFixed(0)], ['Tint (green +)', (s.cast.tint * 100).toFixed(0)], ['Shadow tint vs mids', (f.shWarmRel * 100).toFixed(0)],
      ['Highlight tint vs mids', (f.hiWarmRel * 100).toFixed(0)], ['Grain (noise σ)', `${(s.noiseFine * 100).toFixed(1)}%`], ['Local contrast', `${(s.localContrast * 100).toFixed(1)}%`],
    ];
    $('features').innerHTML = items.map(([k, v]) => `<div class="feature"><span>${k}</span><b>${v}</b></div>`).join('');
  }

  // ---------- guide ----------
  function guideSteps() {
    const R = lastRecipe;
    const steps = [];
    if (!R) return steps;
    const S = R.settings, mono = !!R.filmSim.mono, name = R.filmSim.name;
    if (R.filmSim.onDial) steps.push({ t: `Turn the Film Simulation dial to ${name.replace(/\.$/, '')}.`, d: 'The dial wins over whatever the menu or a custom bank says, so this is the one setting you cannot get wrong.' });
    else steps.push({ t: `Turn the Film Simulation dial to FS1 (or FS2 / FS3) and make sure that slot holds ${name}.`, d: 'To assign it: MENU/OK › IQ › FILM SIMULATION DIAL SETTING › FS1 › ' + name + '. Or set the dial to C and pick it under IQ › FILM SIMULATION.' });
    if (mono && R.filmSim.id === 'ACROS') steps.push({ t: 'Pick the ACROS filter.', d: 'IQ › FILM SIMULATION DIAL SETTING › ACROS › STD, Ye, R or G. Then Monochromatic Color: IQ › MONOCHROMATIC COLOR › WC ' + signed(S.monoColor.wc) + ', MG ' + signed(S.monoColor.mg) + '.' });
    if (S.wbMode !== current.wbMode || S.wbShift.r !== current.wbShift.r || S.wbShift.b !== current.wbShift.b)
      steps.push({ t: `White balance: ${S.wbMode}, shift R ${signed(S.wbShift.r)} B ${signed(S.wbShift.b)}.`, d: 'Press Q, move to the WB tile, turn the rear command dial to the mode, then press MENU/OK (or ▶ in the IQ › WHITE BALANCE menu) to open the shift grid. Left/right moves R, up/down moves B. Confirm with MENU/OK.' });
    const q = [];
    const push = (label, rec, cur, fmt) => { if (rec !== cur) q.push(`${label} ${fmt(rec)}`); };
    push('Dynamic Range', S.dynamicRange, current.dynamicRange, v => v);
    push('Highlight', S.highlight, current.highlight, fmtTone);
    push('Shadow', S.shadow, current.shadow, fmtTone);
    if (!mono) push('Color', S.color, current.color, signed);
    push('Sharpness', S.sharpness, current.sharpness, signed);
    push('High ISO NR', S.noiseReduction, current.noiseReduction, signed);
    push('Clarity', S.clarity, current.clarity, signed);
    const g = S.grain, cg = current.grain;
    if (g.roughness !== cg.roughness || (g.roughness !== 'Off' && g.size !== cg.size)) q.push(`Grain ${g.roughness === 'Off' ? 'Off' : g.roughness + ' / ' + g.size}`);
    if (!mono) { push('Color Chrome Effect', S.colorChrome, current.colorChrome, v => v); push('Color Chrome FX Blue', S.colorChromeBlue, current.colorChromeBlue, v => v); }
    if (q.length) steps.push({ t: 'Press Q and set: ' + q.join(' · ') + '.', d: 'Move between tiles with the focus stick or selector, turn the rear command dial to change the value, half-press the shutter to leave. Anything missing from your Q menu is under MENU/OK › IQ, or add it via SET UP › BUTTON/DIAL SETTING › EDIT/SAVE QUICK MENU.' });
    if (S.dynamicRange === 'DR200' || S.dynamicRange === 'DR400') steps.push({ t: `Raise ISO to at least ${S.dynamicRange === 'DR400' ? 500 : 250} so ${S.dynamicRange} is selectable.`, d: 'Below that ISO the camera greys the option out and silently falls back to DR100.' });
    if (Math.abs(S.exposureComp - current.exposureComp) > 0.01) steps.push({ t: `Exposure compensation dial to ${formatEV(S.exposureComp)}.`, d: 'The top-right dial. If it is on C, use the front command dial instead.' });
    steps.push({ t: 'Shoot one test frame and drop that JPEG back into this app.', d: 'The app reads the settings the camera actually wrote into the file, so you can confirm nothing was missed.' });
    return steps;
  }

  function renderGuide() {
    const R = lastRecipe;
    const box = $('guideSteps');
    if (!R) {
      box.innerHTML = '<p class="muted">Drop an image first and the steps here will be filled in with the exact values for that look.</p>';
    } else {
      box.innerHTML = '<ol class="steps">' + guideSteps().map(s => `<li><div class="step-t">${escapeHtml(s.t)}</div><div class="step-d">${escapeHtml(s.d)}</div></li>`).join('') + '</ol>';
    }
    const nameHint = R ? `${R.filmSim.name.split(' ')[0]} ${lastFileName.replace(/\.[^.]+$/, '')}`.slice(0, 20) : 'e.g. NostalgicNeg warm';
    $('bankName').textContent = nameHint;
    $('dialTable').innerHTML = FILM_SIMS.map(f => `<tr class="${R && R.filmSim.id === f.id ? 'hl' : ''}"><td>${f.name}</td><td>${f.onDial ? 'On the dial' : 'FS1–FS3 or C position'}</td></tr>`).join('') + '<tr><td>Sepia</td><td>FS1–FS3 or C position</td></tr>';
  }

  function guideText() {
    return ['Set it on the go', ...guideSteps().map((s, i) => `${i + 1}. ${s.t}\n   ${s.d}`)].join('\n');
  }

  function showGuide(on) {
    $('guide').hidden = !on;
    if (lastRecipe) $('main').hidden = on; else $('uploader').hidden = on;
    $('btnGuide').classList.toggle('btn-on', on);
    if (on) renderGuide();
  }

  // ---------- recipe text ----------
  function recipeText() {
    const R = lastRecipe, mono = !!R.filmSim.mono;
    const lines = [`Fujifilm X-T50 recipe — matched from ${lastFileName}`, ''];
    for (const r of ROWS) {
      if ((r.monoOnly && !mono) || (r.colorOnly && mono)) continue;
      const rec = R.settings[r.key], cur = current[r.key];
      const same = r.eq ? r.eq(rec, cur) : rec === cur;
      lines.push(`${r.name.padEnd(22)} ${r.fmt(rec)}${same ? '' : `   (you have ${r.fmt(cur)})`}`);
    }
    if (R.alternatives.length) lines.push('', `Alternatives: ${R.alternatives.map(a => `${a.sim.name} ${Math.round(a.fit * 100)}%`).join(', ')}`);
    if (R.notes.length) lines.push('', ...R.notes.map(n => `• ${n}`));
    return lines.join('\n');
  }

  // ---------- current settings form ----------
  const WB_MODES = ['Auto', 'Auto (White Priority)', 'Auto (Ambience Priority)', 'Daylight', 'Shade', 'Fluorescent 1', 'Fluorescent 2', 'Fluorescent 3', 'Incandescent', 'Underwater', 'Custom', 'Kelvin 4300K', 'Kelvin 5500K', 'Kelvin 6500K'];
  const SIM_NAMES = FILM_SIMS.map(f => f.name).concat(['Sepia']);
  const TRI = ['Off', 'Weak', 'Strong'];

  function sel(name, opts, val) { return `<select name="${name}">${opts.map(o => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select>`; }
  function num(name, val, min, max, step = 1) { return `<input type="number" name="${name}" value="${val}" min="${min}" max="${max}" step="${step}">`; }

  function buildForm() {
    const c = current;
    $('currentForm').innerHTML = `
      <label><span>Film Simulation</span>${sel('filmSim', SIM_NAMES, c.filmSim)}</label>
      <label><span>White Balance</span>${sel('wbMode', WB_MODES.includes(c.wbMode) ? WB_MODES : WB_MODES.concat([c.wbMode]), c.wbMode)}</label>
      <label><span>WB Shift (R / B)</span><div class="pair">${num('wbShift.r', c.wbShift.r, -9, 9)}${num('wbShift.b', c.wbShift.b, -9, 9)}</div></label>
      <label><span>Dynamic Range</span>${sel('dynamicRange', ['DR100', 'DR200', 'DR400', 'Auto'], c.dynamicRange)}</label>
      <label><span>Highlight Tone</span>${num('highlight', c.highlight, -2, 4, 0.5)}</label>
      <label><span>Shadow Tone</span>${num('shadow', c.shadow, -2, 4, 0.5)}</label>
      <label><span>Color</span>${num('color', c.color, -4, 4)}</label>
      <label><span>Sharpness</span>${num('sharpness', c.sharpness, -4, 4)}</label>
      <label><span>High ISO NR</span>${num('noiseReduction', c.noiseReduction, -4, 4)}</label>
      <label><span>Clarity</span>${num('clarity', c.clarity, -5, 5)}</label>
      <label><span>Grain (roughness / size)</span><div class="pair">${sel('grain.roughness', TRI, c.grain.roughness)}${sel('grain.size', ['—', 'Small', 'Large'], c.grain.size)}</div></label>
      <label><span>Color Chrome Effect</span>${sel('colorChrome', TRI, c.colorChrome)}</label>
      <label><span>Color Chrome FX Blue</span>${sel('colorChromeBlue', TRI, c.colorChromeBlue)}</label>
      <label><span>Mono Color (WC / MG)</span><div class="pair">${num('monoColor.wc', c.monoColor.wc, -18, 18)}${num('monoColor.mg', c.monoColor.mg, -18, 18)}</div></label>
      <label><span>Exposure Comp. (EV)</span>${num('exposureComp', c.exposureComp, -3, 3, 0.333)}</label>
    `;
  }

  function onFormChange(e) {
    const el = e.target, path = el.name.split('.');
    let v = el.type === 'number' ? Number(el.value) : el.value;
    if (el.name === 'exposureComp') v = Math.round(v * 3) / 3;
    if (el.type === 'number' && Number.isNaN(v)) return;
    let o = current; for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    o[path[path.length - 1]] = v;
    saveCurrent();
    if (lastRecipe) renderSettings();
    if (!$('guide').hidden) renderGuide();
  }

  // ---------- misc ----------
  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

  // ---------- web vs desktop ----------
  const isElectron = /Electron/i.test(navigator.userAgent);
  document.body.classList.toggle('web', !isElectron);
  if (!isElectron && 'serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
  }

  // ---------- wiring ----------
  const dz = $('dropzone'), uc = $('uploadCard');
  const setOver = (on) => { dz.classList.toggle('over', on); uc.classList.toggle('over', on); };
  for (const el of [document.body]) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); setOver(true); });
    el.addEventListener('dragleave', (e) => { if (e.target === document.body || e.relatedTarget === null) setOver(false); });
    el.addEventListener('drop', (e) => {
      e.preventDefault(); setOver(false);
      const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
      if (f) handleFile(f); else toast('Drop an image file.');
    });
  }
  dz.addEventListener('click', () => $('fileInput').click());
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; });
  $('fileInputStart').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; });
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) handleFile(item.getAsFile());
  });
  $('btnCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(recipeText()); toast('Recipe copied to clipboard'); }
    catch (_) { toast('Could not access the clipboard'); }
  });
  $('btnCurrent').addEventListener('click', () => { buildForm(); $('modal').hidden = false; });
  $('btnGuide').addEventListener('click', () => showGuide($('guide').hidden));
  $('btnGuideBack').addEventListener('click', () => showGuide(false));
  $('btnCopySteps').addEventListener('click', async () => {
    if (!lastRecipe) { toast('Drop an image first'); return; }
    try { await navigator.clipboard.writeText(guideText()); toast('Steps copied'); } catch (_) { toast('Could not access the clipboard'); }
  });
  $('btnUseExif').addEventListener('click', () => { if (pendingExif) applyImported(pendingExif, lastFileName); $('exifBanner').hidden = true; });
  $('btnImportExif').addEventListener('click', () => $('fileInputExif').click());
  $('fileInputExif').addEventListener('change', (e) => { importExifFile(e.target.files[0]); e.target.value = ''; });
  const panel = document.querySelector('.modal-panel');
  panel.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); panel.classList.add('over'); });
  panel.addEventListener('dragleave', () => panel.classList.remove('over'));
  panel.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); panel.classList.remove('over');
    const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
    importExifFile(f);
  });
  $('btnCloseModal').addEventListener('click', () => { $('modal').hidden = true; });
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').hidden = true; });
  $('currentForm').addEventListener('change', onFormChange);
  $('currentForm').addEventListener('input', onFormChange);
  $('btnResetCurrent').addEventListener('click', () => { current = structuredClone(DEFAULT_CURRENT); saveCurrent(); buildForm(); if (lastRecipe) renderSettings(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('modal').hidden = true; });
})();
