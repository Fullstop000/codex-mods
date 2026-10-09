import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

// Private symbols are deliberately tied to this installed build. A new build
// needs a reviewed adapter; fixture success must not imply native compatibility.
const build = {
  version: '26.1002.52244',
  initial: 'webview/assets/app-initial-61c077dcc1af.js',
  shared: 'webview/assets/app-shared-6c00c2afcf84.js',
  styles: ['webview/assets/app-shared-f2d570e85ceb.css', 'webview/assets/app-initial-c43288484373.css'],
};

function openArchive(path) {
  const fd = openSync(path, 'r');
  try {
    const prefix = Buffer.alloc(16);
    assertRead(fd, prefix, 0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (headerSize < jsonSize + 8 || headerSize > 32 * 1024 ** 2) throw new Error('Unsupported ASAR header');
    const header = Buffer.alloc(jsonSize);
    assertRead(fd, header, 16);
    const index = JSON.parse(header.toString());
    return {
      read(name) {
        let entry = index;
        for (const part of name.split('/')) entry = entry?.files?.[part];
        if (!entry || entry.link || entry.unpacked || entry.offset == null) throw new Error(`Missing packed resource: ${name}`);
        const size = Number(entry.size), offset = Number(entry.offset);
        if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 ** 2 || !Number.isSafeInteger(offset) || offset < 0) throw new Error(`Invalid ASAR resource: ${name}`);
        const data = Buffer.alloc(size);
        assertRead(fd, data, 8 + headerSize + offset);
        return data;
      },
      close() { closeSync(fd); },
    };
  } catch (error) { closeSync(fd); throw error; }
}

function assertRead(fd, data, position) {
  let count = 0;
  while (count < data.length) {
    const length = readSync(fd, data, count, data.length - count, position + count);
    if (!length) throw new Error('Truncated ASAR resource');
    count += length;
  }
}

const initialExport = `
export function __codexModsReplayTheme(variant) {
  Fla();
  return lla(document, {light:Qq(null,'light',null),dark:Qq(null,'dark',null)}, variant, null);
}
export function __codexModsReplayRows(rows) {
  Gbc(); C1(); const j = Z();
  return j.jsx(j.Fragment, {children: rows.map(row => {
    const key = row.kind === 'remote' ? Ro(row.id) : yo(row.id);
    const record = type => {window.__events.push({type,key});};
    return j.jsx(QOo, {
      title: row.title,
      icon: j.jsx('span', {'aria-hidden':true, children:'◇'}),
      statusState: {type:'idle'}, envType:'local', hostId:row.host,
      variant: row.variant || 'sidebar', isActive:!!row.active,
      secondaryContent: row.secondary, wrapSecondaryContent:true,
      useStableTrailingRail:true, metaContent:'now',
      onClick:()=>record('select'), onDoubleClick:()=>record('double-click'),
      onContextMenu:event=>{event.preventDefault();record('context-menu');},
      renderActions:()=>j.jsx('div', {className:x1+' pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
        children:j.jsx('button', {type:'button','aria-label':'Replay actions', 'aria-haspopup':'menu', className:'size-5 rounded-md',
          onClick:event=>{event.stopPropagation();record('actions');}, children:'⋯'})}),
      dataAttributes:hc.sidebarThreadRow({id:key,kind:row.kind,hostId:row.host??null,active:!!row.active,pinned:false,selected:false,title:row.title}),
    }, key+':'+(row.host??''));
  })});
}
`;

const sharedExport = `
export function __codexModsReplayScope(child) {
  QP(); Ult(); Mlt(); Dst(); yji(); wji();
  const j=K(), client=new Est({defaultOptions:{queries:{enabled:false,retry:false}}});
  client.setQueryData(HG('get-settings'), {values:{},configuredValues:{}});
  return j.jsx(vji.Provider, {value:bji(),children:j.jsx(klt, {queryClient:client,children:j.jsx(Nlt, {scope:Q,children:child})})});
}
`;

export async function installedReplay(asarPath) {
  const archive = openArchive(asarPath);
  let server, browser;
  const before = statSync(asarPath);
  try {
    const pkg = JSON.parse(archive.read('package.json'));
    if (pkg.version !== build.version) throw new Error(`No installed renderer adapter for Codex ${pkg.version}; supported build: ${build.version}. Update the replay adapter before claiming compatibility.`);
    const preload = archive.read('.vite/build/preload.js').toString();
    const resources = [build.initial, build.shared, ...build.styles, '.vite/build/preload.js'];
    const hashes = Object.fromEntries(resources.map(name => [name, createHash('sha256').update(archive.read(name)).digest('hex')]));
    const served = new Set(), blocked = [], errors = [];
    const html = `<!doctype html><html data-theme="light" data-codex-window-type="electron"><head><meta charset="utf-8">
      ${build.styles.map(name => `<link rel="stylesheet" href="/${name.slice(8)}">`).join('')}
      <title>Installed Codex sidebar replay</title></head>
      <body><aside class="sidebar-navigation" data-sidebar style="width:320px;padding:12px"><div id="root"></div></aside>
      <script type="module">
        import {__codexModsReplayRows,__codexModsReplayTheme} from '/${build.initial.slice(8)}';
        import {$fn,ggn,__codexModsReplayScope} from '/${build.shared.slice(8)}';
        ggn(); const root=$fn().createRoot(document.querySelector('#root'));
        window.__setTheme=__codexModsReplayTheme;
        window.__setTheme('light');
        window.__renderRows=rows=>root.render(__codexModsReplayScope(__codexModsReplayRows(rows)));
      </script></body></html>`;
    server = createServer((request, response) => {
      try {
        const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (path === '/installed.html') { response.setHeader('content-type','text/html'); response.end(html); return; }
        if (!path.startsWith('/assets/')) { response.writeHead(404); response.end(); return; }
        const name = `webview${path}`;
        const data = archive.read(name);
        served.add(name);
        response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
        // Expose only test entry points in the response, never in the archive.
        if (name === build.initial) response.end(data.toString() + '\n' + initialExport);
        else if (name === build.shared) response.end(data.toString() + '\n' + sharedExport);
        else response.end(data);
      } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({headless:true});
    const context = await browser.newContext({viewport:{width:720,height:540},serviceWorkers:'block'});
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      blocked.push(route.request().url());
      return route.abort();
    });
    await context.routeWebSocket('**/*', socket => {
      blocked.push(socket.url());
      socket.close();
    });
    await context.addInitScript(({preload,version}) => {
      window.__events=[]; window.__nativeCalls=[]; window.__snapshot={catalogSnapshot:{entries:[]}};
      const ipc = {
        on(){}, removeListener(){}, send(){}, postMessage(){},
        sendSync(channel) {
          window.__nativeCalls.push({channel});
          if(channel.endsWith('get-sentry-init-options')) return {appVersion:version,codexAppSessionId:'isolated-replay',dsn:null};
          if(channel.endsWith('get-build-flavor')) return 'prod';
          if(channel.endsWith('get-system-theme-variant')) return 'light';
          if(channel.endsWith('get-shared-object-snapshot')) return {};
          if(channel.endsWith('get-initial-sidebar-bootstrap')) return window.__snapshot;
        },
        async invoke(channel,...args) {window.__nativeCalls.push({channel,args});return null;},
      };
      const electron={ipcRenderer:ipc,contextBridge:{exposeInMainWorld(name,value){window[name]=value;}},webUtils:{getPathForFile(){return '';}}};
      new Function('require','process',preload)(()=>electron,{platform:'darwin',arch:'arm64'});
    },{preload,version:pkg.version});
    const page = await context.newPage();
    page.on('pageerror',error=>errors.push(error.stack || error.message));
    await page.goto(origin + '/installed.html');
    await page.waitForFunction(()=>typeof window.__renderRows === 'function');
    return {
      page, context, version:pkg.version, chromiumVersion:browser.version(), hashes, errors, blocked, served,
      async close() {
        await browser.close();
        await new Promise(resolve=>server.close(resolve));
        archive.close();
        const after=statSync(asarPath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Installed archive changed during verification; replay result is stale');
      },
    };
  } catch(error) {
    await browser?.close();
    if (server?.listening) await new Promise(resolve=>server.close(resolve));
    archive.close();
    throw error;
  }
}
