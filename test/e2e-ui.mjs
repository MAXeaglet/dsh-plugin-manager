
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const tmp = 'D:/WorkSpace/tmp/dpm-e2e-ui';
rmSync(tmp, { recursive: true, force: true });
process.env.DSH_HOME = tmp;
const prof = join(tmp, 'profiles', 'web');
mkdirSync(join(prof, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true });
writeFileSync(join(prof, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.0' }));
mkdirSync(join(prof, 'node_modules', '@dsh-external', 'dsh-vision-toolkit'), { recursive: true });
writeFileSync(join(prof, 'node_modules', '@dsh-external', 'dsh-vision-toolkit', 'package.json'), JSON.stringify({ name: '@dsh-external/dsh-vision-toolkit', version: '0.1.4' }));
writeFileSync(join(prof, 'node_modules', '@dsh-external', 'dsh-vision-toolkit', 'cordis.patch.yml'), "- insert:\n    - id: vision-toolkit\n      name: '@dsh-external/dsh-vision-toolkit'\n");
writeFileSync(join(prof, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-external/dsh-vision-toolkit'] } } }, null, 2) + '\n');
writeFileSync(join(prof, 'cordis.patch.yml'), '- id: tool-web\n  name: tool-web\n');

const srv = spawn('node', ['lib/server.mjs'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore', detached: true, env: process.env });
await new Promise(r => setTimeout(r, 1500));

let pass = 0, fail = 0;
const check = (name, cond, extra) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra ?? ''); } };

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
page.on('console', msg => { if (msg.type() === 'error') console.log('PAGE ERROR:', msg.text()); });
page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));

try {
  await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // 1. plugins listed
  const rows = await page.locator('.pl').count();
  check('plugin rows rendered', rows >= 2, rows);

  // 2. select dsh-vision-toolkit (last row)
  const visionRow = page.locator('.pl').filter({ hasText: 'dsh-vision-toolkit' });
  check('vision row exists', await visionRow.count() === 1);
  await visionRow.click();
  await page.waitForTimeout(300);
  const detailH = await page.locator('#detail h2').textContent();
  check('detail shows vision', detailH === 'dsh-vision-toolkit', detailH);

  // 3. click disable button
  const disableBtn = page.locator('#detail .acts .btn', { hasText: '禁用' });
  check('disable button exists', await disableBtn.count() === 1);
  await disableBtn.click();
  await page.waitForTimeout(800); // wait for reload

  // 4. after toggle, still selected vision (NOT first)?
  const detailH2 = await page.locator('#detail h2').textContent();
  check('selection preserved after toggle (still vision)', detailH2 === 'dsh-vision-toolkit', detailH2);
  // active row highlight
  const activeText = await page.locator('.pl.active .id').textContent().catch(() => 'none');
  check('active row is vision', activeText === 'dsh-vision-toolkit', activeText);
  // disabled badge
  const badge = await page.locator('#detail .badge').textContent().catch(() => 'none');
  check('badge shows disabled', badge === '已禁用', badge);

  // 5. toggle enable again
  await page.locator('#detail .acts .btn', { hasText: '启用' }).click();
  await page.waitForTimeout(800);
  const detailH3 = await page.locator('#detail h2').textContent();
  check('still selected after re-enable', detailH3 === 'dsh-vision-toolkit', detailH3);

  // 6. search + escape clears
  const search = page.locator('#searchInput');
  await search.fill('vision');
  await page.waitForTimeout(200);
  const filtered = await page.locator('.pl').count();
  check('search filters to 1', filtered === 1, filtered);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const afterEsc = await page.locator('.pl').count();
  check('escape clears search (all rows)', afterEsc >= 2, afterEsc);

  // 7. language switch keeps selection
  await page.locator('#langBtn').click();
  await page.waitForTimeout(300);
  const langDetail = await page.locator('#detail h2').textContent();
  check('lang switch keeps selection', langDetail === 'dsh-vision-toolkit', langDetail);

  // 8. README modal renders (no page error)
  const readmeBtn = page.locator('#detail .acts .btn', { hasText: 'README' });
  if (await readmeBtn.count()) {
    await readmeBtn.click();
    await page.waitForTimeout(400);
    const modal = page.locator('.modal.wide');
    check('readme modal opens', await modal.count() === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
} catch (e) {
  console.log('E2E EXCEPTION:', e.message);
  fail++;
} finally {
  await browser.close();
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
  console.log('=== REAL UI E2E:', pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
}
