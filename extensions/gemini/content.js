'use strict';
// Runs on https://gemini.google.com/usage. The page renders its meters with JavaScript, so wait for
// them to appear, parse the text, and pass the result to the background worker. Reads only; clicks nothing.

(() => {
  const POLL_MS = 1000;
  const GIVE_UP_MS = 20000;
  const started = Date.now();

  function attempt() {
    const text = (document.querySelector('main') || document.body).innerText || '';
    if (/sign in|choose an account/i.test(text) && !/Usage limits/i.test(text)) {
      chrome.runtime.sendMessage({ type: 'gemini-usage', ok: false, reason: 'signed-out' });
      return;
    }
    const usage = parseGeminiUsage(text);
    if (usage) {
      chrome.runtime.sendMessage({ type: 'gemini-usage', ok: true, usage, at: Date.now() });
      return;
    }
    if (Date.now() - started > GIVE_UP_MS) {
      chrome.runtime.sendMessage({ type: 'gemini-usage', ok: false, reason: 'no-meters-found' });
      return;
    }
    setTimeout(attempt, POLL_MS);
  }
  attempt();
})();
