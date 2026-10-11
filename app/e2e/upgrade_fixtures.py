"""Exact public-asset fixtures; APKs, signing data and app configuration stay outside Git."""
from hashlib import sha256
from html.parser import HTMLParser
from io import BytesIO
import json
from pathlib import Path
import stat
import zipfile

FIXTURES = Path(__file__).parent / 'fixtures' / 'upgrade'
SOURCES = {
    '1.10.5': ('Gleam-v1.10.5-private-ui.apk', '8a96117c98a6b62e5597e8e9cd6efd99a9d413c55f630fd0d665aef4ed063265'),
    '1.10.6': ('Gleam-v1.10.6-private-key-ui.apk', '4af334647de47770d23df6b39434353ef12ebe151ffa88ff4458787234f29933'),
}
ROOT_FILES = {
    'index.html', 'build-info.json', 'manifest.webmanifest', 'registerSW.js',
    'sw.js', 'workbox-9c191d2f.js', 'cordova.js', 'cordova_plugins.js',
}


def safe_asset_path(name):
    """Never extract to disk; still reject traversal, aliases and non-public payloads."""
    if not isinstance(name, str) or not name or '\\' in name or ':' in name or '\x00' in name:
        return False
    parts = name.split('/')
    if any(not part or part.startswith('.') for part in parts):
        return False
    if len(parts) == 1:
        return name in ROOT_FILES
    return len(parts) == 2 and (
        (parts[0] == 'assets' and Path(parts[1]).suffix in {'.js', '.css'})
        or (parts[0] == 'icons' and Path(parts[1]).suffix == '.png')
        or (parts[0] == 'manual' and (Path(parts[1]).suffix == '.png' or parts[1] == 'source.json'))
    )


def read_public_zip(data, prefix=''):
    result = {}
    with zipfile.ZipFile(BytesIO(data)) as archive:
        for entry in archive.infolist():
            if prefix and not entry.filename.startswith(prefix):
                continue
            if entry.is_dir():
                continue
            name = entry.filename[len(prefix):]
            mode = entry.external_attr >> 16
            if not safe_asset_path(name) or stat.S_ISLNK(mode):
                raise ValueError(f'Unsafe or non-public fixture asset: {name!r}')
            if name in result:
                raise ValueError(f'Duplicate fixture asset: {name}')
            result[name] = archive.read(entry)
    if not ROOT_FILES.issubset(result):
        raise ValueError('Fixture is missing required public assets')
    return result


def deterministic_zip(assets):
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(assets.items()):
            if not safe_asset_path(name):
                raise ValueError(f'Unsafe fixture asset: {name!r}')
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(entry, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return buffer.getvalue()


class ModuleParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.modules = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('type') == 'module' and attrs.get('src'):
            self.modules.append(attrs['src'])


def module_url(assets):
    parser = ModuleParser()
    parser.feed(assets['index.html'].decode('utf-8'))
    if len(parser.modules) != 1:
        raise ValueError('Expected exactly one entry module in fixture index.html')
    url = parser.modules[0]
    if not url.startswith('/') or url[1:] not in assets:
        raise ValueError(f'Missing/local-only entry module: {url!r}')
    return url


def create_fixtures(apk_directory, destination=FIXTURES):
    """Optional regeneration from the two explicitly pinned, locally supplied APKs."""
    manifest = {'format': 1, 'source_prefix': 'assets/public/', 'versions': {}}
    prepared = {}
    for version, (filename, expected_hash) in SOURCES.items():
        raw = (Path(apk_directory) / filename).read_bytes()
        if sha256(raw).hexdigest() != expected_hash:
            raise ValueError(f'Original APK hash mismatch: {filename}')
        assets = read_public_zip(raw, prefix='assets/public/')
        if json.loads(assets['build-info.json']) != {'version': version}:
            raise ValueError(f'Original APK build-info mismatch: {filename}')
        packed = deterministic_zip(assets)
        fixture = f'gleam-{version}-public.zip'
        prepared[fixture] = packed
        manifest['versions'][version] = {
            'source_apk': filename, 'source_apk_sha256': expected_hash,
            'fixture': fixture, 'fixture_sha256': sha256(packed).hexdigest(),
            'module_url': module_url(assets),
            'assets': {name: {'bytes': len(data), 'sha256': sha256(data).hexdigest()}
                       for name, data in sorted(assets.items())},
        }
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for filename, raw in prepared.items():
        (destination / filename).write_bytes(raw)
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')


def load_fixtures(directory=FIXTURES):
    directory = Path(directory)
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format') != 1 or manifest.get('source_prefix') != 'assets/public/':
        raise ValueError('Unsupported public-asset fixture manifest')
    if set(manifest['versions']) != set(SOURCES):
        raise ValueError('Unexpected fixture versions')
    loaded = {}
    for version, (filename, expected_hash) in SOURCES.items():
        item = manifest['versions'][version]
        if (item['source_apk'], item['source_apk_sha256']) != (filename, expected_hash):
            raise ValueError(f'Unverified fixture provenance: {version}')
        if item['fixture'] != f'gleam-{version}-public.zip':
            raise ValueError(f'Unsafe fixture filename: {version}')
        raw = (directory / item['fixture']).read_bytes()
        if sha256(raw).hexdigest() != item['fixture_sha256']:
            raise ValueError(f'Fixture archive hash mismatch: {version}')
        assets = read_public_zip(raw)
        actual = {name: {'bytes': len(data), 'sha256': sha256(data).hexdigest()}
                  for name, data in assets.items()}
        if actual != item['assets']:
            raise ValueError(f'Fixture asset hash mismatch: {version}')
        if json.loads(assets['build-info.json']) != {'version': version} or module_url(assets) != item['module_url']:
            raise ValueError(f'Fixture entry version/module mismatch: {version}')
        loaded[version] = assets
    return loaded


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-apks', type=Path, help='Regenerate from the two pinned local APKs; never downloads.')
    args = parser.parse_args()
    if args.from_apks:
        create_fixtures(args.from_apks)
    fixtures = load_fixtures()
    print('PASS exact public assets: ' + ', '.join(f'{version} ({len(assets)} files)' for version, assets in fixtures.items()))
