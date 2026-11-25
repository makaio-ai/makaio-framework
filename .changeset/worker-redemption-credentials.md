---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/services-core": major
---

Separate the digest domains for worker bootstrap tokens and runtime secrets. **Breaking:** owners booking workers for atomic redemption must store the purpose-tagged digest documented on `LockedWorkerRedemption.tokenDigest`. Redemption and replay refuse the previous untagged digests.

The SHA-256 input is the UTF-8 bytes of the purpose (without the colon), one NUL byte (0x00), and the UTF-8 bytes of the credential value, in that order. The stored string is the purpose, a colon, and the lowercase hex digest.

| Purpose | Value | Hex digest | Stored string |
| --- | --- | --- | --- |
| `worker-bootstrap-v1` | `example input` | `e065986136506eb4daabc992e5f19bb0df27afe327fcb74b4aab82b169e563f4` | `worker-bootstrap-v1:e065986136506eb4daabc992e5f19bb0df27afe327fcb74b4aab82b169e563f4` |
| `worker-runtime-v1` | `example input` | `f4ea92a027441ce8c22d2a7c383832b8175ac0eac56c808bd435f5ea07c3523d` | `worker-runtime-v1:f4ea92a027441ce8c22d2a7c383832b8175ac0eac56c808bd435f5ea07c3523d` |

Let a prepared worker exchange wait for a run-specific, committed allocation observation within the bootstrap window. Internal hosts must share one allocation observation signal between dispatch and redemption. Until both the digests and the required independent allocation proof pass, storage failures produce the same generic rejection as invalid credentials. If a competing exchange commits with the same runtime secret during preparation, verify the stored allocation for replay and return its stored reply. Unreadable candidates, PostgreSQL data exceptions (SQLSTATE class 22), and constraint violations cause generic rejection. Other storage failures, including typed host errors, are retryable with the same credentials while the exchange deadline is open. Storage failures at or after that deadline cause generic rejection during preparation and commit.

Report a configuration error on the first atomic booking if its owner has no credential reader. Validate stored dispatch candidates and report malformed evidence explicitly while retaining support for legacy candidate arrays without sender provenance.

Keep redemption pending after incomplete discovery while the sender can still commit a reference, within the existing preparation deadline.
