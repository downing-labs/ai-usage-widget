'use strict';

const $ = (id) => document.getElementById(id);

function show(text, cls) {
  const s = $('status');
  s.textContent = text;
  s.className = cls || '';
}

async function test(token) {
  if (!token) return show('No token saved.', 'bad');
  try {
    const r = await fetch('http://127.0.0.1:47831/status', { headers: { authorization: `Bearer ${token}` } });
    if (r.ok) return show('Connected to the widget.', 'ok');
    if (r.status === 401) return show('The widget rejected this token. Copy it again from the widget.', 'bad');
    show(`Unexpected answer from the widget (${r.status}).`, 'bad');
  } catch {
    show('Widget not reachable. Is it running, with Gemini ticked in its settings?', 'bad');
  }
}

$('save').addEventListener('click', async () => {
  const token = $('token').value.trim();
  await chrome.storage.local.set({ token });
  await test(token);
});
$('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove('token');
  $('token').value = '';
  show('Token removed. The companion is idle.', '');
});

chrome.storage.local.get('token').then(({ token }) => {
  if (token) { $('token').value = token; test(token); }
});
