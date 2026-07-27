# dev-refactor Firefox CI regression

## Investigation

1. Inspected the first failing `dev-refactor` browser matrix run.
2. Reproduced both Firefox failures locally.
3. Compared the new cross-browser tests with the last Chromium-only branch.
4. Verified the failures shared a focus-sensitive test setup.
5. Replaced programmatic focus and synthetic typing in the affected cases
   with Playwright user interactions.
6. Re-ran the full browser suite in Firefox, Chromium, and WebKit.

## Root cause

Vitest runs tests inside a browser frame. In Firefox, programmatic
`EditorView.focus()` did not make `document.hasFocus()` true, so CodeMirror
correctly treated the editor as unfocused. The focus-gated completion refresh
and statement gutter therefore remained inactive. One typing test also used a
synthetic transaction that did not exercise Firefox's real input path.

## Resolution

The completion browser tests now click the editor through `userEvent`, restore
the intended cursor, and type through a real keyboard event. The tall-editor
browser test now isolates virtualization instead of depending on iframe-level
document focus. The hidden-until-focused policy remains covered in the
deterministic editor unit suite. Production focus checks were not weakened.

The final push also exposed a separate workflow configuration error: CodeQL
completed analysis but could not upload SARIF because the security job had no
`security-events` permission. The job now has scoped read access to actions and
contents plus write access to security events.

The cross-browser matrix then exposed an independent timing race in the worker
crash fixture. A shared 250 ms limit covered startup, queueing, and execution,
allowing a loaded Firefox runner to report `queue-timeout` before the deliberate
worker crash became active. Failure tests now retain the real 4-second
startup/queue allowances while using a 1-second execution deadline.

## Verification

- Firefox: 18 passed
- Chromium: 18 passed
- WebKit: 18 passed
- TypeScript: passed
- Oxlint: passed
- CodeQL SARIF upload permissions: corrected

## Retrospective

Cross-browser focus behavior should be tested with browser-driven interaction.
Programmatic DOM focus is insufficient evidence when production code depends
on `document.hasFocus()`.
