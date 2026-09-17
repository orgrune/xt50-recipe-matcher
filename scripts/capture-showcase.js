// Renders the app with a sample image loaded and saves a PNG for screenshots / social posts.
// Usage: npx electron scripts/capture-showcase.js /path/to/photo.jpg [out.png] [mobile]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const [,, photo, out = 'build/showcase.png', mode = 'desktop'] = process.argv;
if (!photo) { console.error('photo path required'); process.exit(1); }
setTimeout(() => { console.error('timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const mobile = mode === 'mobile';
  const win = new BrowserWindow({ width: mobile ? 390 : 1400, height: mobile ? 844 : 900, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  const b64 = fs.readFileSync(photo).toString('base64');
  await win.webContents.executeJavaScript(`(async () => {
    document.body.classList.add('web');
    const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
    const f = new File([bytes], 'photo.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 2500));
    document.getElementById('toast').hidden = true;
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('wrote', out, img.getSize());
  app.quit();
});
