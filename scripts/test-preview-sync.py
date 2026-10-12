"""预览同步回归：真实本地 Git 远端与 Docker 命令替身，不联网、不推送用户仓库。"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = ROOT / '.tmp/tests/preview-sync'

DOCKER = '''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
log = Path(os.environ['GLEAM_TEST_DOCKER_LOG'])
with log.open('a') as f:
    f.write(json.dumps({'args':args,'image':os.environ.get('GLEAM_PREVIEW_IMAGE')})+'\\n')
if args[:1] == ['--context']: args = args[2:]
if args[:1] == ['compose']:
    if 'ps' in args: print('fixture-web')
    if 'up' in args:
        head = subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
        if head == os.environ.get('GLEAM_TEST_FAIL_SHA'): sys.exit(7)
elif args[:1] == ['inspect']: print('sha256:' + 'a'*64)
elif args[:2] == ['image','inspect']: print('sha256:' + 'a'*64)
elif args[:1] == ['info']: print('fixture-daemon')
'''


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], text=True, stderr=subprocess.DEVNULL).strip()


class PreviewSyncTests(unittest.TestCase):
    def setUp(self):
        TEST_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        git(self.source, 'init', '-b', 'preview/orbstack')
        git(self.source, 'config', 'user.name', 'Preview fixture')
        git(self.source, 'config', 'user.email', 'preview@example.invalid')
        for name in ['scripts/preview-sync.sh', 'scripts/preview-local.sh', 'compose.preview.yaml']:
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if (ROOT / name).exists(): shutil.copy2(ROOT / name, target)
        for name, value in {'.gitignore':'.tmp/\napp/.env.local\n',
                            'app/package.json':'{"name":"fixture"}\n',
                            'app/package-lock.json':'{"lockfileVersion":3}\n',
                            'app/src/view.txt':'initial', 'app/vite.config.ts':'initial'}.items():
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(value)
        git(self.source, 'add', '.')
        git(self.source, 'commit', '-m', 'fixture initial')
        self.initial = git(self.source, 'rev-parse', 'HEAD')
        self.remote = self.root / 'remote.git'
        subprocess.run(['git','clone','--bare',str(self.source),str(self.remote)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.local = self.root / 'local'
        subprocess.run(['git','clone',str(self.remote),str(self.local)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.bin / 'docker').write_text(DOCKER)
        (self.bin / 'docker').chmod(0o755)
        self.log = self.root / 'docker.jsonl'
        self.env = {**os.environ, 'PATH':f'{self.bin}:{os.environ["PATH"]}',
                    'GLEAM_DOCKER_CONTEXT':'fixture', 'GLEAM_TEST_DOCKER_LOG':str(self.log),
                    'GLEAM_PREVIEW_NO_BROWSER':'1', 'GIT_CONFIG_NOSYSTEM':'1'}

    def run_sync(self, action='update', ok=True, env=None):
        result = subprocess.run(['sh','scripts/preview-sync.sh',action],cwd=self.local,
                                env={**self.env, **(env or {})},capture_output=True,text=True)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return result

    def publish(self, file='app/src/view.txt', value='updated'):
        if value is None: (self.source/file).unlink()
        else: (self.source/file).write_text(value)
        git(self.source,'add',file)
        git(self.source,'commit','-m','fixture update')
        commit = git(self.source,'rev-parse','HEAD')
        # 修改本地测试用 bare 远端；不进行 GitHub push。
        subprocess.run(['git','--git-dir',str(self.remote),'fetch',str(self.source),'preview/orbstack'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['git','--git-dir',str(self.remote),'update-ref','refs/heads/preview/orbstack',commit],check=True)
        return commit

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def ups(self):
        return [call for call in self.calls() if 'up' in call['args']]

    def test_initial_start_and_same_version_do_not_rebuild_twice(self):
        self.run_sync()
        self.assertIn('--build',self.ups()[-1]['args'])
        self.run_sync()
        self.assertNotIn('--build',self.ups()[-1]['args'])
        self.assertNotIn('--force-recreate',self.ups()[-1]['args'])

    def test_source_update_is_fast_forward_and_hot_reload(self):
        self.run_sync()
        (self.local/'app/.env.local').write_text('SYNTHETIC_LOCAL_SETTING=retained\n')
        marker = self.local/'.tmp/browser-data-marker'
        marker.write_text('retained')
        commit = self.publish()
        self.run_sync()
        self.assertEqual(git(self.local,'rev-parse','HEAD'),commit)
        self.assertEqual((self.local/'app/src/view.txt').read_text(),'updated')
        self.assertEqual(marker.read_text(),'retained')
        self.assertTrue((self.local/'app/.env.local').is_file())
        self.assertNotIn('--build',self.ups()[-1]['args'])
        self.assertNotIn('--force-recreate',self.ups()[-1]['args'])
        backups = list((self.local/'.tmp/preview-sync/backups').glob('*/source.tar.gz'))
        self.assertTrue(backups)
        subprocess.run(['tar','-tzf',str(backups[-1])],check=True,stdout=subprocess.DEVNULL)

    def test_dependency_change_rebuilds(self):
        self.run_sync()
        self.publish('app/package-lock.json','{"lockfileVersion":3,"changed":true}\n')
        self.run_sync()
        self.assertIn('--build',self.ups()[-1]['args'])

    def test_single_file_mount_change_recreates_without_build(self):
        self.run_sync()
        self.publish('app/vite.config.ts','changed')
        self.run_sync()
        self.assertIn('--force-recreate',self.ups()[-1]['args'])
        self.assertNotIn('--build',self.ups()[-1]['args'])

    def test_uncommitted_file_is_preserved(self):
        (self.local/'app/src/view.txt').write_text('local edit')
        self.publish()
        self.run_sync(ok=False)
        self.assertEqual((self.local/'app/src/view.txt').read_text(),'local edit')
        self.assertEqual(git(self.local,'rev-parse','HEAD'),self.initial)
        self.assertEqual(self.ups(),[])

    def test_staged_file_is_preserved(self):
        (self.local/'app/src/view.txt').write_text('staged edit')
        git(self.local,'add','app/src/view.txt')
        before = git(self.local,'diff','--cached')
        self.run_sync(ok=False)
        self.assertEqual(git(self.local,'diff','--cached'),before)

    def test_untracked_file_is_preserved(self):
        (self.local/'notes.txt').write_text('local notes')
        self.run_sync(ok=False)
        self.assertEqual((self.local/'notes.txt').read_text(),'local notes')

    def test_wrong_branch_is_not_switched(self):
        git(self.local,'switch','-c','my-work')
        self.run_sync(ok=False)
        self.assertEqual(git(self.local,'branch','--show-current'),'my-work')

    def test_local_only_commit_is_not_overwritten(self):
        git(self.local,'config','user.name','Preview fixture')
        git(self.local,'config','user.email','preview@example.invalid')
        (self.local/'notes.txt').write_text('committed local work')
        git(self.local,'add','notes.txt')
        git(self.local,'commit','-m','local fixture')
        local = git(self.local,'rev-parse','HEAD')
        self.publish()
        self.run_sync(ok=False)
        self.assertEqual(git(self.local,'rev-parse','HEAD'),local)

    def test_remote_rewind_is_rejected(self):
        self.run_sync()
        commit = self.publish()
        self.run_sync()
        subprocess.run(['git','--git-dir',str(self.remote),'update-ref','refs/heads/preview/orbstack',self.initial],check=True)
        self.run_sync(ok=False)
        self.assertEqual(git(self.local,'rev-parse','HEAD'),commit)

    def test_failed_start_recovers_source_and_image_without_reset(self):
        self.run_sync()
        commit = self.publish('app/package-lock.json','changed dependency')
        result = self.run_sync(ok=False,env={'GLEAM_TEST_FAIL_SHA':commit})
        self.assertIn('已恢复',result.stdout + result.stderr)
        self.assertEqual(git(self.local,'rev-parse','HEAD'),self.initial)
        self.assertEqual(git(self.local,'rev-parse','preview/orbstack'),commit)
        self.assertTrue(git(self.local,'branch','--show-current').startswith('preview-recovery/'))
        self.assertTrue(self.ups()[-1]['image'].startswith('gleam-preview:backup-'))

    def test_rejected_version_stays_on_recovery_until_new_release(self):
        self.run_sync()
        bad = self.publish()
        self.run_sync(ok=False,env={'GLEAM_TEST_FAIL_SHA':bad})
        self.run_sync()
        self.assertEqual(git(self.local,'rev-parse','HEAD'),self.initial)
        good = self.publish(value='fixed')
        self.run_sync()
        self.assertEqual(git(self.local,'rev-parse','HEAD'),good)
        self.assertEqual(git(self.local,'branch','--show-current'),'preview/orbstack')

    def test_manual_rollback_preserves_new_commit(self):
        self.run_sync()
        newer = self.publish()
        self.run_sync()
        self.run_sync('rollback')
        self.assertEqual(git(self.local,'rev-parse','HEAD'),self.initial)
        self.assertEqual(git(self.local,'rev-parse','preview/orbstack'),newer)
        self.assertNotIn('--build',self.ups()[-1]['args'])

    def test_lock_blocks_duplicate_update(self):
        lock = self.local/'.git/gleam-preview-sync.lock'
        lock.mkdir()
        self.run_sync(ok=False)
        self.assertTrue(lock.is_dir())
        self.assertEqual(self.ups(),[])

    def test_failed_fetch_does_not_change_source_or_running_preview(self):
        self.run_sync()
        count = len(self.ups())
        git(self.local,'remote','set-url','origin',str(self.root/'missing.git'))
        self.run_sync(ok=False)
        self.assertEqual(git(self.local,'rev-parse','HEAD'),self.initial)
        self.assertEqual(len(self.ups()),count)

    def test_bootstrap_clones_once_and_reuses_checkout(self):
        bootstrap = ROOT/'deploy/preview/bootstrap/preview-bootstrap.sh'
        self.assertTrue(bootstrap.is_file(),'尚未实现 bootstrap')
        folder = self.root/'bootstrap with spaces'
        folder.mkdir()
        shutil.copy2(bootstrap,folder/bootstrap.name)
        env = {**self.env,'GLEAM_PREVIEW_GIT_URL':str(self.remote)}
        for attempt in range(2):
            if attempt: env.pop('GLEAM_PREVIEW_GIT_URL')
            result = subprocess.run(['sh',str(folder/bootstrap.name),'update'],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(git(folder/'checkout','branch','--show-current'),'preview/orbstack')
        self.assertNotIn('--build',self.ups()[-1]['args'])

    def test_self_update_uses_stable_runner(self):
        self.run_sync()
        self.publish('scripts/preview-sync.sh',(self.source/'scripts/preview-sync.sh').read_text()+'\n# fixture runner update\n')
        self.run_sync()
        self.assertEqual(git(self.local,'status','--porcelain'),'')

    def test_bootstrap_preserves_existing_non_git_folder(self):
        folder = self.root/'bootstrap'
        folder.mkdir()
        bootstrap = folder/'preview-bootstrap.sh'
        shutil.copy2(ROOT/'deploy/preview/bootstrap/preview-bootstrap.sh',bootstrap)
        (folder/'checkout').mkdir()
        note = folder/'checkout/notes.txt'
        note.write_text('local notes')
        result = subprocess.run(['sh',str(bootstrap)],env=self.env,capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(note.read_text(),'local notes')
        self.assertEqual(self.ups(),[])

    def test_broken_self_update_is_rejected_before_mutation(self):
        self.run_sync()
        count = len(self.ups())
        self.publish('scripts/preview-sync.sh','if then\n')
        self.run_sync(ok=False)
        self.assertEqual(git(self.local,'rev-parse','HEAD'),self.initial)
        self.assertEqual(len(self.ups()),count)

    def test_missing_start_helper_is_rejected_before_mutation(self):
        self.run_sync()
        count = len(self.ups())
        self.publish('scripts/preview-local.sh',None)
        self.run_sync(ok=False)
        self.assertEqual(git(self.local,'rev-parse','HEAD'),self.initial)
        self.assertEqual(len(self.ups()),count)


if __name__ == '__main__':
    unittest.main()
