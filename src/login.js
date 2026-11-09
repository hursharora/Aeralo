import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { browserOptions } from './collect.js';

// The user enters credentials only into the airline's own visible browser page.
export async function login({ profile, executable, timeout = 300 }) {
  if (!process.stdin.isTTY) throw new Error('--login requires an interactive terminal. Run it locally, sign in in the browser, then press Enter.');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profile, browserOptions({ headed: true, executable }));
  let prompt;
  let timer;
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const response = await page.goto('https://www.aircanada.com/ca/en/aco/home.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response && response.status() >= 400) throw new Error(`Air Canada homepage returned HTTP ${response.status()}; login was not attempted.`);
    prompt = createInterface({ input: process.stdin, output: process.stdout });
    console.log('Use the visible Air Canada page to sign in manually. Do not enter credentials in this terminal.');
    await Promise.race([
      prompt.question('After signing in, press Enter here to save and close the dedicated profile: '),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Login window expired; run --login again when ready.')), timeout * 1000); }),
    ]);
    console.log('Dedicated browser profile saved. Repeat your search with the same --profile; authentication will be checked then.');
  } finally {
    clearTimeout(timer);
    prompt?.close();
    await context.close();
  }
}
