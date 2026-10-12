/**
 * ask_user Pi Extension — HW4
 *
 * Registers a model-callable `ask_user` tool and a `/ask_user` slash command.
 *
 * Tool: pauses the agent and asks the human a question in the terminal.
 * Command: runs the two-step scenario flow (scenario picker → task picker →
 * execute task) without needing a prompt.
 *
 * Contract (frozen in PROGRESS.md, W2-0):
 *   ask_user(question, options?, allow_free_text = true)
 *   returns { status, answer, choice_index, free_text }
 *   cancelled → answer === "no decision has been supplied"
 *
 * Docs: docs/extensions.md (registerTool, registerCommand, exposure,
 * outputSchema), docs/tui.md (ctx.ui.custom, matchesKey/Key, width-safe
 * rendering).
 *
 * Load: pi --extension ./src/index.ts
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

/* ------------------------------------------------------------------ */
/*  Schemas                                                            */
/* ------------------------------------------------------------------ */

const OptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional longer description shown below the label" }),
  ),
});

const AskUserParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Optional(
    Type.Array(OptionSchema, {
      description: "Options the user may choose from. Omit to ask an open question (free text).",
    }),
  ),
  allow_free_text: Type.Optional(
    Type.Boolean({
      description: "Offer a 'Type your own answer…' row. Defaults to true.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Optional context shown under the question (plain text, no markdown).",
    }),
  ),
  preset: Type.Optional(
    Type.Union([
      Type.Literal("scenario"),
      Type.Literal("bruteforce"),
      Type.Literal("incident"),
      Type.Literal("handoff"),
    ], {
      description:
        "Preset scenario. 'scenario' lists the demos; the others fill the question, description, and options.",
    }),
  ),
});

const AskUserOutputSchema = Type.Object({
  status: Type.Union([Type.Literal("answered"), Type.Literal("cancelled")]),
  answer: Type.String(),
  choice_index: Type.Union([Type.Number(), Type.Null()], {
    description: "1-based index of the chosen option, or null for free text / cancelled.",
  }),
  free_text: Type.Boolean(),
});

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AskUserParamsT {
  question?: string;
  options?: Array<{ label: string; description?: string }>;
  allow_free_text?: boolean;
  description?: string;
  preset?: "scenario" | "bruteforce" | "incident" | "handoff";
}

const PRESETS: Record<
  string,
  { question: string; description: string; options: Array<{ label: string; description?: string }> }
> = {
  scenario: {
    question: "Which scenario do you want to run?",
    description: "Three ready pickers. Choose one and I'll open its options.",
    options: [
      {
        label: "Brute-force detector — pick alert threshold",
        description: "Flag brute-force attempts in data/failed_logins.csv",
      },
      {
        label: "Impossible travel — pick containment step",
        description: "Containment decision for a suspicious sign-in",
      },
      {
        label: "Shift handoff — pick format",
        description: "Draft a shift handoff note in the chosen format",
      },
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
      {
        label: "Revoke sessions and force a password reset",
        description: "Recommended — immediately breaks active access",
      },
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

type AskUserOutput = {
  status: "answered" | "cancelled";
  answer: string;
  choice_index: number | null;
  free_text: boolean;
};

interface AskUserDetails extends AskUserOutput {
  question: string;
  options: string[];
}

interface PickerOutcome {
  answer: string;
  choiceIndex: number | null;
  freeText: boolean;
}

interface Row {
  label: string;
  description?: string;
  isFreeText?: boolean;
}

const CANCEL_ANSWER = "no decision has been supplied";
const FREE_TEXT_LABEL = "Type your own answer…";

/* ------------------------------------------------------------------ */
/*  Validation                                                         */
/* ------------------------------------------------------------------ */

function applyPreset(params: AskUserParamsT): AskUserParamsT {
  if (!params.preset) return params;
  const p = PRESETS[params.preset];
  if (!p) return params;
  return {
    ...params,
    question: p.question,
    description: p.description,
    options: p.options,
  };
}

function validate(params: AskUserParamsT): string | null {
  if (params.preset && !PRESETS[params.preset]) {
    return `Invalid input: unknown preset '${params.preset}'. Use 'scenario', 'bruteforce', 'incident', or 'handoff'.`;
  }

  const effective = params.preset ? applyPreset(params) : params;

  if (!effective.question || effective.question.trim().length === 0) {
    return "Invalid input: 'question' must not be empty.";
  }

  if (effective.options !== undefined && effective.options.length === 0) {
    return "Invalid input: 'options' must not be empty when provided.";
  }

  const options = effective.options ?? [];
  for (const option of options) {
    if (!option.label || option.label.trim().length === 0) {
      return "Invalid input: option labels must not be empty.";
    }
  }

  const seen = new Set<string>();
  for (const option of options) {
    const key = option.label.trim();
    if (seen.has(key)) {
      return `Invalid input: duplicate option label '${key}'.`;
    }
    seen.add(key);
  }

  const allowFreeText = effective.allow_free_text ?? true;
  if (options.length === 0 && !allowFreeText) {
    return `Invalid input: no options were provided and free text is disabled; there is nothing to ask.`;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Result builders                                                    */
/* ------------------------------------------------------------------ */

function errorResult(message: string, params: AskUserParamsT): AgentToolResult<AskUserDetails> {
  return {
    content: [{ type: "text", text: message }],
    details: {
      status: "cancelled",
      answer: "",
      choice_index: null,
      free_text: false,
      question: params.question ?? "",
      options: (params.options ?? []).map((o) => o.label),
    },
    isError: true,
  };
}

function cancelledResult(
  params: AskUserParamsT,
  labels: string[],
): AgentToolResult<AskUserDetails> {
  const output: AskUserOutput = {
    status: "cancelled",
    answer: CANCEL_ANSWER,
    choice_index: null,
    free_text: false,
  };
  return {
    content: [
      {
        type: "text",
        text: `The user cancelled the question: ${CANCEL_ANSWER}. Do not assume a choice was made.`,
      },
    ],
    details: { ...output, question: params.question ?? "", options: labels },
    structuredContent: output,
  };
}

function stripMarkdown(text: string): string {
  return text.replace(/\*\*/g, "").replace(/__/g, "");
}

function answeredResult(
  params: AskUserParamsT,
  labels: string[],
  pick: PickerOutcome,
): AgentToolResult<AskUserDetails> {
  const output: AskUserOutput = {
    status: "answered",
    answer: pick.answer,
    choice_index: pick.choiceIndex,
    free_text: pick.freeText,
  };
  const text = pick.freeText
    ? `User answered (free text): "${pick.answer}". This is a recorded decision that has NOT been executed; the agent must not claim it was carried out.`
    : `User selected option ${pick.choiceIndex}: "${pick.answer}". This is a recorded decision that has NOT been executed; the agent must not claim it was carried out.`;
  return {
    content: [{ type: "text", text }],
    details: { ...output, question: params.question ?? "", options: labels },
    structuredContent: output,
  };
}

/* ------------------------------------------------------------------ */
/*  Shared interactive picker                                        */
/* ------------------------------------------------------------------ */

async function runAskUser(
  params: AskUserParamsT,
  ctx: ExtensionContext,
): Promise<
  | { status: "answered"; answer: string; choiceIndex: number | null; freeText: boolean }
  | { status: "cancelled" }
  | { status: "error"; message: string }
> {
  const effectiveParams = applyPreset(params);
  const invalid = validate(effectiveParams);
  if (invalid) return { status: "error", message: invalid };

  if (ctx.mode !== "tui") {
    return {
      status: "error",
      message: "Error: ask_user requires an interactive terminal UI, which is not available in this mode.",
    };
  }

  const optionList = effectiveParams.options ?? [];
  const allowFreeText = effectiveParams.allow_free_text ?? true;

  const rows: Row[] = optionList.map((o) => ({ label: o.label, description: o.description }));
  if (allowFreeText) rows.push({ label: FREE_TEXT_LABEL, isFreeText: true });

  const pick = await ctx.ui.custom<PickerOutcome | null>((tui, theme, _kb, done) => {
    let index = 0;
    let editMode = false;
    let cachedLines: string[] | undefined;

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    editor.onSubmit = (value) => {
      const trimmed = value.trim();
      if (trimmed) {
        done({ answer: trimmed, choiceIndex: null, freeText: true });
      } else {
        editMode = false;
        editor.setText("");
        refresh();
      }
    };

    function handleInput(data: string) {
      if (editMode) {
        if (matchesKey(data, Key.escape)) {
          editMode = false;
          editor.setText("");
          refresh();
          return;
        }
        if (matchesKey(data, "ctrl+c")) {
          done(null);
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      if (matchesKey(data, Key.up)) {
        index = Math.max(0, index - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        index = Math.min(rows.length - 1, index + 1);
        refresh();
        return;
      }

      if (matchesKey(data, Key.enter)) {
        const row = rows[index];
        if (row.isFreeText) {
          editMode = true;
          refresh();
        } else {
          done({ answer: row.label, choiceIndex: index + 1, freeText: false });
        }
        return;
      }

      if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
        done(null);
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const renderWidth = Math.max(1, width);

      function addWrapped(text: string) {
        lines.push(...wrapTextWithAnsi(text, renderWidth));
      }
      function addPrefixed(prefix: string, text: string) {
        const prefixWidth = visibleWidth(prefix);
        if (prefixWidth >= renderWidth) {
          addWrapped(prefix + text);
          return;
        }
        const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
        const continuation = " ".repeat(prefixWidth);
        for (let i = 0; i < wrapped.length; i++) {
          lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
        }
      }

      lines.push(theme.fg("accent", "─".repeat(renderWidth)));
      addPrefixed(" ", theme.fg("text", stripMarkdown(effectiveParams.question ?? "")));
      if (effectiveParams.description) {
        lines.push("");
        addPrefixed(" ", theme.fg("muted", stripMarkdown(effectiveParams.description)));
      }
      lines.push("");

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const selected = i === index;
        const editing = row.isFreeText === true && editMode;
        const prefix = selected ? theme.fg("accent", "> ") : "  ";
        const marker = editing ? " ✎" : "";
        const label = `${i + 1}. ${stripMarkdown(row.label)}${marker}`;
        const color = selected || editing ? "accent" : "text";
        addPrefixed(prefix, theme.fg(color, label));
        if (row.description) {
          addPrefixed("     ", theme.fg("muted", stripMarkdown(row.description)));
        }
      }

      if (editMode) {
        lines.push("");
        addPrefixed(" ", theme.fg("muted", "Your answer:"));
        for (const line of editor.render(Math.max(1, renderWidth - 2))) {
          lines.push(` ${line}`);
        }
        lines.push("");
        addPrefixed(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
      } else {
        lines.push("");
        addPrefixed(" ", theme.fg("dim", "↑↓ navigate • Enter to select • Esc to cancel"));
      }
      lines.push(theme.fg("accent", "─".repeat(renderWidth)));

      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });

  if (pick === null || pick === undefined) return { status: "cancelled" };
  return { status: "answered", ...pick };
}

/* ------------------------------------------------------------------ */
/*  Scenario task helpers                                            */
/* ------------------------------------------------------------------ */

function executeBruteforce(answer: string, cwd: string): string {
  const thresholds: Record<string, { threshold: number; window: number }> = {
    "5 failures in 10 minutes": { threshold: 5, window: 10 },
    "10 failures in 30 minutes": { threshold: 10, window: 30 },
    "20 failures in 1 hour": { threshold: 20, window: 60 },
  };
  const cfg = thresholds[answer];
  if (!cfg) throw new Error(`Unknown threshold: ${answer}`);

  const env = { ...process.env, BF_THRESHOLD: String(cfg.threshold), BF_WINDOW: String(cfg.window) };
  return execSync("python3 scripts/detect_bruteforce.py", { cwd, env, encoding: "utf-8" });
}

function writeIncidentNote(answer: string, cwd: string) {
  const content = `# Incident Note

**User:** alice@contoso.com  
**Alert:** Impossible travel  
**Details:** Sign-in from Boston, then Moscow 25 minutes later. Strongly suggests credential compromise.  
**Chosen containment step:** ${answer}  
**Status:** Recorded, not executed. This decision has NOT been applied.
`;
  writeFileSync(join(cwd, "incident_note.md"), content, "utf-8");
}

const HANDOFF_EVENTS = [
  "2024-06-03T02:00:00Z — Firewall alert: unusual outbound connection from 203.0.113.10",
  "2024-06-03T02:15:00Z — IDS signature triggered on port 445",
  "2024-06-03T02:30:00Z — Failed login spike for user0@contoso.com",
  "2024-06-03T02:45:00Z — Proxy block: suspicious TLS handshake",
  "2024-06-03T03:00:00Z — EDR alert: powershell execution from temp",
  "2024-06-03T03:15:00Z — DLP warning: large file transfer to external IP",
  "2024-06-03T03:30:00Z — DNS tunneling detected from workstation WS-0042",
  "2024-06-03T03:45:00Z — MFA bypass attempt on admin@contoso.com",
  "2024-06-03T04:00:00Z — Abnormal database query pattern from app service",
  "2024-06-03T04:15:00Z — Scheduled backup completed with integrity check passed",
];

function writeShiftHandoff(answer: string, cwd: string) {
  let content = "# Shift Handoff\n\n";
  if (answer === "Short — 5 bullets") {
    content += "Summary of the shift (5 bullets):\n\n";
    for (let i = 0; i < 5; i++) {
      content += `- ${HANDOFF_EVENTS[i]}\n`;
    }
    content += `\n…and 5 more events omitted for brevity.\n`;
  } else {
    content += "## Full Timeline\n\n";
    for (const ev of HANDOFF_EVENTS) {
      content += `- ${ev}\n`;
    }
  }

  writeFileSync(join(cwd, "shift_handoff.md"), content, "utf-8");
}

function parseFlaggedIPs(output: string): string[] {
  const lines = output.split("\n");
  const flagged: string[] = [];
  let inFlagged = false;
  for (const line of lines) {
    if (line.startsWith("Flagged IPs")) {
      inFlagged = true;
      continue;
    }
    if (inFlagged) {
      if (line.trim() === "" || line.startsWith("All IP failure counts")) break;
      const match = line.match(/^\s*-\s+(.+)$/);
      if (match) flagged.push(match[1]);
    }
  }
  return flagged;
}

/* ------------------------------------------------------------------ */
/*  Scenario routing                                                  */
/* ------------------------------------------------------------------ */

type SubPreset = "bruteforce" | "incident" | "handoff";

const SCENARIO_MAP: Record<string, SubPreset> = {
  "Brute-force detector — pick alert threshold": "bruteforce",
  "Impossible travel — pick containment step": "incident",
  "Shift handoff — pick format": "handoff",
};

// Free text is off where a typed answer cannot be acted on: a typed threshold
// makes the detector fail ("Task failed"), and a typed handoff answer silently
// falls through to the full timeline. The incident note records whatever is
// typed, so it keeps free text.
const FREE_TEXT_ALLOWED: Record<SubPreset, boolean> = {
  bruteforce: false,
  incident: true,
  handoff: false,
};

const REPEAT_LABEL = "Pick another scenario";
const EXIT_LABEL = "Exit";

/* ------------------------------------------------------------------ */
/*  Extension factory                                                  */
/* ------------------------------------------------------------------ */

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the human a question in the terminal and wait for their decision. " +
      "For common scenarios use preset: 'bruteforce' | 'incident' | 'handoff', " +
      "which auto-fills the question and options. " +
      "Otherwise provide options for a multiple-choice question, or omit them to ask an " +
      "open question. The user may always type their own answer unless " +
      "allow_free_text is false. Use this when a decision belongs to the human. " +
      "Question and option text are plain text (not markdown). " +
      "On cancel, the answer is exactly 'no decision has been supplied' and no " +
      "choice should be assumed.",
    parameters: AskUserParams,
    outputSchema: AskUserOutputSchema,
    exposure: "model-only",
    executionMode: "sequential",

    async execute(
      _toolCallId: string,
      params: AskUserParamsT,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<AskUserDetails>> {
      const effectiveParams = applyPreset(params);
      const labels = (effectiveParams.options ?? []).map((o) => o.label);

      const result = await runAskUser(params, ctx);
      if (result.status === "error") return errorResult(result.message, effectiveParams);
      if (result.status === "cancelled") return cancelledResult(effectiveParams, labels);
      return answeredResult(effectiveParams, labels, {
        answer: result.answer,
        choiceIndex: result.choiceIndex,
        freeText: result.freeText,
      });
    },

    /* ---- Transcript rendering ---------------------------------- */
    renderCall(args, theme, _context) {
      const effectiveArgs = applyPreset(args);
      const opts = Array.isArray(effectiveArgs.options) ? effectiveArgs.options : [];
      const numbered = opts.map((o, i) => `${i + 1}. ${o.label}`);
      if (effectiveArgs.allow_free_text ?? true) {
        numbered.push(`${numbered.length + 1}. ${FREE_TEXT_LABEL}`);
      }
      let text = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", effectiveArgs.question ?? "");
      if (numbered.length) {
        text += `\n${theme.fg("dim", `  ${numbered.join(", ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      if (details.status === "cancelled") {
        return new Text(theme.fg("warning", `Cancelled — ${CANCEL_ANSWER}`), 0, 0);
      }
      if (details.free_text) {
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(typed) ") +
            theme.fg("accent", details.answer),
          0,
          0,
        );
      }
      const display =
        details.choice_index !== null ? `${details.choice_index}. ${details.answer}` : details.answer;
      return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
    },
  });

  /* ---- Slash command ------------------------------------------ */
  pi.registerCommand("ask_user", {
    description:
      "Run the ask_user scenario flow (loops): pick a scenario, then its options, " +
      "execute the task, then ask whether to run another.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui?.notify("ask_user requires an interactive terminal.", "error");
        return;
      }

      while (true) {
        /* —— Step 1: scenario picker —— */
        const scenario = await runAskUser({ preset: "scenario" }, ctx);
        if (scenario.status === "cancelled") {
          ctx.ui.notify("no decision has been supplied", "warning");
          return;
        }
        if (scenario.status === "error") {
          ctx.ui.notify(scenario.message, "error");
          return;
        }

        const subPreset = SCENARIO_MAP[scenario.answer];
        if (!subPreset) {
          ctx.ui.notify(`Unrecognized scenario: ${scenario.answer}`, "error");
          return;
        }

        /* —— Step 2: task picker (free text off for bruteforce/handoff) —— */
        const task = await runAskUser(
          { preset: subPreset, allow_free_text: FREE_TEXT_ALLOWED[subPreset] },
          ctx,
        );
        if (task.status === "cancelled") {
          ctx.ui.notify("no decision has been supplied", "warning");
          return;
        }
        if (task.status === "error") {
          ctx.ui.notify(task.message, "error");
          return;
        }

        /* —— Step 3: execute task —— */
        let repeatDescription = "";
        try {
          switch (subPreset) {
            case "bruteforce": {
              const out = executeBruteforce(task.answer, ctx.cwd);
              writeFileSync(join(ctx.cwd, "bruteforce_result.txt"), out, "utf-8");
              const flagged = parseFlaggedIPs(out);
              repeatDescription = `Threshold: ${task.answer}. Flagged IPs (${flagged.length}): ${flagged.join(", ")}. Full output: bruteforce_result.txt`;
              ctx.ui.notify(`Brute-force detector ran with threshold: ${task.answer}`, "info");
              break;
            }
            case "incident": {
              writeIncidentNote(task.answer, ctx.cwd);
              repeatDescription = `Chosen containment: ${task.answer}. Recorded, NOT executed. Saved to incident_note.md`;
              ctx.ui.notify(`Incident note recorded with: ${task.answer}`, "info");
              break;
            }
            case "handoff": {
              writeShiftHandoff(task.answer, ctx.cwd);
              if (task.answer === "Short — 5 bullets") {
                repeatDescription = HANDOFF_EVENTS.slice(0, 5).map((ev) => `- ${ev}`).join("\n");
              } else {
                repeatDescription = "Full 10-event timeline saved to shift_handoff.md";
              }
              ctx.ui.notify(`Shift handoff drafted in format: ${task.answer}`, "info");
              break;
            }
          }
        } catch (e: any) {
          repeatDescription = `Task failed: ${e.message}`;
          ctx.ui.notify(`Task failed: ${e.message}`, "error");
        }

        /* —— Step 4: loop? Esc/Ctrl+C here exits (safe default) —— */
        const another = await runAskUser(
          {
            question: "Run another scenario?",
            description: repeatDescription,
            options: [{ label: REPEAT_LABEL }, { label: EXIT_LABEL }],
            allow_free_text: false,
          },
          ctx,
        );
        if (another.status === "cancelled") {
          ctx.ui.notify("Done.", "info");
          return;
        }
        if (another.status === "error") {
          ctx.ui.notify(another.message, "error");
          return;
        }
        if (another.answer === EXIT_LABEL) {
          ctx.ui.notify("Done.", "info");
          return;
        }
        // "Pick another scenario" → loop back to the scenario picker.
      }
    },
  });
}
