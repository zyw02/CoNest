#!/usr/bin/env python3
"""Check PR metadata from a GitHub event; never execute or print user-supplied content."""
import json
import os
import re
import sys
from pathlib import Path

SECTIONS = ('Problem', 'Changes', 'Validation', 'Compatibility and risks', 'Related issues', 'Checklist')
TITLE = re.compile(r'^(feat|fix|docs|test|refactor|perf|build|ci|chore|revert)(\([a-z0-9][a-z0-9/-]*\))?!?: \S.+$')


def validate(title, body):
    errors = []
    if not TITLE.fullmatch(title):
        errors.append('Use a PR title such as fix(runtime): describe the outcome.')
    # Comments and fenced code cannot masquerade as completed section headings or checkboxes.
    cleaned = re.sub(r'<!--.*?(?:-->|\Z)', '', body, flags=re.S)
    sections = {}
    current = None
    fence = None
    for line in cleaned.splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            token = marker.group(1)
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        if fence:
            continue
        heading = re.fullmatch(r'##\s+(.+?)\s*', line)
        if heading:
            current = heading.group(1)
            if current in sections:
                errors.append('Do not duplicate required PR sections.')
            sections[current] = []
        elif current:
            sections[current].append(line)
    for name in SECTIONS:
        content = '\n'.join(sections.get(name, [])).strip()
        if not content or content.lower() in {'todo', 'tbd', 'n/a', 'none', '...'}:
            errors.append(f'Complete the {name} section with a concrete explanation.')
    related = '\n'.join(sections.get('Related issues', []))
    linked = re.search(r'\b(?:Closes:?|Related:)\s+(?:[\w.-]+/[\w.-]+)?#\d+\b', related, re.I)
    standalone = re.search(r'\bNone\s*[—–-]\s*\S.+', related, re.I)
    if not linked and not standalone:
        errors.append('Link an issue with Closes #123 or Related: #123, or explain None — reason.')
    if (title.startswith('feat') or '!: ' in title) and not linked:
        errors.append('Features and breaking changes require a linked issue.')
    checklist = '\n'.join(sections.get('Checklist', []))
    if len(re.findall(r'^\s*- \[[xX]\] \S', checklist, re.M)) < 4 or re.search(r'^\s*- \[ \]', checklist, re.M):
        errors.append('Complete all four PR checklist confirmations.')
    return errors


def main():
    event_path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('GITHUB_EVENT_PATH')
    if not event_path:
        raise SystemExit('Provide a GitHub pull_request event JSON file.')
    event = json.loads(Path(event_path).read_text())
    pr = event.get('pull_request')
    if not pr:
        raise SystemExit('Expected a pull_request event.')
    if pr.get('draft'):
        print('Draft PR: complete the template before requesting review.')
        return
    errors = validate(pr.get('title', ''), pr.get('body') or '')
    if errors:
        raise SystemExit('\n'.join(errors))
    print('PR metadata checks passed; maintainer review of content and evidence is still required.')


if __name__ == '__main__':
    main()
