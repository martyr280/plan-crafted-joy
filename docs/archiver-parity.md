# Order Mail classifier: parity with the desktop Email Archiver v4.5.2

`src/lib/archiver/classify.ts` is a line-for-line port of the desktop engine
(`archiver-lib.ps1`: Classify-Candidate, Update-LearnedFromResults,
Invoke-LearnedPromotion and their helpers). It must make the same decision as
the desktop app on the same input until NDI signs off the cutover.

## Evidence (8 Oct 2026)

Differential run, PowerShell 7.4 engine vs this module, same knowledge files
(desktop G: copy of 5 Oct: 521 learned senders, 237 domains, 181 content
rules, 2 internal routes, 4 mapping rows) plus 3 test multi-folder rules:

| Input set | Cases | Team + copies | Confidence, source, evidence, rule, stem, folder |
| --- | --- | --- | --- |
| 292 real emails from the desktop run log + 3,002 generated | 3,294 | 100% (config A: production) | 100% |
| same | 3,294 | 100% (config B: ignored_domains = ndiof.com) | 100% |
| Learning + domain promotion over those decisions | 1,114 / 999 learn events | 783 senders, 267 domains, 26 promotions identical | n/a |

The only differences are in the Unrouted explanation text when three teams tie
at the same score: PowerShell orders equal scores by hashtable order, so the
runner-up named in the message can differ. The decision (Unrouted) is the same.

## Regression test

`src/lib/archiver/__tests__/classify.test.ts` replays `fixtures/v452/golden.json`
(98 cases × 2 configs, expected values produced by the PowerShell engine) on
every test run. Do not edit the golden file by hand.

## Semantics kept on purpose

- Case-insensitive customer keys and learned keys (PowerShell hashtables).
- Banker's rounding for confidence (`Math.Round`).
- `.NET` inline regex flags `(?i)`/`(?im)` translated to JS flags.
- Mapping domain ties between two teams cancel; learned domains are ignored
  when that domain's learned senders file to more than one team.
- Content-only senders (`ndiconnect@ndiof.com`) route by message content only and
  are never learned.
