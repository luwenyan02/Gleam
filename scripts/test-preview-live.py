"""Opt-in real Docker/Vite/browser preview verification, with fictional data only.

Uses a disposable local Git remote; never pushes GitHub or accesses a user's browser.
Run with the cloud Python/Playwright environment and a verified Docker context.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LEGACY_WORKER = """self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') event.respondWith(Promise.resolve(new Response(
    '<html><body>fixture old static preview</body></html>', {headers:{'Content-Type':'text/html'}})));
});"""
READ_LEDGER = """async () => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('GleamDB'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
  const tx = db.transaction(['entries','settings'], 'readonly');
  const entry = tx.objectStore('entries').get(987654);
  const setting = tx.objectStore('settings').get('preview.synthetic-marker');
  await new Promise((resolve, reject) => {tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);});
  db.close();
  return [entry.result?.amount, setting.result?.value, localStorage.getItem('preview.synthetic-marker')];
}"""


def run(args, cwd, env=None, capture=False):
    result = subprocess.run(list(map(str,args)),cwd=cwd,env=env,check=True,
                            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            text=True)
    return result.stdout.strip() if capture else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--context', required=True)
    parser.add_argument('--port', type=int, default=18769)
    args = parser.parse_args()
    base = ROOT/'.tmp/tests/preview-live'
    base.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=base) as folder:
        folder = Path(folder)
        source, remote, checkout = [folder/name for name in ('source','remote.git','checkout')]
        source.mkdir()
        for name in ('app/src','app/public','app/server','app/vendor','deploy/preview'):
            shutil.copytree(ROOT/name,source/name)
        for name in ('app/package.json','app/package-lock.json','app/vite.config.ts','app/index.html',
                     'app/tsconfig.json','scripts/preview-sync.sh','scripts/preview-local.sh',
                     'compose.preview.yaml','.dockerignore'):
            target=source/name
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(ROOT/name,target)
        (source/'.gitignore').write_text('.tmp/\napp/.env.local\n')
        # Begin with an older development configuration to simulate a static
        # PWA at this origin; the new configuration must retire /sw.js safely.
        latest_config=(source/'app/vite.config.ts').read_text()
        (source/'app/vite.config.ts').write_text(latest_config.replace(
            "import { previewWorker } from './server/previewWorker';\n",'').replace('    previewWorker(),\n',''))
        (source/'app/public/sw.js').write_text(LEGACY_WORKER)
        def git(path,*words): return run(['git','-C',path,*words],ROOT,capture=True)
        git(source,'init','-b','preview/orbstack')
        git(source,'config','user.name','Synthetic preview')
        git(source,'config','user.email','preview@example.invalid')
        git(source,'add','.')
        git(source,'commit','-m','synthetic initial preview')
        run(['git','clone','--bare',source,remote],ROOT)
        run(['git','clone',remote,checkout],ROOT)
        overlay=folder/'compose.yaml'
        image=f'gleam-preview-live-{os.getpid()}'
        overlay.write_text(f'''name: {image}
services:
  web:
    image: ${{GLEAM_PREVIEW_IMAGE:-{image}:local}}
    build:
      args:
        HTTP_PROXY: ${{HTTP_PROXY}}
        HTTPS_PROXY: ${{HTTPS_PROXY}}
        NO_PROXY: ${{NO_PROXY}}
      secrets: [proxy_ca]
    command: [node, node_modules/vite/bin/vite.js, --host, '127.0.0.1', --port, '{args.port}', --strictPort]
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:{args.port}/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
secrets:
  proxy_ca:
    file: {json.dumps(os.environ.get('CODEX_PROXY_CERT','/dev/null'))}
''')
        env={**os.environ,'GLEAM_DOCKER_CONTEXT':args.context,
             'GLEAM_PREVIEW_COMPOSE_EXTRA':str(overlay),'GLEAM_PREVIEW_NO_BROWSER':'1'}
        for key in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DASHSCOPE_API_KEY'):
            env.pop(key,None)
        (checkout/'app/.env.local').write_text('DASHSCOPE_API_KEY=synthetic-preview-only\n')
        def sync(ok=True):
            result=subprocess.run(['sh','scripts/preview-sync.sh','update'],cwd=checkout,env=env)
            assert (result.returncode==0)==ok, result.returncode
        def publish():
            git(source,'add','.')
            git(source,'commit','-m','synthetic preview update')
            commit=git(source,'rev-parse','HEAD')
            run(['git','--git-dir',remote,'fetch',source,'preview/orbstack'],ROOT)
            run(['git','--git-dir',remote,'update-ref','refs/heads/preview/orbstack',commit],ROOT)
            return commit
        def container():
            return run(['docker','--context',args.context,'compose','-f','compose.preview.yaml',
                        '-f',overlay,'ps','-q','web'],checkout,env,capture=True)
        def ledger(page): assert page.evaluate(READ_LEDGER)==[1234,'retained','retained']
        try:
            sync()
            run(['docker','--context',args.context,'exec',container(),'node','-e',
                 "if(process.env.DASHSCOPE_API_KEY!=='synthetic-preview-only')process.exit(1)"],checkout,env)
            with sync_playwright() as p:
                browser=p.chromium.launch()
                page=browser.new_page()
                page.goto(f'http://localhost:{args.port}/')
                page.locator('#fab').wait_for()
                page.evaluate("""async () => {
                  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
                  const tx=db.transaction(['entries','settings'],'readwrite');
                  tx.objectStore('entries').put({id:987654,type:'expense',amount:1234,accountId:1,categoryId:1,occurredAt:Date.now(),createdAt:Date.now(),updatedAt:Date.now(),deletedAt:0,reimburseStatus:'none'});
                  tx.objectStore('settings').put({key:'preview.synthetic-marker',value:'retained',updatedAt:Date.now()});
                  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
                  localStorage.setItem('preview.synthetic-marker','retained');
                  await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
                }""")
                page.reload()
                page.get_by_text('fixture old static preview').wait_for()
                ledger(page)
                (source/'app/public/sw.js').unlink()
                (source/'app/vite.config.ts').write_text(latest_config)
                publish()
                sync()
                page.reload()
                page.locator('#fab').wait_for(timeout=60000)
                page.wait_for_function('!navigator.serviceWorker.controller',timeout=10000)
                ledger(page)
                print('PASS old PWA → Vite, ledger/settings/localStorage retained',flush=True)
                before=container()
                css=source/'app/src/features/home/home.css'
                css.write_text(css.read_text()+'\n:root { --preview-sync-test: changed; }\n')
                publish()
                sync()
                page.wait_for_function("getComputedStyle(document.documentElement).getPropertyValue('--preview-sync-test').trim()==='changed'")
                assert container()==before,'source update recreated container'
                ledger(page)
                print('PASS real CSS HMR, same container and retained ledger',flush=True)
                good_lock=(source/'app/package-lock.json').read_text()
                (source/'app/package-lock.json').write_text(good_lock+'\n')
                good=publish()
                sync()
                assert container()!=before,'dependency update did not rebuild/recreate'
                page.reload()
                page.locator('#fab').wait_for()
                ledger(page)
                (source/'app/package-lock.json').write_text('invalid synthetic lockfile')
                bad=publish()
                sync(ok=False)
                assert git(checkout,'rev-parse','HEAD')==good
                assert git(checkout,'rev-parse','preview/orbstack')==bad
                page.reload()
                page.locator('#fab').wait_for()
                ledger(page)
                print('PASS dependency rebuild and actual failed-build recovery; ledger retained',flush=True)
                browser.close()
        finally:
            run(['docker','--context',args.context,'compose','-f','compose.preview.yaml',
                 '-f',overlay,'down'],checkout,env)


if __name__=='__main__': main()
