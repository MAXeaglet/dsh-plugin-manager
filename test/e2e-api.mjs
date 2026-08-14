
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const PROJ = fileURLToPath(new URL('..', import.meta.url)).replace(/\\$/,'');
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const tmp = 'D:/WorkSpace/tmp/dpm-e2e-api';
rmSync(tmp, { recursive: true, force: true });
process.env.DSH_HOME = tmp;
const prof = join(tmp, 'profiles', 'web');
mkdirSync(join(prof, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true });
writeFileSync(join(prof, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.0' }));
mkdirSync(join(prof, 'node_modules', '@dsh-external', 'dsh-vision-toolkit'), { recursive: true });
writeFileSync(join(prof, 'node_modules', '@dsh-external', 'dsh-vision-toolkit', 'package.json'), JSON.stringify({ name: '@dsh-external/dsh-vision-toolkit', version: '0.1.4' }));
writeFileSync(join(prof, 'node_modules', '@dsh-external', 'dsh-vision-toolkit', 'cordis.patch.yml'), "- insert:\n    - id: vision-toolkit\n      name: '@dsh-external/dsh-vision-toolkit'\n");
writeFileSync(join(prof, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-external/dsh-vision-toolkit'] } } }, null, 2) + '\n');
writeFileSync(join(prof, 'cordis.patch.yml'), '- id: tool-web\n  name: tool-web\n  config:\n    search: false\n');

const srv = spawn('node', ['lib/server.mjs'], { cwd: PROJ, stdio: 'ignore', detached: true, env: process.env });
await new Promise(r => setTimeout(r, 1500));
const base = 'http://127.0.0.1:5177';
let pass = 0, fail = 0;
async function api(p, o) {
  const res = await fetch(base + p, o);
  return { status: res.status, data: await res.json().catch(() => null) };
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// 1. profiles
const pr = await api('/api/profiles');
check('profiles returns web', Array.isArray(pr.data.profiles) && pr.data.profiles.includes('web'), pr.data);

// 2. list plugins — no duplicates, vision-toolkit bundle present
const pl = await api('/api/plugins?profile=web');
const ids = pl.data.plugins.map(p => p.id);
check('no duplicate vision', ids.filter(x => x === 'dsh-vision-toolkit').length === 1, ids);
check('vision-toolkit bundle present', ids.includes('dsh-vision-toolkit'), ids);
check('no stray vision-toolkit patch row', !ids.includes('vision-toolkit'), ids);
check('tool-web patch present', ids.includes('tool-web'), ids);

// 3. toggle disable vision-toolkit
const tg = await api('/api/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'web', id: 'dsh-vision-toolkit', disabled: true }) });
check('toggle ok', tg.status === 200, tg);
const after = await api('/api/plugins?profile=web');
const vt = after.data.plugins.find(p => p.id === 'dsh-vision-toolkit');
check('vision disabled after toggle', vt && vt.disabled === true, vt);
// patch file has canonical name
const patchText = readFileSync(join(prof, 'cordis.patch.yml'), 'utf8');
check('patch has canonical name', patchText.includes('@dsh-external/dsh-vision-toolkit') && patchText.includes('disabled: true'), patchText);

// 4. toggle re-enable
await api('/api/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'web', id: 'dsh-vision-toolkit', disabled: false }) });
const after2 = await api('/api/plugins?profile=web');
const vt2 = after2.data.plugins.find(p => p.id === 'dsh-vision-toolkit');
check('vision re-enabled', vt2 && vt2.disabled === false, vt2);

// 5. config set
const cfg = await api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'web', id: 'tool-web', config: { search: true, n: 5 } }) });
check('config set ok', cfg.status === 200, cfg);
const cfgAfter = await api('/api/plugins?profile=web');
const tw = cfgAfter.data.plugins.find(p => p.id === 'tool-web');
check('config applied', tw && tw.config && tw.config.n === 5, tw);

// 6. export
const ex = await api('/api/export?profile=web');
check('export ok', ex.data && ex.data.profile === 'web' && Array.isArray(ex.data.bundles), ex.data && ex.data.profile);

// 7. reorder
const rb = await api('/api/reorder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'web', bundles: ['@dsh-external/dsh-vision-toolkit', '@deepseek-ai/dsh-base'] }) });
check('reorder ok', rb.status === 200 && rb.data.bundles[0] === '@dsh-external/dsh-vision-toolkit', rb.data);

// 8. dsh-status
const st = await api('/api/dsh-status?port=3080');
check('dsh-status ok', st.status === 200 && typeof st.data.running === 'boolean', st.data);

// 9. profile-files + save
const pf = await api('/api/profile-files?profile=web');
check('profile-files ok', pf.status === 200 && typeof pf.data.manifest === 'string', pf.data);
const sv = await api('/api/profile-files-save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'web', manifest: JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2) + '\n' }) });
check('profile-files-save ok', sv.status === 200 && sv.data.ok === true, sv);
const baks = readdirSync(prof).filter(f => f.endsWith('.bak'));
check('backup created on save', baks.length >= 1, baks);

// 10. readme
const rd = await api('/api/readme?profile=web&name=' + encodeURIComponent('@deepseek-ai/dsh-base'));
check('readme returns error gracefully (no README in test)', rd.status === 200 && rd.data.ok === false, rd.data);

srv.kill();
rmSync(tmp, { recursive: true, force: true });
console.log('=== E2E API RESULT:', pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
