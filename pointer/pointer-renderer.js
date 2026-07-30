'use strict';
/* Positions the highlight ring at the AX element's screen bounds. No bundler
   needed here: this file has no imports, so it loads as a plain script. */

const { ipcRenderer } = require('electron');

const ring = document.getElementById('ring');
const tag = document.getElementById('tag');

ipcRenderer.on('point', (_e, target) => {
  const [x, y, w, h] = target.bounds || [];
  if ([x, y, w, h].some((v) => typeof v !== 'number')) return;

  // pad the ring slightly outside the element so it frames rather than covers
  const pad = 4;
  ring.style.left = `${x - pad}px`;
  ring.style.top = `${y - pad}px`;
  ring.style.width = `${w + pad * 2}px`;
  ring.style.height = `${h + pad * 2}px`;
  ring.classList.add('show');

  if (target.label) {
    tag.textContent = target.label;
    // place the tag above the ring, or below if it would clip the top edge
    const above = y - 30 > 0;
    tag.style.left = `${x - pad}px`;
    tag.style.top = above ? `${y - 30}px` : `${y + h + 8}px`;
    tag.classList.add('show');
  } else {
    tag.classList.remove('show');
  }
});

ipcRenderer.on('clear', () => {
  ring.classList.remove('show');
  tag.classList.remove('show');
});
