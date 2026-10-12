#!/usr/bin/env node
/**
 * Standalone ask_user CLI — no model, no Pi. Just the picker.
 *
 * Usage:
 *   npm run ask
 *   # or
 *   node scripts/cli.mjs --question "Pick one" --options "A" "B" "C"
 */
import {
  Editor,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import readline from "node:readline";
import process from "node:process";

const FREE_TEXT_LABEL = "Type your own answer…";
const CANCEL_ANSWER = "no decision has been supplied";

/* ── Minimal ANSI theme ─────────────────────────────────────────── */
const _c = {
  accent: "\x1b[36m",
  text: "\x1b[37m",
  muted: "\x1b[90m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};
function fg(token, text) {
  const code = { accent: _c.accent, text: _c.text, muted: _c.muted, dim: _c.dim }[token] || "";
  return `${code}${text}${_c.reset}`;
}
function bold(text) { return `\x1b[1m${text}\x1b[0m`; }

/* ── Presets (mirror of src/index.ts) ───────────────────────────── */
const PRESETS = {
  scenario: {
    question: "Which scenario do you want to run?",
    description: "Three ready pickers. Choose one and I'll open its options.",
    options: [
      { label: "Brute-force detector — pick alert threshold", description: "Flag brute-force attempts in data/failed_logins.csv" },
      { label: "Impossible travel — pick containment step", description: "Containment decision for a suspicious sign-in" },
      { label: "Shift handoff — pick format", description: "Draft a shift handoff note in the chosen format" },
    ],
  },
  bruteforce: {
    question: "Which brute-force alert threshold should the detector use?",
    description:
      "Flags an IP when it exceeds the threshold within the window. Planted bursts: " +
      "203.0.113.10 (7 in ~6 min), 203.0.113.20 (12 in ~22 min), 203.0.113.30 (25 in ~48 min).",
    options: [
      { label: "5 failures in 10 minutes", description: "Most sensitive — flags all three bursts" },
      { label: "10 failures in 30 minutes", description: "Recommended — flags the two larger bursts" },
      { label: "20 failures in 1 hour", description: "Least sensitive — flags only the largest burst" },
    ],
  },
  incident: {
    question: "Which containment step should I take?",
    description:
      "Impossible travel: alice@contoso.com signed in from Boston, then Moscow 25 minutes later. " +
      "Strongly suggests credential compromise. The choice is recorded, not executed.",
    options: [
      { label: "Revoke sessions and force a password reset", description: "Recommended — immediately breaks active access" },
      { label: "Block sign-in", description: "Prevents new sessions; does not kill existing ones" },
      { label: "Monitor only", description: "Watch for further activity; take no action now" },
    ],
  },
  handoff: {
    question: "How should the next shift receive the handoff note?",
    description:
      "Drafts a shift handoff from 10 synthetic events. The format is just presentation — " +
      "the underlying events are the same.",
    options: [
      { label: "Short — 5 bullets", description: "Summary for a quick read" },
      { label: "Detailed — full timeline", description: "Chronological account of all 10 events" },
    ],
  },
};

/* ── Parse args or prompt interactively ──────────────────────────── */
async function getInputs() {
  const args = process.argv.slice(2);
  let question = "";
  let description = "";
  let options = [];
  let preset = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--question" || args[i] === "-q") question = args[++i] || "";
    if (args[i] === "--description" || args[i] === "-d") description = args[++i] || "";
    if (args[i] === "--preset" || args[i] === "-p") preset = args[++i] || "";
    if (args[i] === "--options" || args[i] === "-o") {
      options = [];
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options.push(args[++i]);
      }
    }
  }

  if (preset) {
    const p = PRESETS[preset];
    if (!p) {
      console.error(`Error: unknown preset '${preset}'. Use scenario, bruteforce, incident, or handoff.`);
      process.exit(1);
    }
    return { question: p.question, description: p.description, options: p.options };
  }

  if (!question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    question = await new Promise((r) => rl.question("Question: ", r));
    description = await new Promise((r) => rl.question("Description (optional): ", r));
    let i = 1;
    while (true) {
      const opt = await new Promise((r) => rl.question(`Option ${i} (blank to finish): `, r));
      if (!opt.trim()) break;
      options.push({ label: opt.trim() });
      i++;
    }
    rl.close();
  }
  return { question, description, options };
}

function stripMarkdown(text) {
  return text.replace(/\*\*/g, "").replace(/__/g, "");
}

/* ── Main picker ────────────────────────────────────────────────── */
async function runPicker(question, description, optionItems) {
  const rows = optionItems.map((o) => ({ label: o.label, description: o.description, isFreeText: false }));
  rows.push({ label: FREE_TEXT_LABEL, isFreeText: true });

  let index = 0;
  let editMode = false;
  let result = null;
  let cancelled = false;

  const termCols = () => process.stdout.columns || 80;

  const tui = {
    requestRender() { render(); },
    terminal: { get columns() { return termCols(); }, rows: process.stdout.rows || 24 },
    setFocus() {},
    clearFocus() {},
  };

  const editorTheme = {
    borderColor: (s) => fg("accent", s),
    selectList: {
      selectedPrefix: (t) => fg("accent", t),
      selectedText: (t) => fg("accent", t),
      description: (t) => fg("muted", t),
      scrollInfo: (t) => fg("dim", t),
      noMatch: (t) => fg("muted", t),
    },
  };
  const editor = new Editor(tui, editorTheme);

  editor.onSubmit = (value) => {
    const trimmed = value.trim();
    if (trimmed) {
      result = { answer: trimmed, choiceIndex: null, freeText: true };
    } else {
      editMode = false;
      editor.setText("");
      render();
    }
  };

  function render() {
    const width = Math.max(1, termCols());
    const lines = [];

    lines.push(fg("accent", "─".repeat(width)));
    lines.push(" " + fg("text", stripMarkdown(question)));
    if (description) {
      lines.push("");
      lines.push(" " + fg("muted", stripMarkdown(description)));
    }
    lines.push("");

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const selected = i === index;
      const editing = row.isFreeText && editMode;
      const prefix = selected ? fg("accent", "> ") : "  ";
      const marker = editing ? " ✎" : "";
      const label = `${i + 1}. ${stripMarkdown(row.label)}${marker}`;
      const color = selected || editing ? "accent" : "text";
      lines.push(prefix + fg(color, label));
      if (row.description) {
        lines.push("     " + fg("muted", stripMarkdown(row.description)));
      }
    }

    if (editMode) {
      lines.push("");
      lines.push(" " + fg("muted", "Your answer:"));
      for (const line of editor.render(Math.max(1, width - 2))) {
        lines.push(` ${line}`);
      }
      lines.push("");
      lines.push(" " + fg("dim", "Enter to submit • Esc to go back"));
    } else {
      lines.push("");
      lines.push(" " + fg("dim", "↑↓ navigate • Enter to select • Esc/Ctrl+C to cancel"));
    }
    lines.push(fg("accent", "─".repeat(width)));

    // Overwrite the previous frame
    process.stdout.write(_c.clear);
    for (const line of lines) {
      process.stdout.write(line + "\n");
    }
  }

  function onData(data) {
    if (editMode) {
      if (matchesKey(data, Key.escape)) {
        editMode = false;
        editor.setText("");
        render();
        return;
      }
      if (matchesKey(data, "ctrl+c")) {
        cancelled = true;
        done();
        return;
      }
      editor.handleInput(data);
      render();
      return;
    }

    if (matchesKey(data, Key.up)) {
      index = Math.max(0, index - 1);
      render();
      return;
    }
    if (matchesKey(data, Key.down)) {
      index = Math.min(rows.length - 1, index + 1);
      render();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const row = rows[index];
      if (row.isFreeText) {
        editMode = true;
        render();
      } else {
        result = { answer: row.label, choiceIndex: index + 1, freeText: false };
        done();
      }
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
      cancelled = true;
      done();
    }
  }

  function done() {
    process.stdin.removeListener("data", onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(_c.showCursor);
  }

  // Start
  process.stdout.write(_c.hideCursor);
  render();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);

  // Wait for result
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (result || cancelled) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

  return cancelled
    ? { status: "cancelled", answer: CANCEL_ANSWER, choice_index: null, free_text: false }
    : { status: "answered", answer: result.answer, choice_index: result.choiceIndex, free_text: result.freeText };
}

/* ── Entrypoint ─────────────────────────────────────────────────── */
(async () => {
  if (!process.stdin.isTTY) {
    console.error("Error: ask_user CLI requires an interactive terminal (TTY).");
    console.error("Run it directly in a terminal, not through a pipe or non-TTY session.");
    process.exit(1);
  }

  const { question, description, options } = await getInputs();

  if (!question.trim()) {
    console.log("Error: question is required.");
    process.exit(1);
  }

  const out = await runPicker(question, description, options);
  console.log("\n" + JSON.stringify(out, null, 2));
})();
