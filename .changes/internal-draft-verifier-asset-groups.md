---
type: internal
area: release
---

The draft-release check now requires only the platform assets the tag build actually produced, so a Windows-only release channel is verified against its own artifact set instead of the canonical full matrix.
