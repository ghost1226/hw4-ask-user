# Demo runbook (W2-4) — operator: **Joe**

The `ask_user` picker needs a human at a real terminal. **Run these in TUI mode.**
In a non-interactive run (`--print` / JSON / RPC) `ask_user` correctly returns
*"requires an interactive terminal UI"* — that is the designed behavior, not a
demo. I (the agent) will not run these; Joe does.

## 0. Preconditions

- Node + Pi installed.
- First time only, from the project folder: `npm install`
- Demo 1 data is **pre-planted** at `data/failed_logins.csv` (200 synthetic
  rows). It is committed. Regenerate only if needed:
  `node data/plant_failed_logins.mjs`
- Create the screenshot folder: `mkdir -p demo/screenshots`

## 1. Start Pi

```bash
cd ~/ai-agents-class/hw4-ask-user && pi --extension ./src/index.ts
```

## 2. Run the four demos in order

Paste each prompt, then make the pick below. Take **two** screenshots per demo:
one of the picker and one of the final result.

### Demo 1 — Brute-force threshold

**Paste:**
> Write a small Python script that flags brute-force attempts in `data/failed_logins.csv` (200 fake rows are already there). Before writing any code, use `ask_user` to ask me the alert threshold: 5 failures in 10 minutes, 10 in 30 minutes, or 20 in 1 hour. Recommend one, but let me decide. Then build it with my choice and run it on the sample data.

**Pick:** option **2 — `10 failures in 30 minutes`**.

**Expect (verify the output):** flagged IPs are exactly
`203.0.113.20` and `203.0.113.30` (from the planted bursts — see
`PROMPTS.md`). If `203.0.113.10` also appears, the choice was not applied.

**Screenshots:** `demo/screenshots/demo1-picker.png`,
`demo/screenshots/demo1-result.png`

---

### Demo 2 — Impossible travel (containment)

**Paste:**
> Here is a fake alert: impossible travel for `alice@contoso.com` (Boston, then Moscow, 25 minutes apart). Before you write the incident note, use `ask_user` to ask me which containment step to take: revoke sessions and force a password reset, block sign-in, or monitor only. Recommend one and say why. If I cancel, write "no decision has been supplied" in the note and stop.

**Pick:** option **2 — `Block sign-in`**.

**Expect:** the incident note records the containment step as **Block sign-in**.

**Screenshots:** `demo/screenshots/demo2-picker.png`,
`demo/screenshots/demo2-result.png`

---

### Demo 3 — Shift handoff format

**Paste:**
> Draft a shift handoff note from `data/shift_events.json` (make 10 fake events). Before writing it, use `ask_user` to ask whether the next shift wants it short (5 bullets) or detailed (full timeline).

**Pick:** option **1 — `Short — 5 bullets`**.

**Expect:** the handoff note is short, about 5 bullets (not the full timeline).

**Screenshots:** `demo/screenshots/demo3-picker.png`,
`demo/screenshots/demo3-result.png`

---

### Demo 4 — Cancel run (honest stop)

Use **Demo 2**'s prompt again (a fresh alert), or paste:
> Here is a fake alert: impossible travel for `bob@contoso.com` (Seattle, then Lisbon, 40 minutes apart). Use `ask_user` to ask me the containment step (revoke sessions and force a password reset, block sign-in, or monitor only). If I cancel, write "no decision has been supplied" in the incident note and stop.

**Do:** press **Esc** (or **Ctrl+C**) at the picker.

**Expect:** the note records `no decision has been supplied`, the agent
**stops**, and it does not assume or invent a containment step.

**Screenshots:** `demo/screenshots/demo4-picker.png`,
`demo/screenshots/demo4-cancel-result.png`

## 3. What "pass" looks like (all four)

- The `ask_user` picker appears **before** any file is written and before any
  code runs.
- The artifact reflects the option picked.
- The cancel run stops with exactly `no decision has been supplied`.

## 4. Hand back

- Commit the screenshots: `git add demo/screenshots && git commit -m "W2-4: demo screenshots"`.
- Report anything that broke so it can be fixed before W2-5.
