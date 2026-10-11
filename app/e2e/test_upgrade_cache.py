"""Observe exact 1.10.5 -> 1.10.6 assets on one isolated origin, without a real API.

This is a browser-cache diagnostic, not an Android package/install verification.
Intermediate versions are observations: either old or new is valid. An explicit
reload after the new worker activates must show the new version and preserve data.
"""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import re
from threading import Lock, Thread
from time import monotonic
from urllib.parse import unquote, urlsplit

from upgrade_fixtures import load_fixtures, module_url, safe_asset_path

OLD = '1.10.5'
NEW = '1.10.6'
OUT = Path(__file__).parents[2] / '.tmp' / 'tests' / 'e2e' / 'upgrade-cache'
SENTINEL = {
    'database': 'GleamUpgradeDiagnosticSynthetic',
    'store': 'markers',
    'key': 'fixture-upgrade-marker',
    'local_key': 'gleam-upgrade-diagnostic:synthetic-marker',
    'value': 'fictional-data-preserved-across-asset-upgrade',
}

# Called once, after the old app has opened. Never re-seed on reload, and never
# write ledger rows, app settings, API keys, or sessionStorage credentials.
SEED_STORAGE = """async (spec) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(spec.database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(spec.store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Synthetic marker database blocked'));
  });
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(spec.store, 'readwrite');
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error('Marker write aborted'));
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore(spec.store).put(spec.value, spec.key);
    });
  } finally { db.close(); }
  localStorage.setItem(spec.local_key, spec.value);
}"""

# Abort a missing database instead of silently creating a replacement marker.
READ_STORAGE = """async (spec) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(spec.database);
    request.onupgradeneeded = () => {
      request.transaction.abort();
      reject(new Error('Synthetic marker database disappeared'));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Synthetic marker database blocked'));
  });
  try {
    const indexedDBValue = await new Promise((resolve, reject) => {
      const transaction = db.transaction(spec.store, 'readonly');
      const request = transaction.objectStore(spec.store).get(spec.key);
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onabort = () => reject(transaction.error || new Error('Marker read aborted'));
      transaction.onerror = () => reject(transaction.error);
    });
    return {localStorage: localStorage.getItem(spec.local_key), indexedDB: indexedDBValue};
  } finally { db.close(); }
}"""

WORKER_SNAPSHOT = """async () => {
  const describe = (worker) => worker ? {scriptURL: worker.scriptURL, state: worker.state} : null;
  const registration = await navigator.serviceWorker.getRegistration();
  const cachesSeen = [];
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    const indexModules = [];
    for (const indexKey of keys.filter((key) => new URL(key.url).pathname === '/index.html')) {
      const response = await cache.match(indexKey);
      // Activation may clean an old revision between keys() and match().
      if (!response) continue;
      const html = await response.text();
      indexModules.push(new DOMParser().parseFromString(html, 'text/html')
        .querySelector('script[type="module"]')?.getAttribute('src') ?? null);
    }
    cachesSeen.push({name, indexModules, paths: keys.map((key) => new URL(key.url).pathname)});
  }
  return {
    controller: describe(navigator.serviceWorker.controller),
    registration: registration ? {
      scope: registration.scope, updateViaCache: registration.updateViaCache,
      active: describe(registration.active), waiting: describe(registration.waiting),
      installing: describe(registration.installing)
    } : null,
    controllerChangesThisDocument: window.__upgradeControllerChanges,
    updateTarget: describe(window.__upgradeWorkerUpdate?.worker),
    updateTargetIsController: window.__upgradeWorkerUpdate
      ? window.__upgradeWorkerUpdate.worker === navigator.serviceWorker.controller : null,
    updateTargetIsActive: window.__upgradeWorkerUpdate
      ? window.__upgradeWorkerUpdate.worker === registration?.active : null,
    caches: cachesSeen
  };
}"""

START_WORKER_UPDATE = """async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) throw new Error('Missing service worker before update');
  const previousActive = registration.active;
  const tracked = {worker: registration.installing || registration.waiting || previousActive};
  window.__upgradeWorkerUpdate = tracked;
  // update() can resolve before installation/activation finishes. Keep the
  // actual candidate object, including an updatefound delivered after resolve.
  registration.addEventListener('updatefound', () => {
    if (registration.installing) tracked.worker = registration.installing;
  });
  await registration.update();
  if (registration.installing || registration.waiting) {
    tracked.worker = registration.installing || registration.waiting;
  } else if (registration.active !== previousActive) {
    tracked.worker = registration.active;
  }
}"""

WAIT_FOR_WORKER = """async (expectedModule) => {
  const registration = await navigator.serviceWorker.getRegistration();
  const worker = window.__upgradeWorkerUpdate?.worker || registration?.active;
  const ready = (current) => worker && current &&
    worker.state === 'activated' && current.active === worker &&
    navigator.serviceWorker.controller === worker && !current.installing && !current.waiting &&
    (!window.__upgradeWorkerUpdate || window.__upgradeWorkerUpdate.worker === worker);
  if (!ready(registration)) return false;
  let foundExpectedIndex = false;
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const key of await cache.keys()) {
      if (new URL(key.url).pathname !== '/index.html') continue;
      const response = await cache.match(key);
      if (!response) continue;
      const html = await response.text();
      const source = new DOMParser().parseFromString(html, 'text/html')
        .querySelector('script[type="module"]')?.getAttribute('src');
      // During installation both revisions can coexist. An already-completed
      // automatic update is acceptable only after old index revisions are gone.
      if (source !== expectedModule) return false;
      foundExpectedIndex = true;
    }
  }
  // New precache entries alone do not prove activation. Any await above can
  // change installation state or the active/controller pair.
  return foundExpectedIndex && !!ready(await navigator.serviceWorker.getRegistration());
}"""


def wait_for_worker(page, expected_module, timeout_ms=30000):
    # Playwright 1.59 wait_for_function treats the returned Promise as truthy
    # before it resolves: an async predicate resolving false stops its polling.
    # page.evaluate awaits the actual boolean; poll that value explicitly.
    # https://github.com/microsoft/playwright/blob/v1.59.0/packages/playwright-core/src/server/frames.ts#L1397-L1409
    deadline = monotonic() + timeout_ms / 1000
    while monotonic() < deadline:
        if page.evaluate(WAIT_FOR_WORKER, expected_module) is True:
            return
        remaining_ms = (deadline - monotonic()) * 1000
        if remaining_ms > 0:
            page.wait_for_timeout(min(100, remaining_ms))
    raise AssertionError(f'Service worker did not become ready for {expected_module} within {timeout_ms} ms')


def request_asset_path(target):
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith('/') or parsed.path.startswith('//'):
        raise ValueError('Only origin-relative asset paths are served')
    path = unquote(parsed.path)[1:] or 'index.html'
    if not safe_asset_path(path):
        raise ValueError('Invalid public asset path')
    return path


def same_origin(url, origin):
    target, expected = urlsplit(url), urlsplit(origin)
    return (target.scheme, target.netloc) == (expected.scheme, expected.netloc)


class AssetState:
    def __init__(self, fixtures):
        self.fixtures = fixtures
        self.version = OLD
        self.requests = []
        self.lock = Lock()

    def replace(self, version):
        if version not in self.fixtures:
            raise ValueError(f'Unknown asset version: {version}')
        with self.lock:
            self.version = version

    def response(self, target):
        path = request_asset_path(target)
        with self.lock:
            version = self.version
            data = self.fixtures[version].get(path)
            self.requests.append({'target': target, 'version': version, 'found': data is not None})
        return path, data

    def served(self, target):
        with self.lock:
            return [dict(item) for item in self.requests if item['target'] == target]


@contextmanager
def serve_assets(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            try:
                path, data = state.response(self.path)
            except ValueError:
                self.send_error(400)
                return
            if data is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', mimetypes.guess_type(path)[0] or 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            # Match the read-only prototype: revalidate original assets. Explicit
            # build-info probes additionally bypass the HTTP cache in the browser.
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/'
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def about_version(page):
    if page.locator('#sp-settings').count() == 0:
        page.locator('#fab').wait_for(state='visible')
        page.locator('[data-page="page-mine"]').click()
        page.get_by_role('button', name='应用设置', exact=True).click()
    about = page.locator('#sp-settings section[aria-label="关于"] .field .sub')
    about.wait_for(state='visible')
    text = about.inner_text().strip()
    match = re.fullmatch(r'v(\d+\.\d+\.\d+)', text)
    if not match:
        raise AssertionError(f'Unexpected rendered About version: {text!r}')
    return match.group(1)


def validate_snapshot(snapshot, fixtures, served_version, required_version=None):
    phase = snapshot['phase']
    version = snapshot['about_version']
    assert version in fixtures, f'{phase}: unexpected About version {version}'
    if required_version:
        assert version == required_version, f'{phase}: expected {required_version}, saw {version}'
    assert snapshot['module_url'] == module_url(fixtures[version]), f'{phase}: About/module mismatch'
    assert snapshot['markers'] == {'localStorage': SENTINEL['value'], 'indexedDB': SENTINEL['value']}, f'{phase}: marker loss'
    worker = snapshot['service_worker']
    assert worker['controller'] is not None, f'{phase}: no controlling service worker'
    assert worker['registration'] is not None, f'{phase}: no worker registration'
    if phase == 'after_worker_update_without_explicit_reload':
        assert worker['updateTarget']['state'] == 'activated', f'{phase}: update target not activated'
        assert worker['updateTargetIsController'] and worker['updateTargetIsActive'], f'{phase}: update target not controlling/active'
        assert not worker['registration']['installing'] and not worker['registration']['waiting'], f'{phase}: update still pending'
    build = snapshot['build_info_no_cache']
    assert build['status'] == 200 and build['body'] == {'version': served_version}, f'{phase}: stale build-info probe'
    assert build['cache_mode'] == 'no-store', f'{phase}: build-info probe did not bypass HTTP cache'
    assert build['server_requests'] and all(
        request['found'] and request['version'] == served_version for request in build['server_requests']
    ), f'{phase}: no fresh server evidence for build-info'
    assert not any('/build-info.json' in cache['paths'] for cache in worker['caches']), f'{phase}: build-info unexpectedly cached'


def snapshot(page, state, phase, navigations):
    version = about_version(page)
    target = f'/build-info.json?upgrade-cache-probe={phase}'
    build_info = page.evaluate("""async (target) => {
      const response = await fetch(target, {cache: 'no-store'});
      return {status: response.status, body: await response.json(),
              cache_mode: 'no-store', cache_control: response.headers.get('cache-control')};
    }""", target)
    build_info['server_requests'] = state.served(target)
    result = {
        'phase': phase, 'server_asset_version': state.version,
        'about_version': version,
        'module_url': page.locator('script[type="module"]').get_attribute('src'),
        'main_frame_navigations': len(navigations),
        'markers': page.evaluate(READ_STORAGE, SENTINEL),
        'service_worker': page.evaluate(WORKER_SNAPSHOT),
        'build_info_no_cache': build_info,
    }
    print('UPGRADE_CACHE ' + json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
    return result


def run_diagnostic(browser, origin, state, report):
    context = browser.new_context(service_workers='allow', viewport={'width': 390, 'height': 844}, reduced_motion='reduce')
    external = report['blocked_nonlocal_requests']

    def local_only(route):
        if same_origin(route.request.url, origin):
            route.continue_()
        else:
            external.append(route.request.url)
            route.abort('blockedbyclient')

    def no_websocket(route):
        external.append(route.url)
        route.close()

    # Use the broadest browser-context routing guard, including popups. Requests
    # handled internally by a service worker are not all route-interceptable;
    # the pinned worker uses only these same-origin assets. Inspect its caches
    # separately and never supply application/API configuration or credentials.
    context.route('**/*', local_only)
    context.route_web_socket('**/*', no_websocket)
    context.add_init_script("""window.__upgradeControllerChanges = 0;
      navigator.serviceWorker.addEventListener('controllerchange', () => window.__upgradeControllerChanges++);
    """)
    page = context.new_page()
    page.set_default_timeout(15000)
    navigations = []
    page.on('framenavigated', lambda frame: navigations.append(frame.url) if frame == page.main_frame else None)
    page.on('pageerror', lambda error: report['page_errors'].append(str(error)))

    def record(phase, served_version, required_version=None):
        value = snapshot(page, state, phase, navigations)
        report['phases'].append(value)
        validate_snapshot(value, state.fixtures, served_version, required_version)
        return value

    try:
        page.goto(origin, wait_until='load')
        page.locator('#fab').wait_for(state='visible')
        wait_for_worker(page, module_url(state.fixtures[OLD]))
        page.evaluate(SEED_STORAGE, SENTINEL)
        record('old_loaded', OLD, OLD)

        state.replace(NEW)
        page.reload(wait_until='load')
        first = record('first_navigation_after_asset_replacement', NEW)

        # The app/worker may already have updated. Do not require stale behavior.
        page.evaluate(START_WORKER_UPDATE)
        wait_for_worker(page, module_url(state.fixtures[NEW]))
        record('after_worker_update_without_explicit_reload', NEW)

        page.reload(wait_until='load')
        record('second_explicit_navigation', NEW, NEW)
        assert not external, f'Unexpected nonlocal requests were blocked: {external}'
        assert not report['page_errors'], report['page_errors']
        report['stale_first_navigation_observed'] = first['about_version'] == OLD
        report['outcome'] = 'passed'
    finally:
        context.close()


def main():
    # Import lazily so fixture/unit verification never starts a browser or server.
    from playwright.sync_api import sync_playwright
    report = {
        'kind': 'exact-public-assets-browser-diagnostic',
        'scope': 'Isolated localhost browser only; Android versionCode/install state not tested.',
        'outcome': 'failed', 'phases': [], 'blocked_nonlocal_requests': [], 'page_errors': [],
    }
    try:
        state = AssetState(load_fixtures())
        with serve_assets(state) as origin, sync_playwright() as playwright:
            browser = playwright.chromium.launch(args=['--disable-background-networking'])
            try:
                report['browser_version'] = browser.version
                run_diagnostic(browser, origin, state, report)
            finally:
                browser.close()
        print('PASS exact-asset upgrade; stale first navigation observed: '
              + str(report['stale_first_navigation_observed']), flush=True)
        return 0
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    raise SystemExit(main())
