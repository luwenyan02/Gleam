# Exact public-asset upgrade fixtures

These fixtures preserve the **original bytes** of every file under
`assets/public/` in two verified historical Android APKs. They are deliberately
not rebuilt from current source. The archive roots are the public paths after
stripping that prefix. Both contain 28 files (about 0.91 MB compressed each).

`manifest.json` records the pinned original APK names/hashes, ZIP hashes, main
module URLs, and each public asset's byte length and SHA-256. `upgrade_fixtures.py`
verifies them before a browser starts. ZIP entries are sorted with fixed 1980
ZIP timestamps, regular-file modes, and DEFLATE level 9; regeneration is stable
with the same Python/zlib toolchain. File contents are unchanged across toolchains.

Only public web assets are included. No APK, Android manifest/native libraries,
APK signatures, signing keys, private Capacitor configuration, or user databases
are copied. Images in the original public manual use fictional demonstration data.
The fixtures live under `e2e/`, outside Vite's source/public inputs, and are not
packaged into the app.

## Checks

From `app/`:

```sh
python e2e/upgrade_fixtures.py
python e2e/test_upgrade_cache_unit.py
python e2e/test_upgrade_cache.py
```

The unit tests use the Python standard library and Node.js to execute mocked
JavaScript lifecycle checks. They start no socket or browser. The browser diagnostic requires the repository's pinned Playwright and
installed Chromium. It does not use `GLEAM_E2E_URL`, a user's browser profile, an
existing preview, or the user's real app storage.

The diagnostic serves these unmodified assets from one ephemeral localhost
origin, changes that server's active asset map from 1.10.5 to 1.10.6, and allows
the original service workers to run. It logs four phases:

1. Old package loaded, with the old main script and About version asserted
2. First explicit navigation after replacement
3. Worker update/activation without another test-initiated reload; the tracked
   update candidate must be activated and be both the active worker and page
   controller, rechecked after asynchronous cache inspection; old index revisions
   must be gone. Async checks are polled via awaited `page.evaluate`, because
   Playwright 1.59 `wait_for_function` treats a returned Promise as truthy before
   its boolean resolves.
4. Second explicit navigation, which must show the new script and About version

Every phase reports the rendered About version, main module URL, worker/controller
states, cached index module, and a `cache: 'no-store'` build-info probe confirmed
against the local server's request log. `build-info.json` must not appear in the
worker's Cache Storage. A fictional marker in a separate IndexedDB database and a
separate localStorage key is written once and must survive every phase. This
checks isolated browser storage preservation, **not migration of real ledger rows**.

Fresh browser-context routing blocks nonlocal requests; WebSockets are closed.
Service-worker-internal requests are not all route-interceptable, so the worker
itself is retained as the verified, same-origin-only original. No API settings,
keys, cloud accounts, real data, or production cache changes are involved.

Intermediate old/new versions are observations, not forced expected outcomes.
The diagnostic passes whether or not stale first-navigation behavior reproduces,
provided the explicit reload after activation reaches 1.10.6 and storage survives.
It prints observed evidence and writes `.tmp/tests/e2e/upgrade-cache/report.json`.
It cannot establish Android's installed versionName/versionCode or prove that a
particular phone installed the new APK. Actual browser execution must be reported
separately from fixture/unit checks.

## Optional exact regeneration

Place the two original APKs outside the checkout, then run:

```sh
python e2e/upgrade_fixtures.py --from-apks /path/to/original-apks
```

No download or network operation is performed. Regeneration refuses any source
whose SHA-256 differs from the hashes pinned in `upgrade_fixtures.py`. The APKs
and other files outside their public web directory remain outside this fixture.
