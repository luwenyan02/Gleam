"""Exercise the actual embedded signer parsers, including observed build-tools output."""
import ast
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent

class FixtureSignerTests(unittest.TestCase):
    def test_both_embedded_parsers(self):
        for name in ('build-android-install-replace-fixtures.sh', 'run-android-install-replace-fixtures.sh'):
            text = (ROOT / name).read_text()
            source = text.split('def fixture_signer(text):', 1)[1].split('\nfor stage', 1)[0]
            parsed = ast.parse('def fixture_signer(text):' + source)
            module = ast.Module(body=[parsed.body[0]], type_ignores=[])
            namespace = {'re': re}
            exec(compile(module, name, 'exec'), namespace)
            parse = namespace['fixture_signer']
            fingerprint = '02509ed9d68e8a06ff0c6cf5be2abb3591aa6a092eb216152476a89efcba4a65'
            actual = f'V2 Signer: certificate DN: C=US, O=Android, CN=Android Debug\nV2 Signer: certificate SHA-256 digest: {fingerprint}\n'
            self.assertEqual(fingerprint, parse(actual), name)
            numbered = f'Signer #1 certificate SHA-256 digest: {fingerprint}\n'
            self.assertEqual(fingerprint, parse(numbered), name)
            self.assertEqual(fingerprint, parse(actual + numbered), name)
            for invalid in ('', actual.replace(fingerprint, 'bad'), actual.replace('V2 Signer:', 'unknown:'),
                            actual + f'Signer #2 certificate SHA-256 digest: {"f" * 64}\n'):
                with self.assertRaises(AssertionError, msg=name):
                    parse(invalid)

if __name__ == '__main__':
    unittest.main()
