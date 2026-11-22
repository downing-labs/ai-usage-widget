'use strict';

/**
 * Next.js client bundles register each server action as
 *   createServerReference)("<hex action id>", callServer, void 0, findSourceMapURL, "<exportName>")
 * so the ID of a named action can be found by scanning the page's JS.
 * Pure helpers - no Electron dependency, unit-testable with plain node.
 */

function actionIdPattern(exportName) {
  const safe = String(exportName).replace(/[^A-Za-z0-9_$]/g, '').replace(/\$/g, '\\$$');
  // [^)]{0,160}? cannot cross a closing paren, so one reference never "borrows" the next one's name.
  return new RegExp(`createServerReference\\)?\\(\\s*"([0-9a-f]{40,})"[^)]{0,160}?"${safe}"`);
}

function extractActionId(text, exportName) {
  if (typeof text !== 'string') return null;
  const m = actionIdPattern(exportName).exec(text);
  return m ? m[1] : null;
}

module.exports = { actionIdPattern, extractActionId };
