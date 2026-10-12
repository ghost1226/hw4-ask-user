# AGENTS.md — HW4 `ask_user`

Working agreement for this folder. Keep it short.

## Ground rules
- **Synthetic data only.** Never use, paste, or reference real work data, real
  users, real hostnames, or real telemetry. Demo data is fabricated
  (`@contoso.com`, RFC 5737 documentation IPs such as `203.0.113.x`).
- **Secrets only in `.env`,** which is gitignored. `.env.example` may list
  variable *names* with dummy values — never secrets.
- **Red → green.** Write failing tests first (red commit), then make them pass
  (green commit). No implementation before a failing test.
- **Commit after every task.** Small, descriptive commits, prefixed with the
  step id (e.g. `W2-1 red: …`).
- **Update `PROGRESS.md` after every task** (include the commit hash) before
  moving on.
- **Stop after each step and wait for Joe's go.** Do not start the next step
  unprompted.

## Scope
- Work only inside `~/ai-agents-class/hw4-ask-user`.
- **Ask before any command outside this folder.**
- No `git init` — this folder already lives inside the course repo.

## The tool
`ask_user` — the frozen contract lives in `PROGRESS.md` under **W2-0**.
Do not change it without updating the tests and `PROGRESS.md`.

## Pi docs used (citations)
- `docs/extensions.md` — extension factory shape, `pi.registerTool`, the tool
  contract (`content` + `details`), `outputSchema`/`structuredContent`,
  `exposure` (`model-only` for "ask the user" tools), `renderCall`/`renderResult`,
  and UI-mode rules (`ctx.mode === "tui"`, `ctx.hasUI`).
- `docs/tui.md` — `ctx.ui.custom()`, completion callback, `matchesKey`/`Key`,
  width-safe rendering with `visibleWidth`/`wrapTextWithAnsi`, theme usage.
- Reference examples: `examples/extensions/question.ts` (options list + inline
  custom-answer editor + Esc cancel) and `examples/extensions/hello.ts`
  (minimal tool).
