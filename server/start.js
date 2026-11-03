#!/usr/bin/env node
/* ForkPad launcher for every OS: starts the helper in the background (if it isn't
   running yet) and opens the app in its own window. It uses Chrome, Edge, Chromium or
   Brave in app mode when it finds one, otherwise the default browser.
   Usage: node server/start.js  (or npm start)  */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const PORT = Number(process.env.FORKPAD_PORT) || 47821;
const URL = `http://127.0.0.1:${PORT}/`;

const ping = () => new Promise(resolve => {
  const req = http.get(URL + 'api/ping', { timeout: 400 }, res => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

function onPath(name) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out).split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}

function findBrowser() {
  const env = process.env;
  let candidates = [];
  if (process.platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    }
  } else if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
      candidates.push(path.join(env.HOME || '', 'Applications', `${app}.app`, 'Contents', 'MacOS', app));
    }
  } else {
    candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'].map(onPath);
  }
  return candidates.find(f => f && fs.existsSync(f)) || null;
}

function openDefault() {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL]]
    : process.platform === 'darwin' ? ['open', [URL]] : ['xdg-open', [URL]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function main() {
  if (!(await ping())) {
    spawn(process.execPath, [path.join(__dirname, 'forkpad-server.js')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 40 && !(await ping()); i++) await sleep(150);
  }
  if (process.argv.includes('--no-window')) return console.log(`ForkPad is running at ${URL}`);
  const browser = findBrowser();
  if (browser) spawn(browser, [`--app=${URL}`, '--window-size=1400,900'], { detached: true, stdio: 'ignore' }).unref();
  else openDefault();
}
main();
