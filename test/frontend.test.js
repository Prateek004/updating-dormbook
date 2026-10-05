'use strict';
// The three app scripts share one page: they must parse, and must never define the same
// top-level name twice (a later file would silently replace the earlier function).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', 'public', 'js');
const FILES = ['app.js', 'live.js', 'admin.js'];

test('app scripts parse and never redefine each other\'s names', () => {
  const seen = new Map();
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: f }), `${f} parses`);
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
      const name = m[1] || m[2];
      assert.ok(!seen.has(name) || seen.get(name) === f, `"${name}" is defined in both ${seen.get(name)} and ${f}`);
      seen.set(name, f);
    }
  }
  // All three together in one scope, the way the browser loads them
  assert.doesNotThrow(() => new vm.Script(FILES.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n;\n')));
});

test('index.html has every element the sign-in code needs, and loads the scripts in order', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const id of ['login-email', 'login-password', 'login-btn', 'login-keep', 'login-error', 'login-blocked', 'support-line',
    'register-btn', 'mpin-screen', 'main-app', 'page-content', 'modal-overlay', 'logout-btn']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} present`);
  }
  assert.ok(!html.includes('forgot-screen'), 'OTP reset screen removed');
  const order = ['/js/app.js', '/js/live.js', '/js/admin.js'].map((s) => html.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], 'scripts in order');
  assert.equal((html.match(/class="brand-logo"/g) || []).length, 5, 'logo on loading, sign-in, sign-up, MPIN and sidebar');
});
