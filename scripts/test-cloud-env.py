"""Offline safety checks for the bootstrap; no downloads or package installation."""
from contextlib import ExitStack
import importlib.util
from io import BytesIO
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cloud_env', Path(__file__).with_name('cloud-env.py'))
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        for name, value in [('ROOT', root), ('APP', root / 'app'), ('STATE', root / '.tmp'),
                            ('NODE', root / '.tmp/node'), ('VENV', root / '.tmp/python')]:
            self.stack.enter_context(patch.object(cloud, name, value))
        cloud.APP.mkdir()
        cloud.environment()

    def test_private_environment_and_live_preview_are_not_inherited(self):
        with patch.dict(os.environ, {'DASHSCOPE_API_KEY': 'fictional-value', 'NODE_OPTIONS': '--fictional',
                                     'GLEAM_E2E_URL': 'https://fictional.invalid', 'NPM_CONFIG_USERCONFIG': '/fictional'}):
            env = cloud.environment()
        for name in ('DASHSCOPE_API_KEY', 'NODE_OPTIONS', 'GLEAM_E2E_URL', 'NPM_CONFIG_USERCONFIG'):
            self.assertNotIn(name, env)
        self.assertEqual(env['HOME'], str(cloud.STATE / 'home'))

    def test_local_env_is_refused_without_reading_contents(self):
        (cloud.APP / '.env.local').touch()
        with patch.object(Path, 'read_text', side_effect=AssertionError('must not read')):
            with self.assertRaisesRegex(RuntimeError, 'contents were not read'):
                cloud.no_local_env_files()

    def test_example_env_does_not_block_clean_checkout(self):
        (cloud.APP / '.env.example').touch()
        cloud.no_local_env_files()

    def test_existing_proxy_route_is_preserved_and_loopback_stays_local(self):
        with patch.dict(os.environ, {'HTTPS_PROXY': 'http://proxy.invalid:8080', 'NO_PROXY': 'example.invalid'}, clear=True):
            env = cloud.environment()
        self.assertEqual(env['HTTPS_PROXY'], 'http://proxy.invalid:8080')
        self.assertIn('example.invalid', env['NO_PROXY'].split(','))
        self.assertIn('127.0.0.1', env['NO_PROXY'].split(','))
        self.assertIn('localhost', env['no_proxy'].split(','))

    def test_missing_local_runtime_does_not_fall_back_to_preinstalled_tools(self):
        with patch.object(cloud.subprocess, 'check_output') as command:
            with self.assertRaisesRegex(RuntimeError, 'run setup'):
                cloud.versions()
        command.assert_not_called()

    def test_wrong_archive_hash_stops_before_extraction_or_install(self):
        with patch.object(cloud.platform, 'system', return_value='Linux'), \
             patch.object(cloud.platform, 'machine', return_value='x86_64'), \
             patch.object(cloud.urllib.request, 'urlopen', return_value=BytesIO(b'fictional corrupt archive')), \
             patch.object(cloud, 'run') as command:
            with self.assertRaisesRegex(RuntimeError, 'SHA-256 mismatch'):
                cloud.setup()
        command.assert_not_called()
        self.assertFalse(cloud.NODE.exists())

    def test_failed_verification_does_not_run_remaining_commands(self):
        with patch.object(cloud, 'check'), patch.object(cloud, 'run') as command:
            command.side_effect = cloud.subprocess.CalledProcessError(7, ['npm'])
            with self.assertRaises(cloud.subprocess.CalledProcessError) as caught:
                cloud.verify()
        self.assertEqual(caught.exception.returncode, 7)
        self.assertEqual(command.call_count, 1)


if __name__ == '__main__':
    unittest.main()
