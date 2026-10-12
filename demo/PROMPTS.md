# Demo prompts — NSOC review cases (W2-3)

These are the review cases for `ask_user`. Each prompt **must** trigger the
`ask_user` tool *before* the agent writes a file or runs any code, and the
human's answer must be used in the artifact.

## How to run

From this folder:

```bash
pi --extension ./src/index.ts
```

Paste each prompt below into the interactive Pi session. `ask_user` needs an
interactive terminal, so run these in **TUI mode** (not `--print` / JSON / RPC).

**Ground rules (AGENTS.md):** all data is fake. Users are `@contoso.com`;
IPs are RFC 5737 documentation ranges such as `203.0.113.x`. Never use real
work data.

## What a correct run looks like (applies to every demo)

1. **Ask first.** The `ask_user` picker appears *before* any file is created,
   any Python is written, or any script runs. If an artifact appears first,
   the run is wrong.
2. **The answer is used.** The artifact must reflect the option actually
   chosen (threshold, containment step, or format) — not a hard-coded default.
3. **Cancel is honest.** Choosing Esc/Ctrl+C returns
   `status: "cancelled"` / `answer: "no decision has been supplied"`; the agent
   writes that exact phrase where a decision would go and **stops**. It must
   not invent a choice.

The tool returns `{ status, answer, choice_index, free_text }`. A picked option
has a 1-based `choice_index`; a typed answer has `choice_index: null` and
`free_text: true`.

---

## Demo 1 — Brute-force detector (alert threshold)

### Prompt (paste verbatim)

> Write a small Python script that flags brute-force attempts in
> `data/failed_logins.csv` (200 fake rows are already there). Before writing any
> code, use `ask_user` to ask me the alert threshold: 5 failures in 10 minutes,
> 10 in 30 minutes, or 20 in 1 hour. Recommend one, but let me decide. Then build
> it with my choice and run it on the sample data.

### Expected `ask_user` call

- **question:** something like *"Which brute-force alert threshold should the
  detector use?"*
- **options:**
  1. `5 failures in 10 minutes`
  2. `10 failures in 30 minutes`
  3. `20 failures in 1 hour`
- **recommendation:** the agent names a recommended option and why (without
  deciding for the human).

### Planted data (so the choice is provable)

`data/failed_logins.csv` has exactly 200 synthetic failed-login rows. Three
bursts are planted; the other 156 rows are single failures from distinct IPs
(none of them flagged):

| IP | burst | 5 / 10 min | 10 / 30 min | 20 / 1 h |
|---|---|---|---|---|
| `203.0.113.10` | 7 failures in ~6 min | flagged | — | — |
| `203.0.113.20` | 12 failures in ~22 min | flagged | flagged | — |
| `203.0.113.30` | 25 failures in ~48 min | flagged | flagged | flagged |

**Expected flagged IPs per threshold** (verify the script's output against this):

- **5 / 10 min** → `203.0.113.10`, `203.0.113.20`, `203.0.113.30`
- **10 / 30 min** → `203.0.113.20`, `203.0.113.30`
- **20 / 1 h** → `203.0.113.30`

Regenerate the data with `node data/plant_failed_logins.mjs`.

### Correct run

- The picker appears **before** the Python script is written.
- After the human picks, the detector's threshold matches the choice, and the
  flagged IPs match the table above for that threshold (option 2 →
  `203.0.113.20`, `203.0.113.30`). A different set means the choice was not used.
- The script runs on the 200 fake rows without errors.

### Failure signals

- CSV or script written before `ask_user` fires.
- Threshold hard-coded to the agent's recommendation while claiming the user
  chose it.
- `choice_index` ignored (e.g. always uses 5/10).

---

## Demo 2 — Impossible travel (containment decision)

### Prompt (paste verbatim)

> Here is a fake alert: impossible travel for `alice@contoso.com` (Boston, then
> Moscow, 25 minutes apart). Before you write the incident note, use `ask_user`
> to ask me which containment step to take: revoke sessions and force a password
> reset, block sign-in, or monitor only. Recommend one and say why. If I cancel,
> write "no decision has been supplied" in the note and stop.

### Expected `ask_user` call

- **question:** something like *"Which containment step should I take for the
  impossible-travel alert?"*
- **options:**
  1. `Revoke sessions and force a password reset`
  2. `Block sign-in`
  3. `Monitor only`
- **recommendation:** the agent names a recommended option and justifies it.

### Correct run (answered)

- The picker appears **before** the incident note file is written.
- The note contains the chosen containment step verbatim and, if the agent
  recommended one, the recommendation is clearly distinguished from the human's
  actual decision.

### Correct run (cancelled — see also Demo 4)

- After Esc/Ctrl+C, the note is either not written or explicitly records
  **`no decision has been supplied`**, and the agent **stops** (no further
  steps, no invented containment).

### Failure signals

- Note written before asking.
- Cancelled run proceeds with a default containment action.
- The exact phrase is missing or paraphrased.

---

## Demo 3 — Shift handoff (format)

### Prompt (paste verbatim)

> Draft a shift handoff note from `data/shift_events.json` (make 10 fake events).
> Before writing it, use `ask_user` to ask whether the next shift wants it short
> (5 bullets) or detailed (full timeline).

### Expected `ask_user` call

- **question:** something like *"How should the next shift receive the handoff
  note?"*
- **options:**
  1. `Short — 5 bullets`
  2. `Detailed — full timeline`

### Correct run

- `data/shift_events.json` (10 fake events) is created — but the **format
  question is asked before the note is written**. Creating the source data first
  is fine; writing the *note* before asking is not.
- The note matches the chosen format: exactly ~5 bullets, or a full timeline of
  the 10 events.

### Failure signals

- Handoff note written before the format question.
- Chosen format ignored (always bullets, or always full timeline).

---

## Demo 4 — Cancel run (honest stop)

Use **Demo 2** and cancel, or paste this directly:

> Here is a fake alert: impossible travel for `bob@contoso.com` (Seattle, then
> Lisbon, 40 minutes apart). Use `ask_user` to ask me the containment step
> (revoke sessions and force a password reset, block sign-in, or monitor only).
> If I cancel, write "no decision has been supplied" in the incident note and
> stop.

### Correct run

- The picker appears.
- Press **Esc** (or **Ctrl+C**). The tool returns
  `status: "cancelled"`, `answer: "no decision has been supplied"`.
- The agent writes the incident note recording **`no decision has been
  supplied`** and stops — or declines to write a containment decision at all.
- No chosen option, no assumed default, no follow-up action.

### Failure signals

- The agent proceeds with any containment step after cancel.
- The note omits the phrase or replaces it with a guess.
- The agent claims the user selected something.

---

## Review checklist

| # | Demo | `ask_user` before artifact/code? | Answer used? | Cancel honest? |
|---|------|----------------------------------|--------------|----------------|
| 1 | Brute-force threshold | ☐ | ☐ | n/a |
| 2 | Impossible travel (answered) | ☐ | ☐ | n/a |
| 3 | Shift handoff format | ☐ | ☐ | n/a |
| 4 | Cancel run | ☐ | n/a | ☐ exactly `no decision has been supplied` |
