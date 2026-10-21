"""The browser-suite coordinator must never turn a child failure into a green run."""
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stderr
from io import StringIO
from unittest.mock import Mock, patch
import run_all


class RunnerResultTests(unittest.TestCase):
    def run_case(self, codes, tests=('first.py', 'second.py'), args=()):
        calls = []
        def run(argv, **kwargs):
            calls.append(argv[-1].rsplit('/', 1)[-1])
            return subprocess.CompletedProcess(argv, codes[len(calls) - 1])
        with patch.object(run_all, 'TESTS', tests), patch.object(run_all, 'server_ready', return_value=True), patch.object(run_all.subprocess, 'run', side_effect=run):
            result = run_all.main(args)
        return result, calls

    def test_runs_remaining_suites_after_failure_and_never_captures_publishable_preview(self):
        result, calls = self.run_case([2, 0])
        self.assertNotEqual(result, 0)
        self.assertEqual(calls, ['first.py', 'second.py'])

    def test_multiple_failures_remain_failure(self):
        result, calls = self.run_case([1, 3])
        self.assertNotEqual(result, 0)
        self.assertEqual(calls, ['first.py', 'second.py'])

    def test_success_runs_publishable_capture_and_preserves_its_failure(self):
        for code in (0, 4):
            with self.subTest(code=code):
                result, calls = self.run_case([0, 0, code])
                self.assertEqual(result, code)
                self.assertEqual(calls, ['first.py', 'second.py', 'capture_readme.py'])

    def test_four_shards_execute_every_real_suite_once_in_original_order(self):
        shards = [run_all.select_tests(index, 4) for index in range(1, 5)]
        flattened = [test for shard in shards for test in shard]
        self.assertCountEqual(flattened, run_all.TESTS)
        self.assertEqual(len(set(flattened)), len(run_all.TESTS))
        self.assertLessEqual(max(map(len, shards)) - min(map(len, shards)), 1)
        positions = {name: index for index, name in enumerate(run_all.TESTS)}
        for shard in shards:
            self.assertEqual([positions[name] for name in shard], sorted(positions[name] for name in shard))

    def test_default_selection_keeps_complete_suite(self):
        self.assertEqual(run_all.select_tests(1, 1), run_all.TESTS)

    def test_first_shard_alone_captures_preview_and_other_shard_runs_its_suites(self):
        tests = ('first.py', 'second.py', 'third.py', 'fourth.py')
        result, calls = self.run_case([0, 0, 0], tests, ('--shard-index', '1', '--shard-count', '2'))
        self.assertEqual(result, 0)
        self.assertEqual(calls, ['first.py', 'third.py', 'capture_readme.py'])
        result, calls = self.run_case([0, 0], tests, ('--shard-index', '2', '--shard-count', '2'))
        self.assertEqual(result, 0)
        self.assertEqual(calls, ['second.py', 'fourth.py'])

    def test_sharded_failures_run_remaining_selected_suites_and_never_capture(self):
        result, calls = self.run_case([3, 1], ('first.py', 'second.py', 'third.py'),
                                      ('--shard-index', '1', '--shard-count', '2'))
        self.assertEqual(result, 1)
        self.assertEqual(calls, ['first.py', 'third.py'])

    def test_invalid_or_empty_shards_fail_before_server_or_children_start(self):
        cases = [('0', '4'), ('5', '4'), ('1', '0'), ('1', '-1'), ('1', '999'), ('wrong', '4')]
        for index, count in cases:
            with self.subTest(index=index, count=count), redirect_stderr(StringIO()), \
                 patch.object(run_all, 'server_ready') as ready, \
                 patch.object(run_all.subprocess, 'Popen') as start, \
                 patch.object(run_all.subprocess, 'run') as child:
                with self.assertRaises(SystemExit) as error:
                    run_all.main(('--shard-index', index, '--shard-count', count))
                self.assertEqual(error.exception.code, 2)
                ready.assert_not_called()
                start.assert_not_called()
                child.assert_not_called()

    def test_cli_forwards_shard_arguments_before_preview_startup(self):
        # An unavailable explicit URL also prevents starting a preview if CLI
        # argument forwarding regresses, without recursively running this suite.
        result = subprocess.run(
            [sys.executable, run_all.__file__, '--shard-index', '0', '--shard-count', '4'],
            env={**os.environ, 'GLEAM_E2E_URL': 'http://127.0.0.1:1/'},
            capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn('shard-index must be between 1 and shard-count', result.stderr)

    def test_owned_server_closes_after_child_failure(self):
        server = Mock()
        server.poll.return_value = None
        with patch.object(run_all, 'TESTS', ('first.py',)), \
             patch.object(run_all, 'server_ready', return_value=False), \
             patch.object(run_all, 'EXTERNAL_URL', False), \
             patch.object(run_all, 'wait_for_server'), \
             patch.object(run_all.subprocess, 'Popen', return_value=server), \
             patch.object(run_all.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)):
            self.assertEqual(run_all.main(), 1)
        server.terminate.assert_called_once_with()
        server.wait.assert_called_once_with(timeout=5)

    def test_owned_server_is_killed_when_cleanup_wait_expires_after_child_exception(self):
        server = Mock()
        server.poll.return_value = None
        server.wait.side_effect = subprocess.TimeoutExpired('preview', 5)
        with patch.object(run_all, 'TESTS', ('first.py',)), \
             patch.object(run_all, 'server_ready', return_value=False), \
             patch.object(run_all, 'EXTERNAL_URL', False), \
             patch.object(run_all, 'wait_for_server'), \
             patch.object(run_all.subprocess, 'Popen', return_value=server), \
             patch.object(run_all.subprocess, 'run', side_effect=RuntimeError('synthetic child error')):
            with self.assertRaisesRegex(RuntimeError, 'synthetic child error'):
                run_all.main()
        server.terminate.assert_called_once_with()
        server.kill.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
