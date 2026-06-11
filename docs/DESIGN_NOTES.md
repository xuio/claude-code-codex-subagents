# Design Notes

This file replaces the original pre-implementation `docs/PLAN.md`. The project
now uses the native Claude-facing tool surface documented in `README.md` and
`docs/USAGE.md`; the old exec-only implementation plan is intentionally archived
out of the main docs path.

## Deferred Session Lifecycle Simplification

The current public surface keeps three concepts separate:

- `codex_task` starts a one-shot or background Codex task.
- `codex_followup` continues, steers, waits on, or cancels one known session.
- `codex_wait_any` waits for one of several background sessions to complete.

This is explicit and stable, but Claude still needs to reason about
`background`, `keep_session`, `mode`, `turn_id`, and the difference between
single-session and multi-session waits.

Possible future simplifications:

1. Allow `codex_wait_any` to accept one session id and treat it as the only wait
   API, leaving `codex_followup` for `queue`, `steer`, and `cancel`.
2. Always return `session_id` from `codex_task` while auto-closing successful
   one-shot app-server children. This would make follow-up affordances more
   uniform, but it also gives Claude more session ids to track.
3. Replace `keep_session` with an explicit lifecycle field such as
   `session: "none" | "return" | "background"` if Claude continues to confuse
   `keep_session` and `background`.

Do not implement these without maintainer sign-off. They are API-shape changes,
not correctness fixes.
