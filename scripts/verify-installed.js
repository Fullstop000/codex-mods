import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { installedReplay } from '../test/helpers/installed-replay.js';
import { payload, cleanupExpression } from '../src/renderer.js';

const {values} = parseArgs({options:{asar:{type:'string',default:'/Applications/ChatGPT.app/Contents/Resources/app.asar'},output:{type:'string',default:'test-results/installed'}}});
const output = resolve(values.output);
await mkdir(output,{recursive:true});
const checks = [];
const check = async (name, run) => {await run();checks.push(name);};
const id = '01234567-89ab-cdef-0123-456789abcdef';
const bigId = '01234567-89ab-cdef-0123-456789abcdee';
const missingId = '01234567-89ab-cdef-0123-456789abcded';
const remote = 'remote-ssh-discovered:10.37.90.39';
const rows = [
  {id,kind:'local',host:'local',title:'Inspect a long session title without moving its actions',active:true},
  {id:bigId,kind:'local',host:'local',title:'Large session',secondary:'Secondary line stays inside its native container'},
  {id,kind:'local',host:remote,title:'Remote session with the same ID'},
  {id,kind:'remote',title:'Cloud session with the same ID'},
  {id:missingId,kind:'local',host:'local',title:'No local record'},
];
const sizes = {[id]:2*1024**2,[bigId]:2*1024**3};
let replay;
try {replay = await installedReplay(resolve(values.asar));}
catch(error) {
  const report={passed:false,date:new Date().toISOString(),asar:resolve(values.asar),failed:error.message,checks:[]};
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(join(output,'report.md'),`# Installed Codex sidebar compatibility\n\nFAIL — ${error.message}\n`);
  throw error;
}
const {page} = replay;
const row = (key,host) => page.locator(`[data-app-action-sidebar-thread-id="${key}"]${host==null?'':`[data-app-action-sidebar-thread-host-id="${host}"]`}`);
const local = () => row(`local:${id}`,'local');
const count = selector => page.locator(selector).count();
const install = options => page.evaluate(payload({showSize:true,sessionSizes:sizes,refreshMs:60000,...options}));
const eventCount = type => page.evaluate(type=>window.__events.filter(event=>event.type===type).length,type);
const renderRows = async next => {
  await page.evaluate(rows=>window.__renderRows(rows),next);
  await page.waitForFunction(length=>document.querySelectorAll('[data-app-action-sidebar-thread-row]').length===length,next.length);
};
let failure;
try {
  const now = Math.floor(Date.now()/1000);
  await page.evaluate(({rows,now})=>{
    window.__snapshot={catalogSnapshot:{entries:rows.map((row,index)=>row.kind==='remote'
      ? {kind:'remote',task:{id:row.id,recencyAt:now-(index+1)*3600}}
      : {kind:'local',hostId:row.host,thread:{id:row.id,recencyAt:now-(index+1)*3600}})}};
  },{rows,now});
  await renderRows(rows);
  const originalTitle = await page.locator('[data-thread-title]').allTextContents();
  const originalKeys = await page.locator('[data-app-action-sidebar-thread-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-app-action-sidebar-thread-id')));
  const originalHeights = await page.locator('[data-app-action-sidebar-thread-row]').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
  await check('installed key and DOM attribute helpers match the inspected sidebar contract', async()=>{
    assert.deepEqual(originalKeys,[`local:${id}`,`local:${bigId}`,`local:${id}`,`remote:${id}`,`local:${missingId}`]);
    assert.deepEqual(await page.locator('[data-app-action-sidebar-thread-host-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-app-action-sidebar-thread-host-id'))),['local','local',remote,'','local']);
    assert.equal(await page.locator('[data-thread-title-trigger]').count(),rows.length);
    assert.ok(originalHeights.every(height=>height>=30));
  });
  await check('installed preload handles a synthetic local, remote and cloud snapshot', async()=>{
    const state = await install();
    assert.equal(state.provider,'desktop-bootstrap');
    assert.equal(state.badges,5); assert.equal(state.sizeBadges,2);
    assert.deepEqual(await page.locator('[data-codex-mods-time]').allTextContents(),['1h','2h','3h','4h','5h']);
    assert.deepEqual(await page.locator('[data-codex-mods-size]').allTextContents(),['2.0 MiB','2.0 GiB']);
    assert.equal(await row(`local:${id}`,remote).locator('[data-codex-mods-size]').count(),0);
    assert.equal(await row(`remote:${id}`).locator('[data-codex-mods-size]').count(),0);
  });
  await check('native nested containers, labels and row heights survive injection', async()=>{
    assert.deepEqual(await page.locator('[data-thread-title]').allTextContents(),originalTitle);
    assert.deepEqual(await page.locator('[data-app-action-sidebar-thread-row]').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height)),originalHeights);
    assert.equal(await page.locator('[data-app-action-sidebar-thread-row] > [data-codex-mods-time], [data-app-action-sidebar-thread-row] > [data-codex-mods-size]').count(),0);
    assert.equal(await local().locator('[data-codex-mods-size]').evaluate(node=>node.parentElement===node.closest('[data-app-action-sidebar-thread-row]').querySelector('[data-thread-title-trigger]').parentElement),true);
    assert.equal(await row(`local:${bigId}`,'local').evaluate(node=>node.style.getPropertyValue('--codex-mods-fill')),'100.00%');
  });
  await check('title and size clicks call the intended row callback', async()=>{
    await local().locator('[data-thread-title]').click();
    await page.locator('body').click({position:{x:650,y:400}});
    await page.mouse.move(650,400);
    const size = await local().locator('[data-codex-mods-size]').boundingBox();
    await page.mouse.click(size.x+size.width/2,size.y+size.height/2);
    assert.equal(await eventCount('select'),2);
  });
  await check('installed row keyboard and context menu handlers call fixture callbacks', async()=>{
    await local().focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Space');
    assert.equal(await eventCount('select'),4);
    await local().click({button:'right'});
    assert.equal(await eventCount('context-menu'),1);
  });
  await check('hover actions receive clicks without selecting the row', async()=>{
    await local().hover();
    assert.equal(await local().locator('[data-codex-mods-size]').evaluate(node=>getComputedStyle(node).visibility),'hidden');
    await local().getByRole('button',{name:'Replay actions'}).click();
    assert.equal(await eventCount('actions'),1); assert.equal(await eventCount('select'),4);
  });
  for (const theme of ['light','dark']) {
    await page.evaluate(theme=>window.__setTheme(theme),theme);
    await check(`${theme} uses the installed theme generator`,async()=>{
      assert.equal(await count('style[data-codex-app-themes]'),1);
      assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
      const ink=await page.locator('html').evaluate(node=>getComputedStyle(node).getPropertyValue('--app-color-text-foreground'));
      assert.ok(ink.trim());
    });
    for (const width of [240,320,480]) {
      await check(`${theme} sidebar at ${width}px keeps metadata inside native rows`,async()=>{
        await page.locator('aside').evaluate((node,width)=>{node.style.width=`${width}px`;},width);
        await page.locator('body').click({position:{x:650,y:400}});
        await page.mouse.move(650,400);
        const measurements = await page.locator('[data-codex-mods-size]').evaluateAll(nodes=>nodes.map(node=>{
          const rect=node.getBoundingClientRect(), row=node.closest('[data-app-action-sidebar-thread-row]').getBoundingClientRect();
          const title=node.parentElement.querySelector('[data-thread-title-trigger]').getBoundingClientRect();
          return {x:rect.x,right:rect.right,y:rect.y,bottom:rect.bottom,rowX:row.x,rowRight:row.right,rowY:row.y,rowBottom:row.bottom,titleRight:title.right};
        }));
        for (const m of measurements) {
          assert.ok(m.x>=m.rowX&&m.right<=m.rowRight+.5&&m.y>=m.rowY-.5&&m.bottom<=m.rowBottom+.5,JSON.stringify(m));
          assert.ok(m.titleRight<=m.x+.5,JSON.stringify(m));
        }
        assert.deepEqual(await page.locator('[data-thread-title]').allTextContents(),originalTitle);
      });
    }
    await page.locator('aside').evaluate(node=>{node.style.width='320px';});
    await page.locator('aside').screenshot({path:join(output,`${theme}.png`)});
  }
  await check('forced colors suppress the decorative background',async()=>{
    await page.emulateMedia({forcedColors:'active'});
    assert.equal(await local().evaluate(node=>getComputedStyle(node).backgroundImage),'none');
    await page.emulateMedia({forcedColors:'none'});
  });
  await check('React replacement restores badges without duplicates',async()=>{
    await renderRows(rows.slice(0,1));
    await page.waitForFunction(()=>document.querySelectorAll('[data-codex-mods-size]').length===1);
    await renderRows(rows);
    await page.waitForFunction(()=>document.querySelectorAll('[data-codex-mods-size]').length===2);
    assert.equal(await count('[data-codex-mods-time]'),5);
    assert.equal(await count('[data-codex-mods-style]'),1);
  });
  await check('React updates existing titles while preserving injected labels',async()=>{
    await renderRows(rows.map((row,index)=>index===0?{...row,title:'Updated native title'}:row));
    await page.waitForFunction(()=>document.querySelector('[data-thread-title]').textContent==='Updated native title');
    assert.equal(await count('[data-codex-mods-time]'),5);
    assert.equal(await count('[data-codex-mods-size]'),2);
    await renderRows(rows);
    await page.waitForFunction(title=>document.querySelector('[data-thread-title]').textContent===title,rows[0].title);
  });
  await check('size refresh, size-only mode and uninstall restore native DOM',async()=>{
    await page.evaluate(({id})=>globalThis.__codexModsSidebarTime.setSessionSizes({[id]:4096},null,1),{id});
    assert.deepEqual(await page.locator('[data-codex-mods-size]').allTextContents(),['4.0 KiB']);
    assert.equal((await install({showTime:false})).badges,0);
    await page.evaluate(cleanupExpression);
    assert.equal(await count('[data-codex-mods-time], [data-codex-mods-size], [data-codex-mods-fill], [data-codex-mods-style], .codex-mods-time-row'),0);
    assert.deepEqual(await page.locator('[data-thread-title]').allTextContents(),originalTitle);
    assert.equal(await count('button[aria-haspopup="menu"]'),rows.length);
    await local().locator('[data-thread-title]').click();
    assert.equal(await eventCount('select'),5);
  });
  await check('reload starts a clean renderer and permits reinjection',async()=>{
    await page.reload();
    await page.waitForFunction(()=>typeof window.__renderRows==='function');
    await renderRows(rows);
    assert.equal((await install({showTime:false})).sizeBadges,2);
    await page.evaluate(cleanupExpression);
  });
  await check('installed components emitted no uncaught runtime errors',async()=>{
    assert.deepEqual(replay.errors,[]);
    assert.ok(replay.served.has('webview/assets/app-initial-61c077dcc1af.js'));
  });
  await check('HTTP and WebSocket requests cannot leave the isolated browser',async()=>{
    const http = await page.evaluate(async()=>{
      try {await fetch('https://codex-mods.invalid/network-isolation-check');return true;} catch {return false;}
    });
    assert.equal(http,false);
    await page.evaluate(()=>new Promise(resolve=>{
      const socket=new WebSocket('wss://codex-mods.invalid/network-isolation-check');
      socket.onclose=()=>resolve();socket.onerror=()=>resolve();setTimeout(resolve,2000);
    }));
    assert.ok(replay.blocked.includes('https://codex-mods.invalid/network-isolation-check'));
    assert.ok(replay.blocked.includes('wss://codex-mods.invalid/network-isolation-check'));
  });
} catch(error) {failure=error; await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}
finally {await replay.close();}

const report = {
  passed:!failure,date:new Date().toISOString(),codexVersion:replay.version,chromiumVersion:replay.chromiumVersion,
  asar:resolve(values.asar),assetHashes:replay.hashes,checks,failed:failure?.message||null,errors:replay.errors,
  method:'Installed sidebar key and DOM attribute helpers, QOo/kOo/VDo row layout and interaction components, title, default theme generator, preload and CSS in independent headless Chromium. Rows, callbacks, snapshot and settings are fixture-supplied; IPC is inert; external HTTP and WebSocket requests are blocked.',
  limits:'Full sidebar/list wiring, actual application bootstrap data, desktop/backend integration, native menus, OS rendering and live metadata freshness are not covered.',
  blockedExternalRequests:replay.blocked.length,
};
await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
await writeFile(join(output,'report.md'),`# Installed Codex sidebar compatibility\n\n${report.passed?'PASS':'FAIL'} — Codex ${report.codexVersion}; Chromium ${report.chromiumVersion}; ${checks.length} checks.\n\n${report.method}\n\n${report.limits}\n\n${checks.map(name=>`- Passed: ${name}`).join('\n')}\n${failure?`\nFailed: ${failure.message}\n`:''}\n[Light screenshot](light.png) · [Dark screenshot](dark.png) · [Asset hashes and results](report.json)\n`);
console.log(JSON.stringify({passed:report.passed,codexVersion:report.codexVersion,checks:checks.length,report:join(output,'report.md'),failed:report.failed},null,2));
if(failure) process.exitCode=1;
