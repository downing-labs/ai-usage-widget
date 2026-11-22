'use strict';

const { nativeImage } = require('electron');

// Prototype icon: a vertical meter. Fill height = percent used, colour by threshold.
// (Digits-in-icon like the Claude widget can come later.)
const SIZE = 32;
const BORDER = 2;
const WARN_PERCENT = 75;
const DANGER_PERCENT = 90;

// Colours as [B, G, R] (bitmap is BGRA).
const GREEN = [0x71, 0xcc, 0x2e];
const YELLOW = [0x0f, 0xc4, 0xf1];
const RED = [0x3c, 0x4c, 0xe7];
const GRAY = [0x88, 0x88, 0x88];
const BACKGROUND = [0x2e, 0x1a, 0x1a];

function pickColor(percent) {
  if (percent === null) return GRAY;
  if (percent >= DANGER_PERCENT) return RED;
  if (percent >= WARN_PERCENT) return YELLOW;
  return GREEN;
}

function buildIcon(percent) {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const fillColor = pickColor(percent);
  const clamped = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const fillRows = Math.round((clamped / 100) * (SIZE - BORDER * 2));

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const isBorder = x < BORDER || y < BORDER || x >= SIZE - BORDER || y >= SIZE - BORDER;
      const rowFromBottom = SIZE - BORDER - 1 - y;
      const filled = !isBorder && rowFromBottom < fillRows;
      const color = isBorder || filled ? fillColor : BACKGROUND;
      const i = (y * SIZE + x) * 4;
      buf[i] = color[0];
      buf[i + 1] = color[1];
      buf[i + 2] = color[2];
      buf[i + 3] = 0xff;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE });
}

module.exports = { buildIcon };
