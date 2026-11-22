'use strict';
// Renders the app's icon (purple rounded square, three white bars) to PNG files, using Electron's own
// canvas. Run: node_modules\electron\dist\electron.exe tools\make-icons.js
// The drawing below must stay identical to window.__drawAppIcon in src/renderer/app.js.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const OUTPUTS = [
  { dir: path.join(__dirname, '..', 'extensions', 'gemini', 'icons'), sizes: [16, 32, 48, 128], name: (s) => `icon${s}.png` },
  // electron-builder turns this into the Windows .ico for the exe, installer and shortcuts.
  { dir: path.join(__dirname, '..', 'assets'), sizes: [512], name: () => 'icon.png' },
];

const DRAW = `((size) => {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  g.scale(size / 32, size / 32);
  const grad = g.createLinearGradient(0, 0, 32, 32);
  grad.addColorStop(0, '#7C6CFF');
  grad.addColorStop(1, '#3B2DB8');
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(0, 0, 32, 32, 8);
  g.fill();
  g.strokeStyle = '#FFFFFF';
  g.lineWidth = 3.2;
  g.lineCap = 'round';
  g.stroke(new Path2D('M8 10h16M8 16h11M8 22h14'));
  return canvas.toDataURL('image/png');
})`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  for (const out of OUTPUTS) {
    fs.mkdirSync(out.dir, { recursive: true });
    for (const size of out.sizes) {
      const url = await win.webContents.executeJavaScript(`${DRAW}(${size})`);
      fs.writeFileSync(path.join(out.dir, out.name(size)), Buffer.from(url.split(',')[1], 'base64'));
      console.log(`wrote ${out.name(size)}`);
    }
  }
  app.quit();
});
