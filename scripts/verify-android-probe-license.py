"""Read official SDK metadata; never accept new terms automatically."""
import hashlib
import urllib.request
import xml.etree.ElementTree as ET

APPROVED = '1268aeee833b3a62463b58bd6df146b7835a0a94d8905511223ac415fe733f57'
SOURCES = [
    ('https://dl.google.com/android/repository/repository2-3.xml', 'emulator'),
    ('https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml', 'system-images;android-35;google_apis;x86_64'),
]
for url, package in SOURCES:
    with urllib.request.urlopen(url, timeout=60) as response:
        root = ET.fromstring(response.read())
    licenses = {e.attrib['id']: ''.join(e.itertext()) for e in root if e.tag.endswith('license')}
    found = [e for e in root if e.tag.endswith('remotePackage') and e.attrib.get('path') == package
             and any(c.tag.endswith('channelRef') and c.attrib.get('ref') == 'channel-0' for c in e)]
    assert found, f'Official package absent: {package}'
    for element in found:
        license_ref = next(e.attrib['ref'] for e in element if e.tag.endswith('uses-license'))
        text = ' '.join(licenses[license_ref].split())
        assert hashlib.sha256(text.encode()).hexdigest() == APPROVED, f'New/unapproved terms: {package} / {license_ref}'
    print(f'VERIFIED approved January 16, 2019 terms: {package}')
