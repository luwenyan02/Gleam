"""The browser-suite coordinator must never turn a child failure into a green run."""
import subprocess
import unittest
from unittest.mock import patch
import run_all


class RunnerResultTests(unittest.TestCase):
    def run_case(self, codes):
        calls = []
        def run(argv, **kwargs):
            calls.append(argv[-1].rsplit('/', 1)[-1])
            return subprocess.CompletedProcess(argv, codes[len(calls) - 1])
        with patch.object(run_all, 'TESTS', ('first.py', 'second.py')), patch.object(run_all, 'server_ready', return_value=True), patch.object(run_all.subprocess, 'run', side_effect=run):
            result = run_all.main()
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


if __name__ == '__main__':
    unittest.main()
