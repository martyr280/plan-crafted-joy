# Order Mail classifier: parity with the desktop Email Archiver (v4.5.2, then v4.5.3 below)

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

# v4.5.3 (26 Oct 2026)

The web copy now follows `archiver-lib.ps1` v4.5.3 (desktop copy of 22 Oct 2026).

## What changed (search the PowerShell for "v4.5.3")

| Desktop | Web |
| --- | --- |
| `internal_domains` (default `ndiof.com` when absent) + `ignored_domains` = our own people (Get-InternalDomains) | `own_domains` is the one setting; the importer maps `internal_domains` onto it. `ignored_domains` still counts. |
| Learned DOMAIN overlay never answers for a colleague; the person's own learned sender still does | `classify`: `senderInternal` gate on the learned-domain and split-domain branches |
| Colleagues quoted in a thread are never context evidence | context stage skips body addresses at `internalDomains + ignoredDomains` |
| External-floor test uses `senderInternal` | same (only the Unrouted explanation text changes for colleagues) |
| Colleagues never auto-learned; internal domains never promoted | `updateLearnedFromResults` / `promoteLearnedDomains` take `internalDomains` |
| `ignore_internal_replies` (default on): a colleague's `RE:` (not `FW:`) is IGNORED, `internal-reply`, before the v4.4.3 skip | same, `ignoreInternalReplies` |
| Phrase scope `sender` = sender DISPLAY NAME | `Scope` includes `sender`; DB CHECK widened (migration 0020) |
| Multi-folder plain phrases need 8+ characters and two words | `validateMultiRoute`, same message |

Web-only decisions (outside the engine, documented here because the desktop
dashboard source was not part of the copy):

- Teach sender on a colleague's address writes the SENDER row only, never the domain.
- Wrong team? on a colleague's email moves the email only; nothing is learned.
- A blank `own_domains` means `ndiof.com` (desktop: explicit `""` means none). The
  Settings form always sends the field; production sets `ndiof.com`, so decisions match.
- The importer never writes a learned domain row for an own domain or any
  `*.onmicrosoft.com` tenant, and marks an existing one forgotten. In the 22 Oct copy
  this drops `naturalofficefurniturellc.onmicrosoft.com -> TEAMFLORIDAEASTC` (taught
  22 Oct); the person `brianmarzka@` stays. This is the one known difference from the
  desktop: a *different* sender at that tenant routes on the desktop and not here.
- Address-shaped entries in a domain list are reported (import result + Settings),
  never changed. Production: `never_context_domains = quickbooks@notification.intuit.com`.

## Evidence

`scripts/archiver-parity-v453.ps1` runs the desktop engine itself (PowerShell 7.5.4)
and writes `fixtures/v453/golden.json`:

| Check | Cases | Result |
| --- | --- | --- |
| v4.5.3 engine, 22 Oct production knowledge + `extras.json`, production config, vs `classify.ts` | 109 (98 v4.5.2 inputs + 11 new) | 100% (team, copies, confidence, source, evidence, rule, stem, folder) |
| v4.5.3 engine on the v4.5.2 fixtures with `internal_domains=""`, `ignore_internal_replies=false` vs the v4.5.2 golden | 2 × 98 | 0 differences (so the v4.5.2 golden still applies with those two settings off) |
| Auto-learning on colleague + outside filings | 3 | identical |
| Multi-folder / content-rule validation messages | 9 | identical wording |
| Imported database vs the 22 Oct files, same 109 inputs | 109 | identical decisions |

Re-run after any engine change:

```
pwsh -NoProfile -File scripts/archiver-parity-v453.ps1 -Lib <archiver-lib.ps1> \
  -Fixtures src/lib/archiver/__tests__/fixtures/v453 -V452 src/lib/archiver/__tests__/fixtures/v452
```
