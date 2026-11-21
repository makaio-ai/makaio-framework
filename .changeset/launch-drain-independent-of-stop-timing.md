---
"@makaio/framework": patch
"@makaio/subprocess": patch
---

`launch` no longer ties the output drain after the leader's exit to `exitObservationMs`.

The drain window of a bounded command is now a fixed bound of its own. Before, a small
`exitObservationMs` (0 is a valid value) closed the pipes as soon as the leader exited, so
output a descendant wrote shortly afterwards was dropped from the captured result. The
default behaviour is unchanged; a caller that set `exitObservationMs` above 2000 now gets the fixed
2000 ms drain instead of a longer one.
