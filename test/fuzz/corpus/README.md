# Regression corpus

Inputs that made a parser throw, return the wrong shape, or run past its time
budget. Written here by `scripts/fuzz-continuous.js`, replayed by
`corpus.test.js` on every ordinary test run.

One directory per target, named as the target is named in `targets.js`. Files
are the raw input bytes; the name is `<kind>-<sha256 prefix>` so the same
finding twice is one file.

**Empty is the normal state.** A finding is added when the long run trips over
one, and it stays after the fix so the fix stays fixed.
