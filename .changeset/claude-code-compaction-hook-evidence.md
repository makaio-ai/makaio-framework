---
"@makaio/client-claude-code": patch
---

Document how the compaction hooks are reached, now that the live probe observes
both of them.

`PreCompact` and `PostCompact` were recorded as unobserved, attributed to the
probe's isolated configuration directory silencing the manual compaction
command. That attribution was wrong: the command is silent on an *empty*
session, because there is nothing to compact, and a session holding a single
exchange reaches `PreCompact` only to abort before `PostCompact`. Seeding a
tool-using turn and compacting the resumed session reaches both, and the hook
event table now says so.
