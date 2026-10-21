"""全历史扫描回归；只使用临时 Git 仓库与运行时生成的合成凭据。"""
import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = ROOT / '.tmp/tests/history-secrets'
HELPER = ROOT / 'scripts/check-history-secrets.py'


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args],
                                   stderr=subprocess.DEVNULL, text=True).strip()


class HistorySecretsTests(unittest.TestCase):
    def setUp(self):
        TEST_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        git(self.repo, 'init', '-b', 'main')
        git(self.repo, 'config', 'user.name', 'History fixture')
        git(self.repo, 'config', 'user.email', 'history@example.invalid')
        self.write('README.md', 'synthetic fixture\n')
        self.commit()
        self.value = 'ghp_' + ''.join(secrets.choice('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') for _ in range(36))

    def load(self):
        self.assertTrue(HELPER.is_file(), 'history scanning helper is missing')
        spec = importlib.util.spec_from_file_location('history_secrets', HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def binary(self, module):
        candidates = [module.CACHE_BINARY, ROOT / '.tmp/cache/gitleaks/gitleaks']
        for candidate in candidates:
            if candidate.is_file() and hashlib.sha256(candidate.read_bytes()).hexdigest() == module.BINARY_SHA256:
                return candidate
        return module.ensure_binary()

    def write(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def commit(self):
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-m', 'synthetic fixture')
        return git(self.repo, 'rev-parse', 'HEAD')

    def add_secret(self, name='fixture.txt', suffix=''):
        self.write(name, 'github_token = "' + self.value + '"' + suffix + '\n')
        return self.commit()

    def run_scan(self, expected, repo=None, module=None, binary=None):
        module = module or self.load()
        binary = binary or self.binary(module)
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(module, 'ensure_binary', return_value=binary):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = module.main(['--repo', str(repo or self.repo)])
        output = stdout.getvalue() + stderr.getvalue()
        self.assertFalse(self.value in output, 'synthetic credential leaked in diagnostics')
        self.assertEqual(result, expected, 'unexpected scanner status (diagnostics suppressed)')
        return output

    def test_clean_history_passes(self):
        self.run_scan(0)

    def test_deleted_secret_fails_with_clean_head(self):
        commit = self.add_secret()
        (self.repo / 'fixture.txt').unlink()
        self.commit()
        output = self.run_scan(1)
        self.assertIn(commit, output)
        self.assertIn('fixture.txt', output)
        self.assertIn('github-pat', output)

    def test_merge_only_secret_is_scanned(self):
        git(self.repo, 'checkout', '-b', 'side')
        self.write('side.txt', 'safe side\n')
        self.commit()
        git(self.repo, 'checkout', 'main')
        self.write('main.txt', 'safe main\n')
        self.commit()
        git(self.repo, 'merge', 'side', '--no-commit', '--no-ff')
        commit = self.add_secret()
        self.assertIn(commit, self.run_scan(1))

    def test_shallow_clone_fails_closed(self):
        self.write('second.txt', 'clean\n')
        self.commit()
        clone = self.root / 'shallow'
        subprocess.run(['git', 'clone', '--depth=1', self.repo.as_uri(), str(clone)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.assertIn('shallow', self.run_scan(2, repo=clone).lower())

    def test_inline_allow_cannot_hide_secret(self):
        self.add_secret(suffix=' # gitleaks:allow')
        self.run_scan(1)

    def test_repository_and_environment_config_cannot_disable_defaults(self):
        self.write('.gitleaks.toml', '[allowlist]\npaths = [".*"]\n')
        self.add_secret()
        with mock.patch.dict(os.environ, {'GITLEAKS_CONFIG': str(self.repo / '.gitleaks.toml'),
                                          'GITLEAKS_CONFIG_TOML': '[allowlist]\npaths = [".*"]'}):
            self.run_scan(1)

    def test_exact_ignore_does_not_hide_new_commit_in_same_path(self):
        commit = self.add_secret('app/e2e/upgrade_fixtures.py')
        self.write('.gitleaksignore', commit + ':app/e2e/upgrade_fixtures.py:github-pat:1\n')
        self.commit()
        self.run_scan(1)
        self.value = 'ghp_' + ''.join(secrets.choice('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') for _ in range(36))
        new_commit = self.add_secret('app/e2e/upgrade_fixtures.py')
        self.assertIn(new_commit, self.run_scan(1))

    def test_ignore_policy_rejects_extra_fingerprint_path_or_rule(self):
        module = self.load()
        policy = self.root / 'policy'
        for extra in ['a' * 40 + ':fixture.txt:github-pat:1', 'app/e2e/', 'github-pat']:
            policy.write_text(module.IGNORE_POLICY.read_text() + extra + '\n')
            with mock.patch.object(module, 'IGNORE_POLICY', policy):
                self.run_scan(2, module=module)

    def test_bare_repo_and_audit_refs_are_scanned(self):
        git(self.repo, 'checkout', '-b', 'audit-fixture')
        commit = self.add_secret()
        git(self.repo, 'update-ref', 'refs/audit/fixture', commit)
        git(self.repo, 'checkout', 'main')
        git(self.repo, 'branch', '-D', 'audit-fixture')
        bare = self.root / 'repo.git'
        subprocess.run(['git', 'clone', '--mirror', str(self.repo), str(bare)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.assertIn(commit, self.run_scan(1, repo=bare))

    def test_secret_only_in_commit_message_fails(self):
        git(self.repo, 'commit', '--allow-empty', '-m', 'github_token = "' + self.value + '"')
        commit = git(self.repo, 'rev-parse', 'HEAD')
        output = self.run_scan(1)
        self.assertIn(commit, output)
        self.assertIn('commit-message', output)

    def test_secret_only_in_annotated_tag_message_fails(self):
        git(self.repo, 'tag', '-a', 'synthetic-tag', '-m', 'github_token = "' + self.value + '"')
        self.assertIn('tag-message', self.run_scan(1))

    def test_annotated_tag_only_in_audit_ref_is_scanned(self):
        git(self.repo, 'tag', '-a', 'synthetic-tag', '-m', 'github_token = "' + self.value + '"')
        oid = git(self.repo, 'rev-parse', 'refs/tags/synthetic-tag')
        git(self.repo, 'update-ref', 'refs/audit/tags/synthetic-tag', oid)
        git(self.repo, 'update-ref', '-d', 'refs/tags/synthetic-tag')
        self.assertIn('tag-message', self.run_scan(1))

    def test_nested_annotated_tag_without_inner_ref_is_scanned(self):
        git(self.repo, 'tag', '-a', 'inner-tag', '-m', 'github_token = "' + self.value + '"')
        inner_oid = git(self.repo, 'rev-parse', 'refs/tags/inner-tag')
        git(self.repo, 'tag', '-a', 'outer-tag', '-m', 'clean outer annotation', 'inner-tag')
        git(self.repo, 'update-ref', '-d', 'refs/tags/inner-tag')
        output = self.run_scan(1)
        self.assertIn('tag-message', output)
        self.assertIn(inner_oid, output)

    def test_deleted_binary_signing_path_fails_with_clean_head(self):
        names = ['synthetic.jks', 'synthetic.pfx', 'synthetic.pkcs12', 'synthetic.key',
                 'id_rsa', 'id_ecdsa', 'id_ed25519', '.secrets/fixture.bin']
        for name in names:
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'\0not real signing material\0')
        commit = self.commit()
        for name in names:
            (self.repo / name).unlink()
        self.commit()
        output = self.run_scan(1)
        self.assertIn('forbidden-history-path', output)
        self.assertIn(commit, output)
        for name in names:
            self.assertIn(name, output)

    def test_explicit_environment_example_path_passes(self):
        self.write('app/.env.example', 'PUBLIC_URL=https://example.invalid\n')
        self.commit()
        self.run_scan(0)

    def test_scan_error_does_not_print_process_output(self):
        module = self.load()
        binary = self.binary(module)
        original_run = module.subprocess.run

        def fail_scan(command, **kwargs):
            if str(command[0]) == str(binary):
                return subprocess.CompletedProcess(command, 7, self.value, self.value)
            return original_run(command, **kwargs)

        with mock.patch.object(module.subprocess, 'run', side_effect=fail_scan):
            self.run_scan(2, module=module, binary=binary)

    def test_corrupt_cached_binary_is_rejected(self):
        module = self.load()
        candidate = self.root / 'gitleaks'
        candidate.write_bytes(b'corrupt fixture')
        with mock.patch.object(module, 'CACHE_BINARY', candidate):
            with self.assertRaises(module.ScanError):
                module.ensure_binary()

    def test_archive_hash_is_checked_before_extraction(self):
        module = self.load()
        candidate = self.root / 'download/gitleaks'
        with mock.patch.object(module, 'CACHE_BINARY', candidate), \
             mock.patch.object(module.urllib.request, 'urlopen', return_value=io.BytesIO(b'bad archive')):
            with self.assertRaises(module.ScanError):
                module.ensure_binary()
        self.assertFalse(candidate.exists())


if __name__ == '__main__':
    unittest.main()
