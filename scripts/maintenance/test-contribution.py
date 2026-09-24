#!/usr/bin/env python3
"""Behavioral checks for the contributor-facing PR validator."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('check_pr', Path(__file__).with_name('check-pr.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

BODY = '''## Problem
Expired grants could still invoke a component after a policy change.
## Changes
Revoke admitted grants when the permission ceiling changes.
## Validation
Runtime regression suite passed with a retained invocation fixture.
## Compatibility and risks
Existing tool schemas are unchanged; the Gateway needs a restart after update.
## Related issues
Closes #12
## Checklist
- [x] Contribution rules followed.
- [x] Complete diff reviewed.
- [x] Validation accurately reported.
- [x] No internal or private material included.
'''


class ContributionChecks(unittest.TestCase):
    def test_completed_pr(self):
        self.assertEqual(check.validate('fix(runtime): revoke expired grants', BODY), [])

    def test_small_standalone_change(self):
        body = BODY.replace('Closes #12', 'None — fixes a typo in the existing startup command.')
        self.assertEqual(check.validate('docs: correct the startup command', body), [])

    def test_feature_needs_discussion(self):
        self.assertTrue(check.validate('feat: add a new adapter', BODY.replace('Closes #12', 'None — standalone addition.')))

    def test_template_is_not_evidence(self):
        template = Path(__file__).resolve().parents[2] / '.github/pull_request_template.md'
        self.assertTrue(check.validate('fix: update behavior', template.read_text()))

    def test_missing_or_placeholder_section(self):
        for replacement in ['', '<!-- Tests passed -->', 'TODO', 'N/A']:
            body = BODY.replace('Runtime regression suite passed with a retained invocation fixture.', replacement)
            self.assertTrue(check.validate('fix: update behavior', body))

    def test_unchecked_confirmation(self):
        self.assertTrue(check.validate('fix: update behavior', BODY.replace('- [x]', '- [ ]', 1)))

    def test_headings_in_code_are_not_sections(self):
        self.assertTrue(check.validate('fix: update behavior', '```markdown\n' + BODY + '```\n'))

    def test_commands_need_result_prose(self):
        body = BODY.replace('Runtime regression suite passed with a retained invocation fixture.', '```sh\npnpm test\n```')
        self.assertTrue(check.validate('fix: update behavior', body))

    def test_duplicate_sections(self):
        self.assertTrue(check.validate('fix: update behavior', BODY + '\n## Changes\nA second description.'))

    def test_title_has_a_scope_and_outcome(self):
        self.assertTrue(check.validate('update', BODY))
        self.assertEqual(check.validate('fix(host)!: update the protocol', BODY), [])


if __name__ == '__main__':
    unittest.main()
