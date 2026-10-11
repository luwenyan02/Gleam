"""Socket-free verification for the exact-asset browser diagnostic and fixture safety."""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

import test_upgrade_cache as diagnostic
from upgrade_fixtures import (
    FIXTURES, SOURCES, create_fixtures, deterministic_zip, load_fixtures,
    module_url, read_public_zip, safe_asset_path,
)


class FixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = load_fixtures()

    def test_archive_and_every_asset_match_recorded_hashes(self):
        manifest = json.loads((FIXTURES / 'manifest.json').read_text())
        for version, assets in self.fixtures.items():
            with self.subTest(version=version):
                item = manifest['versions'][version]
                self.assertEqual(len(assets), 28)
                self.assertEqual(json.loads(assets['build-info.json']), {'version': version})
                self.assertEqual(item['source_apk_sha256'], SOURCES[version][1])
                self.assertIn(version.encode(), assets[module_url(assets)[1:]])
                self.assertNotIn(b'build-info.json', assets['sw.js'])
                packed = (FIXTURES / item['fixture']).read_bytes()
                self.assertEqual(sha256(packed).hexdigest(), item['fixture_sha256'])
                for name, data in assets.items():
                    self.assertEqual(sha256(data).hexdigest(), item['assets'][name]['sha256'])
                    self.assertEqual(len(data), item['assets'][name]['bytes'])

    def test_archives_are_deterministic_and_have_no_apk_or_signature_payload(self):
        for version, assets in self.fixtures.items():
            with self.subTest(version=version):
                packed = deterministic_zip(assets)
                self.assertEqual(packed, deterministic_zip(dict(reversed(list(assets.items())))))
                # Repacking with the same Python/zlib version is deterministic.
                # Different zlib releases may encode DEFLATE differently; exact
                # checked-in bytes are independently pinned by the manifest.
                with zipfile.ZipFile(BytesIO(packed)) as archive:
                    self.assertEqual(archive.namelist(), sorted(assets))
                    for item in archive.infolist():
                        self.assertEqual(item.date_time, (1980, 1, 1, 0, 0, 0))
                        self.assertTrue(safe_asset_path(item.filename))
                        self.assertFalse(item.filename.endswith(('.apk', '.jks', '.keystore')))
                        self.assertFalse(item.filename.startswith(('META-INF/', 'assets/public/')))
                        self.assertNotIn('capacitor.config', item.filename)
                        self.assertEqual(archive.read(item), assets[item.filename])

    def test_unsafe_or_nonpublic_paths_are_rejected(self):
        for name in ('/index.html', '../index.html', 'assets/../secret.js', 'assets//x.js',
                     'assets/.secret.js', 'assets/x/../../x.js', 'assets\\x.js',
                     'C:/index.html', 'file:index.html', 'assets/x.js\x00',
                     'META-INF/CERT.RSA', 'capacitor.config.json', 'settings.json',
                     'assets/key.pem', 'data/GleamDB', ''):
            with self.subTest(name=name):
                self.assertFalse(safe_asset_path(name))
                with self.assertRaises(ValueError):
                    deterministic_zip({name: b'fictional'})

    def test_symlinks_and_duplicate_paths_are_rejected(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink):
                buffer = BytesIO()
                with zipfile.ZipFile(buffer, 'w') as archive:
                    item = zipfile.ZipInfo('index.html')
                    item.create_system = 3
                    if symlink:
                        item.external_attr = (stat.S_IFLNK | 0o777) << 16
                    archive.writestr(item, b'fictional')
                    if not symlink:
                        import warnings
                        with warnings.catch_warnings():
                            warnings.simplefilter('ignore', UserWarning)
                            archive.writestr('index.html', b'fictional duplicate')
                with self.assertRaisesRegex(ValueError, 'Unsafe|Duplicate'):
                    read_public_zip(buffer.getvalue())

    def test_corruption_is_rejected_before_browser_startup(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            for source in FIXTURES.glob('*.json'):
                (target / source.name).write_bytes(source.read_bytes())
            for source in FIXTURES.glob('*.zip'):
                (target / source.name).write_bytes(source.read_bytes() + b'corrupted')
            with self.assertRaisesRegex(ValueError, 'archive hash mismatch'):
                load_fixtures(target)

    def test_fixture_generation_refuses_unverified_original_apk(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / SOURCES['1.10.5'][0]).write_bytes(b'fictional unverified apk')
            target = root / 'output'
            with self.assertRaisesRegex(ValueError, 'Original APK hash mismatch'):
                create_fixtures(root, target)
            self.assertFalse(target.exists())


class DiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = load_fixtures()

    def test_one_state_changes_assets_without_changing_url(self):
        state = diagnostic.AssetState(self.fixtures)
        target = '/build-info.json?upgrade-cache-probe=test'
        self.assertEqual(json.loads(state.response(target)[1]), {'version': '1.10.5'})
        state.replace('1.10.6')
        self.assertEqual(json.loads(state.response(target)[1]), {'version': '1.10.6'})
        self.assertEqual([item['version'] for item in state.served(target)], ['1.10.5', '1.10.6'])
        # The server never reaches backward into the old package for missing files.
        self.assertIsNone(state.response(module_url(self.fixtures['1.10.5']))[1])

    def test_server_rejects_traversal_and_absolute_targets_without_a_socket(self):
        self.assertEqual(diagnostic.request_asset_path('/'), 'index.html')
        self.assertEqual(diagnostic.request_asset_path('/sw.js?update=1'), 'sw.js')
        for path in ('//evil.example/sw.js', 'https://evil.example/sw.js', '/../sw.js',
                     '/%2e%2e/sw.js', '/assets/%2e%2e/sw.js', '/assets%5csecret.js', '/settings.json'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                diagnostic.request_asset_path(path)

    def test_network_guard_allows_only_exact_test_origin(self):
        origin = 'http://127.0.0.1:49876/'
        self.assertTrue(diagnostic.same_origin(origin + 'sw.js', origin))
        for url in ('https://127.0.0.1:49876/sw.js', 'http://127.0.0.1:49877/sw.js',
                    'http://localhost:49876/sw.js', 'https://example.com/',
                    'http://127.0.0.1:49876@evil.example/sw.js', 'file:///tmp/example',
                    'data:text/plain,example', 'http://user@127.0.0.1:49876/sw.js'):
            with self.subTest(url=url):
                self.assertFalse(diagnostic.same_origin(url, origin))

    def test_marker_is_synthetic_and_separate_from_app_database(self):
        self.assertNotEqual(diagnostic.SENTINEL['database'], 'GleamDB')
        self.assertIn('Synthetic', diagnostic.SENTINEL['database'])
        self.assertTrue(diagnostic.SENTINEL['local_key'].startswith('gleam-upgrade-diagnostic:'))
        self.assertNotIn('apiKey', json.dumps(diagnostic.SENTINEL))
        self.assertIn("transaction.oncomplete = resolve", diagnostic.SEED_STORAGE)
        self.assertIn("'readonly'", diagnostic.READ_STORAGE)
        self.assertIn('request.transaction.abort()', diagnostic.READ_STORAGE)
        self.assertNotIn('.put(', diagnostic.READ_STORAGE)
        self.assertNotIn('localStorage.setItem', diagnostic.READ_STORAGE)

    def make_snapshot(self, version):
        return {
            'phase': 'fixture', 'about_version': version, 'module_url': module_url(self.fixtures[version]),
            'markers': {'localStorage': diagnostic.SENTINEL['value'], 'indexedDB': diagnostic.SENTINEL['value']},
            'service_worker': {'controller': {'state': 'activated'}, 'registration': {'active': {'state': 'activated'}},
                               'caches': [{'paths': ['/index.html']}]},
            'build_info_no_cache': {'status': 200, 'body': {'version': '1.10.6'}, 'cache_mode': 'no-store',
                                    'server_requests': [{'version': '1.10.6', 'found': True}]},
        }

    def test_intermediate_observation_allows_old_or_new_without_assuming_reproduction(self):
        for version in self.fixtures:
            diagnostic.validate_snapshot(self.make_snapshot(version), self.fixtures, '1.10.6')
        with self.assertRaisesRegex(AssertionError, 'expected 1.10.6'):
            diagnostic.validate_snapshot(self.make_snapshot('1.10.5'), self.fixtures, '1.10.6', '1.10.6')
        diagnostic.validate_snapshot(self.make_snapshot('1.10.6'), self.fixtures, '1.10.6', '1.10.6')

    def test_storage_loss_stale_probe_and_module_mismatch_fail(self):
        original = self.make_snapshot('1.10.6')
        variants = []
        for marker in ('localStorage', 'indexedDB'):
            value = deepcopy(original)
            value['markers'][marker] = None
            variants.append(value)
        value = deepcopy(original)
        value['module_url'] = module_url(self.fixtures['1.10.5'])
        variants.append(value)
        value = deepcopy(original)
        value['build_info_no_cache']['server_requests'] = []
        variants.append(value)
        value = deepcopy(original)
        value['build_info_no_cache']['body']['version'] = '1.10.5'
        variants.append(value)
        value = deepcopy(original)
        value['service_worker']['caches'][0]['paths'].append('/build-info.json')
        variants.append(value)
        for index, value in enumerate(variants):
            with self.subTest(case=index), self.assertRaises(AssertionError):
                diagnostic.validate_snapshot(value, self.fixtures, '1.10.6')

    def test_no_browser_or_socket_required_for_import_and_fixture_checks(self):
        with patch.object(diagnostic, 'ThreadingHTTPServer', side_effect=AssertionError('No sockets in unit tests')):
            self.assertEqual(set(load_fixtures()), {'1.10.5', '1.10.6'})


class WorkerActivationTests(unittest.TestCase):
    """Run the actual async browser helper against controlled, socket-free objects."""

    def wait_result(self, scenario):
        harness = r"""
const fs = require('node:fs');
const {script, scenario} = JSON.parse(fs.readFileSync(0, 'utf8'));
const oldWorker = {state: 'activated', scriptURL: 'http://local/sw.js'};
const newWorker = {state: 'activated', scriptURL: 'http://local/sw.js'};
const replacement = {state: 'activated', scriptURL: 'http://local/sw.js'};
const registration = {active: newWorker, installing: null, waiting: null};
const serviceWorker = {controller: newWorker, getRegistration: async () => registration};
global.window = {__upgradeWorkerUpdate: {worker: newWorker}};
Object.defineProperty(globalThis, 'navigator', {value: {serviceWorker}, configurable: true});
let mutateDuringRead = () => {};
if (scenario === 'install_starts_during_cache_read') {
  registration.active = oldWorker;
  serviceWorker.controller = oldWorker;
  window.__upgradeWorkerUpdate.worker = oldWorker;
  mutateDuringRead = () => {
    newWorker.state = 'installing';
    registration.installing = newWorker;
    window.__upgradeWorkerUpdate.worker = newWorker;
  };
} else if (scenario === 'controller_still_old') {
  serviceWorker.controller = oldWorker;
} else if (scenario === 'controller_activating') {
  newWorker.state = 'activating';
} else if (scenario === 'identity_changes_during_cache_read') {
  mutateDuringRead = () => {
    registration.active = replacement;
    serviceWorker.controller = replacement;
    window.__upgradeWorkerUpdate.worker = replacement;
  };
} else if (scenario === 'failed_new_worker_left_populated_cache') {
  newWorker.state = 'redundant';
  registration.active = oldWorker;
  serviceWorker.controller = oldWorker;
} else if (scenario === 'stable_initial_worker') {
  delete window.__upgradeWorkerUpdate;
}
const cache = {
  keys: async () => scenario === 'old_and_new_index_coexist'
    ? [{url: 'http://local/index.html?revision=old'}, {url: 'http://local/index.html?revision=new'}]
    : [{url: 'http://local/index.html?revision=new'}],
  match: async (key) => ({text: async () => {
    mutateDuringRead();
    return key.url.includes('revision=old') ? '<old-fixture>' : '<fixture>';
  }})
};
global.caches = {keys: async () => ['fixture-cache'], open: async () => cache};
global.DOMParser = class {
  parseFromString(html) {return {querySelector: () => ({getAttribute: () => html === '<old-fixture>' ? '/assets/old.js' : '/assets/new.js'})};}
};
(async () => {
  const result = await eval('(' + script + ')')('/assets/new.js');
  process.stdout.write(JSON.stringify(result));
})().catch((error) => {console.error(error); process.exitCode = 1;});
"""
        completed = subprocess.run(
            ['node', '-e', harness],
            input=json.dumps({'script': diagnostic.WAIT_FOR_WORKER, 'scenario': scenario}),
            text=True, capture_output=True, check=True, timeout=10,
        )
        return json.loads(completed.stdout)

    def test_update_tracker_keeps_actual_candidate_through_lifecycle_timing(self):
        harness = r"""
const fs = require('node:fs');
const {script, scenario} = JSON.parse(fs.readFileSync(0, 'utf8'));
const oldWorker = {state: 'activated'};
const newWorker = {state: 'installing'};
let listener;
const registration = {
  active: oldWorker, installing: null, waiting: null,
  addEventListener: (name, callback) => {
    if (name !== 'updatefound') throw new Error('Unexpected event ' + name);
    listener = callback;
  },
  update: async () => {
    if (scenario === 'late_updatefound' || scenario === 'already_activated') return;
    registration.installing = newWorker;
    listener();
    if (scenario === 'failed_install') {
      registration.installing = null;
      newWorker.state = 'redundant';
    } else if (scenario === 'activation_during_update') {
      registration.installing = null;
      newWorker.state = 'activated';
      registration.active = newWorker;
    }
  }
};
if (scenario === 'already_activated') {
  newWorker.state = 'activated';
  registration.active = newWorker;
}
global.window = {};
Object.defineProperty(globalThis, 'navigator', {
  value: {serviceWorker: {getRegistration: async () => registration}}, configurable: true
});
(async () => {
  await eval('(' + script + ')')();
  if (scenario === 'late_updatefound') {
    registration.installing = newWorker;
    listener();
  }
  process.stdout.write(JSON.stringify(window.__upgradeWorkerUpdate.worker === newWorker));
})().catch((error) => {console.error(error); process.exitCode = 1;});
"""
        for scenario in ('installing', 'late_updatefound', 'already_activated',
                         'activation_during_update', 'failed_install'):
            with self.subTest(scenario=scenario):
                result = subprocess.run(
                    ['node', '-e', harness],
                    input=json.dumps({'script': diagnostic.START_WORKER_UPDATE, 'scenario': scenario}),
                    text=True, capture_output=True, check=True, timeout=10,
                )
                self.assertTrue(json.loads(result.stdout))

    def test_rechecks_installation_after_awaited_cache_reads(self):
        self.assertFalse(self.wait_result('install_starts_during_cache_read'))

    def test_new_active_worker_must_also_control_this_document(self):
        self.assertFalse(self.wait_result('controller_still_old'))

    def test_activating_controller_is_not_ready_for_reload(self):
        self.assertFalse(self.wait_result('controller_activating'))

    def test_worker_identity_must_stay_the_same_through_cache_inspection(self):
        self.assertFalse(self.wait_result('identity_changes_during_cache_read'))

    def test_failed_new_worker_cannot_pass_using_its_partial_cache(self):
        self.assertFalse(self.wait_result('failed_new_worker_left_populated_cache'))

    def test_coexisting_old_and_new_cache_does_not_prove_completed_update(self):
        self.assertFalse(self.wait_result('old_and_new_index_coexist'))

    def test_exact_new_worker_activated_and_controlling_page_passes(self):
        self.assertTrue(self.wait_result('stable_updated_worker'))

    def test_initial_worker_without_update_tracking_can_become_ready(self):
        self.assertTrue(self.wait_result('stable_initial_worker'))


class WorkerPollingIntegrationTests(unittest.TestCase):
    def test_async_false_is_polled_until_evaluate_resolves_true(self):
        page = Mock()
        # Playwright 1.59 treats an async predicate's Promise as truthy, stops
        # polling, and returns its resolved false value without raising.
        page.wait_for_function.return_value = False
        page.evaluate.side_effect = [False, False, True]
        diagnostic.wait_for_worker(page, '/assets/new.js', timeout_ms=1000)
        self.assertEqual(page.evaluate.call_count, 3)
        page.wait_for_function.assert_not_called()
        self.assertEqual(page.wait_for_timeout.call_count, 2)

    def test_a_never_ready_async_result_times_out_instead_of_passing(self):
        page = Mock()
        page.wait_for_function.return_value = False
        page.evaluate.return_value = False
        with self.assertRaisesRegex(AssertionError, 'did not become ready'):
            diagnostic.wait_for_worker(page, '/assets/new.js', timeout_ms=0)
        page.wait_for_function.assert_not_called()

    def test_evaluation_failure_remains_a_test_failure(self):
        page = Mock()
        page.wait_for_function.return_value = False
        page.evaluate.side_effect = RuntimeError('synthetic cache inspection failed')
        with self.assertRaisesRegex(RuntimeError, 'cache inspection failed'):
            diagnostic.wait_for_worker(page, '/assets/new.js', timeout_ms=1000)


if __name__ == '__main__':
    unittest.main()
