/**
 * Contract tests for `ask_user`.
 *
 * These tests drive the REAL interactive picker (including the real
 * `@earendil-works/pi-tui` `Editor` and key matching) through the tool's
 * `execute()` by mocking only `ctx.ui.custom()`. This exercises arrow
 * navigation, Enter selection, the free-text editor, Esc, and Ctrl+C.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import askUser from "../src/index.ts";

/* The command runs the detector and writes files; mock both so the command
 * tests stay hermetic (no Python needed and no files touched). */
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(() =>
      [
        "Threshold: 10 failures in 30 minutes",
        "Flagged IPs (2):",
        "  - 203.0.113.20",
        "  - 203.0.113.30",
        "",
        "All IP failure counts:",
        "  203.0.113.10: 7",
        "  203.0.113.20: 12",
        "  203.0.113.30: 25",
      ].join("\n"),
    ),
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn() };
});

/* ------------------------------------------------------------------ */
/*  Raw terminal key sequences                                         */
/*                                                                     */
/*  `matchesKey(data, keyId)` expects real terminal input in `data` —  */
/*  passing a `Key.*` id string does NOT match.                        */
/* ------------------------------------------------------------------ */

const KEY = {
  up: "\u001b[A",
  down: "\u001b[B",
  enter: "\r",
  escape: "\u001b",
  ctrlC: "\u0003",
} as const;

/* ------------------------------------------------------------------ */
/*  Test doubles                                                       */
/* ------------------------------------------------------------------ */

interface ToolDef {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  outputSchema?: unknown;
  exposure?: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
  renderCall?: (args: Record<string, unknown>, theme: unknown, context: unknown) => { render(width: number): string[] };
  renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
}

function registerTool(): ToolDef {
  let tool: ToolDef | undefined;
  const pi = {
    registerTool: (definition: ToolDef) => {
      tool = definition;
    },
    registerCommand: (_name: string, _definition: unknown) => {
      // no-op for tests
    },
  } as unknown as ExtensionAPI;
  askUser(pi);
  if (!tool) throw new Error("extension did not register a tool");
  return tool;
}

interface CommandDef {
  name: string;
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
}

function registerCommand(): CommandDef {
  let command: CommandDef | undefined;
  const pi = {
    registerTool: (_definition: ToolDef) => {
      // no-op for tests
    },
    registerCommand: (
      name: string,
      definition: { description?: string; handler: CommandDef["handler"] },
    ) => {
      command = { name, ...definition };
    },
  } as unknown as ExtensionAPI;
  askUser(pi);
  if (!command) throw new Error("extension did not register a command");
  return command;
}

/** A minimal theme whose helpers return the text unchanged. */
const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  style: (text: string) => text,
  colors: {},
  appearance: "dark" as const,
};

function fakeTui() {
  return {
    requestRender: vi.fn(),
    terminal: { columns: 100, rows: 30 },
    setFocus: vi.fn(),
    clearFocus: vi.fn(),
  };
}

/**
 * Build a mock ExtensionToolContext whose `ui.custom()` runs the real
 * component factory and then feeds it the scripted key sequence.
 */
function context(mode: string, keys: string[] = []) {
  const custom = vi.fn(
    (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => {
      handleInput: (data: string) => void;
    }) =>
      new Promise<unknown>((resolve) => {
        const done = (value: unknown) => resolve(value);
        const component = factory(fakeTui(), theme, {}, done);
        for (const key of keys) {
          component.handleInput(key);
        }
        // Safety net: if no handler called done(), resolve with a sentinel so a
        // missing branch fails fast instead of hanging.
        resolve({ __pending: true });
      }),
  );

  return { mode, hasUI: mode === "tui", ui: { custom } } as unknown as Parameters<
    ToolDef["execute"]
  >[4];
}

/**
 * Build a mock ExtensionCommandContext. `ui.custom()` runs the real picker
 * factory, records its first render, and feeds the next scripted key sequence.
 * `scripted` holds one key sequence per picker invocation, in call order
 * (scenario → task → repeat → …).
 */
function commandContext(scripted: string[][], cwd = "/tmp/hw4-ask-user-test") {
  const notifications: Array<{ message: string; type?: string }> = [];
  const renders: string[] = [];
  let call = 0;

  const custom = vi.fn(
    (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => {
      render: (width: number) => string[];
      handleInput: (data: string) => void;
    }) =>
      new Promise<unknown>((resolve) => {
        const done = (value: unknown) => resolve(value);
        const component = factory(fakeTui(), theme, {}, done);
        renders.push(component.render(100).join("\n"));
        const keys = scripted[call++] ?? [];
        for (const key of keys) component.handleInput(key);
        resolve({ __pending: true });
      }),
  );

  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd,
    ui: {
      custom,
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  };

  return { ctx, notifications, renders };
}

/* ------------------------------------------------------------------ */
/*  Registration                                                       */
/* ------------------------------------------------------------------ */

describe("ask_user extension", () => {
  it("mentions plain text in the tool description", () => {
    const tool = registerTool();
    expect(tool.description).toMatch(/plain text/i);
  });

  it("registers a model-callable ask_user tool", () => {
    const tool = registerTool();
    expect(tool.name).toBe("ask_user");
    expect(tool.exposure).toBe("model-only");
  });

  /* ---------------------------------------------------------------- */
  /*  Answered option                                                 */
  /* ---------------------------------------------------------------- */

  describe("answered option", () => {
    it("returns the highlighted option with a 1-based choice_index", async () => {
      const tool = registerTool();
      const ctx = context("tui", [KEY.down, KEY.enter]);

      const result = await tool.execute(
        "tc-1",
        {
          question: "Which containment step?",
          options: [
            { label: "Revoke sessions and force a password reset" },
            { label: "Block sign-in" },
            { label: "Monitor only" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        status: "answered",
        answer: "Block sign-in",
        choice_index: 2,
        free_text: false,
      });
      expect(result.content[0]?.text).toContain("Block sign-in");
      expect(result.content[0]?.text).toMatch(/recorded/i);
      expect(result.content[0]?.text).toMatch(/NOT been executed/i);
    });

    it("selects the first option on a bare Enter", async () => {
      const tool = registerTool();
      const ctx = context("tui", [KEY.enter]);

      const result = await tool.execute(
        "tc-1",
        { question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
        undefined,
        undefined,
        ctx,
      );

      expect(result.structuredContent).toMatchObject({ choice_index: 1, answer: "Yes" });
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Free text                                                       */
  /* ---------------------------------------------------------------- */

  describe("free text", () => {
    it("returns the typed answer with choice_index null and free_text true", async () => {
      const tool = registerTool();
      // 2 options -> free-text row is index 2; arrow down twice, Enter, type, Enter.
      const ctx = context("tui", [
        KEY.down,
        KEY.down,
        KEY.enter,
        "T",
        "e",
        "a",
        "l",
        KEY.enter,
      ]);

      const result = await tool.execute(
        "tc-2",
        { question: "Pick a colour", options: [{ label: "Red" }, { label: "Blue" }] },
        undefined,
        undefined,
        ctx,
      );

      expect(result.structuredContent).toEqual({
        status: "answered",
        answer: "Teal",
        choice_index: null,
        free_text: true,
      });
    });

    it("supports a free-text-only prompt when options are omitted", async () => {
      const tool = registerTool();
      const ctx = context("tui", [KEY.enter, "N", "o", "n", "e", KEY.enter]);

      const result = await tool.execute("tc-2", { question: "Anything to add?" }, undefined, undefined, ctx);

      expect(result.structuredContent).toEqual({
        status: "answered",
        answer: "None",
        choice_index: null,
        free_text: true,
      });
    });

    it("hides the free-text row when allow_free_text is false", async () => {
      const tool = registerTool();
      // Down twice clamps to the last real option.
      const ctx = context("tui", [KEY.down, KEY.down, KEY.enter]);

      const result = await tool.execute(
        "tc-2",
        {
          question: "Pick one",
          options: [{ label: "Yes" }, { label: "No" }],
          allow_free_text: false,
        },
        undefined,
        undefined,
        ctx,
      );

      expect(result.structuredContent).toEqual({
        status: "answered",
        answer: "No",
        choice_index: 2,
        free_text: false,
      });
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Editor semantics (Esc / Ctrl+C / empty submit)                  */
  /* ---------------------------------------------------------------- */

  describe("editor semantics", () => {
    const twoOptions = { question: "Pick one", options: [{ label: "Red" }, { label: "Blue" }] };

    it("Esc while typing returns to the options list (does not cancel)", async () => {
      const tool = registerTool();
      // free-text row is index 2; type, Esc back to the list, move up, Enter.
      const ctx = context("tui", [
        KEY.down,
        KEY.down,
        KEY.enter,
        "x",
        "x",
        KEY.escape,
        KEY.up,
        KEY.enter,
      ]);

      const result = await tool.execute("tc-6", twoOptions, undefined, undefined, ctx);

      expect(result.structuredContent).toEqual({
        status: "answered",
        answer: "Blue",
        choice_index: 2,
        free_text: false,
      });
    });

    it("Esc in the options list cancels with the exact message", async () => {
      const tool = registerTool();
      const ctx = context("tui", [KEY.escape]);

      const result = await tool.execute("tc-6", twoOptions, undefined, undefined, ctx);

      expect(result.structuredContent).toEqual({
        status: "cancelled",
        answer: "no decision has been supplied",
        choice_index: null,
        free_text: false,
      });
    });

    it("Ctrl+C while typing cancels with the exact message", async () => {
      const tool = registerTool();
      const ctx = context("tui", [KEY.down, KEY.down, KEY.enter, "x", KEY.ctrlC]);

      const result = await tool.execute("tc-6", twoOptions, undefined, undefined, ctx);

      expect(result.structuredContent).toEqual({
        status: "cancelled",
        answer: "no decision has been supplied",
        choice_index: null,
        free_text: false,
      });
    });

    it("Enter on an empty typed answer returns to the list", async () => {
      const tool = registerTool();
      // open the free-text editor, submit empty, then pick Blue from the list.
      const ctx = context("tui", [
        KEY.down,
        KEY.down,
        KEY.enter,
        KEY.enter,
        KEY.up,
        KEY.enter,
      ]);

      const result = await tool.execute("tc-6", twoOptions, undefined, undefined, ctx);

      expect(result.structuredContent).toEqual({
        status: "answered",
        answer: "Blue",
        choice_index: 2,
        free_text: false,
      });
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Cancellation                                                    */
  /* ---------------------------------------------------------------- */

  describe("markdown stripping", () => {
    it("strips ** and __ from question and option text in the picker render", async () => {
      const tool = registerTool();
      let renderedLines: string[] = [];

      const custom = vi.fn(
        (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => {
          render: (width: number) => string[];
          handleInput: (data: string) => void;
        }) =>
          new Promise<unknown>((resolve) => {
            const done = (value: unknown) => resolve(value);
            const component = factory(fakeTui(), theme, {}, done);
            renderedLines = component.render(100);
            resolve({ __pending: true });
          }),
      );

      const ctx = { mode: "tui", hasUI: true, ui: { custom } } as unknown as Parameters<
        ToolDef["execute"]
      >[4];

      await tool.execute(
        "tc-md",
        {
          question: "**Which** step?",
          options: [{ label: "__Block__ sign-in", description: "**Important** desc" }],
        },
        undefined,
        undefined,
        ctx,
      );

      const fullRender = renderedLines.join("\n");
      expect(fullRender).not.toContain("**");
      expect(fullRender).not.toContain("__");
      expect(fullRender).toContain("Which step?");
      expect(fullRender).toContain("Block sign-in");
      expect(fullRender).toContain("Important desc");
    });
  });

  describe("presets", () => {
    it("scenario preset lists the three scenarios", async () => {
      const tool = registerTool();
      const ctx = context("tui", [KEY.enter]);

      const result = await tool.execute(
        "tc-preset",
        { question: "ignored", preset: "scenario" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.structuredContent).toMatchObject({
        status: "answered",
        answer: "Brute-force detector — pick alert threshold",
        choice_index: 1,
      });
      expect(result.details?.question).toBe("Which scenario do you want to run?");
    });

    it("renders the scenario description in the picker", async () => {
      const tool = registerTool();
      let renderedLines: string[] = [];

      const custom = vi.fn(
        (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => {
          render: (width: number) => string[];
          handleInput: (data: string) => void;
        }) =>
          new Promise<unknown>((resolve) => {
            const done = (value: unknown) => resolve(value);
            const component = factory(fakeTui(), theme, {}, done);
            renderedLines = component.render(100);
            resolve({ __pending: true });
          }),
      );

      const ctx = { mode: "tui", hasUI: true, ui: { custom } } as unknown as Parameters<
        ToolDef["execute"]
      >[4];

      await tool.execute(
        "tc-preset",
        { question: "ignored", preset: "incident" },
        undefined,
        undefined,
        ctx,
      );

      const fullRender = renderedLines.join("\n");
      expect(fullRender).toContain("Impossible travel: alice@contoso.com");
      expect(fullRender).toContain("Which containment step should I take?");
      expect(fullRender).toContain("Revoke sessions and force a password reset");
      expect(fullRender).toContain("Recommended — immediately breaks active access");
    });

    it("bruteforce preset auto-fills question and options", async () => {
      const tool = registerTool();
      const ctx = context("tui", [KEY.down, KEY.enter]);

      const result = await tool.execute(
        "tc-preset",
        { question: "ignored", preset: "bruteforce" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.structuredContent).toMatchObject({
        status: "answered",
        answer: "10 failures in 30 minutes",
        choice_index: 2,
      });
      expect(result.details?.question).toBe("Which brute-force alert threshold should the detector use?");
    });

    it("incident preset auto-fills containment options", async () => {
      const tool = registerTool();
      const ctx = context("tui", [KEY.enter]);

      const result = await tool.execute(
        "tc-preset",
        { question: "ignored", preset: "incident" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.structuredContent).toMatchObject({
        status: "answered",
        answer: "Revoke sessions and force a password reset",
        choice_index: 1,
      });
    });

    it("handoff preset auto-fills format options", async () => {
      const tool = registerTool();
      const ctx = context("tui", [KEY.down, KEY.enter]);

      const result = await tool.execute(
        "tc-preset",
        { question: "ignored", preset: "handoff" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.structuredContent).toMatchObject({
        status: "answered",
        answer: "Detailed — full timeline",
        choice_index: 2,
      });
    });

    it("renders option descriptions for presets", async () => {
      const tool = registerTool();
      let renderedLines: string[] = [];

      const custom = vi.fn(
        (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => {
          render: (width: number) => string[];
          handleInput: (data: string) => void;
        }) =>
          new Promise<unknown>((resolve) => {
            const done = (value: unknown) => resolve(value);
            const component = factory(fakeTui(), theme, {}, done);
            renderedLines = component.render(100);
            resolve({ __pending: true });
          }),
      );

      const ctx = { mode: "tui", hasUI: true, ui: { custom } } as unknown as Parameters<
        ToolDef["execute"]
      >[4];

      await tool.execute(
        "tc-preset",
        { question: "ignored", preset: "bruteforce" },
        undefined,
        undefined,
        ctx,
      );

      const fullRender = renderedLines.join("\n");
      expect(fullRender).toContain("Recommended — flags the two larger bursts");
      expect(fullRender).toContain("203.0.113.20 (12 in ~22 min)");
    });

    it("errors on an unknown preset", async () => {
      const tool = registerTool();
      const result = await tool.execute(
        "tc-preset",
        { question: "ignored", preset: "unknown" as any },
        undefined,
        undefined,
        context("tui"),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/unknown preset/);
    });
  });

  describe("cancellation", () => {
    it("Esc cancels and returns exactly 'no decision has been supplied'", async () => {
      const tool = registerTool();
      const ctx = context("tui", [KEY.escape]);

      const result = await tool.execute(
        "tc-3",
        { question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] },
        undefined,
        undefined,
        ctx,
      );

      expect(result.structuredContent).toEqual({
        status: "cancelled",
        answer: "no decision has been supplied",
        choice_index: null,
        free_text: false,
      });
      expect(result.details?.answer).toBe("no decision has been supplied");
      expect(result.content[0]?.text).toContain("no decision has been supplied");
      expect(result.isError).toBeFalsy();
    });

    it("Ctrl+C cancels with the same exact message", async () => {
      const tool = registerTool();
      const ctx = context("tui", [KEY.ctrlC]);

      const result = await tool.execute(
        "tc-3",
        { question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] },
        undefined,
        undefined,
        ctx,
      );

      expect(result.structuredContent).toEqual({
        status: "cancelled",
        answer: "no decision has been supplied",
        choice_index: null,
        free_text: false,
      });
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Bad input                                                       */
  /* ---------------------------------------------------------------- */

  describe("bad input", () => {
    it("errors on an empty question", async () => {
      const tool = registerTool();
      const result = await tool.execute(
        "tc-4",
        { question: "   ", options: [{ label: "Yes" }] },
        undefined,
        undefined,
        context("tui"),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text?.toLowerCase()).toContain("question");
    });

    it("errors on duplicate option labels", async () => {
      const tool = registerTool();
      const result = await tool.execute(
        "tc-4",
        {
          question: "Pick",
          options: [{ label: "Yes" }, { label: "Yes" }],
        },
        undefined,
        undefined,
        context("tui"),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text?.toLowerCase()).toContain("duplicate");
    });

    it("errors on an empty option label", async () => {
      const tool = registerTool();
      const result = await tool.execute(
        "tc-4",
        { question: "Pick", options: [{ label: "Yes" }, { label: "  " }] },
        undefined,
        undefined,
        context("tui"),
      );
      expect(result.isError).toBe(true);
    });

    it("errors on an explicitly empty options array", async () => {
      const tool = registerTool();
      const result = await tool.execute(
        "tc-4",
        { question: "Pick", options: [] },
        undefined,
        undefined,
        context("tui"),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text?.toLowerCase()).toContain("option");
    });

    it("errors when free text is disabled and no options are offered", async () => {
      const tool = registerTool();
      // options omitted (not `[]`) so the free-text-disabled check is reached.
      const result = await tool.execute(
        "tc-4",
        { question: "Pick", allow_free_text: false },
        undefined,
        undefined,
        context("tui"),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text?.toLowerCase()).toContain("free text");
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Unavailable interactive UI                                      */
  /* ---------------------------------------------------------------- */

  describe("non-interactive mode", () => {
    it("returns an error when no interactive UI is available", async () => {
      const tool = registerTool();
      const result = await tool.execute(
        "tc-5",
        { question: "Pick", options: [{ label: "Yes" }] },
        undefined,
        undefined,
        context("json"),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text?.toLowerCase()).toContain("interactive");
    });
  });

  /* ---------------------------------------------------------------- */
  /*  renderCall — transcript line                                     */
  /* ---------------------------------------------------------------- */

  describe("renderCall", () => {
    it("shows preset options when a preset is used", () => {
      const tool = registerTool();
      const args = { question: "ignored", preset: "bruteforce" };
      const component = tool.renderCall!(args, theme, {} as any);
      const lines = component.render(100);
      const text = lines.join("\n");
      expect(text).toContain("5 failures in 10 minutes");
      expect(text).toContain("10 failures in 30 minutes");
      expect(text).toContain("20 failures in 1 hour");
    });

    it("shows provided options when no preset is used", () => {
      const tool = registerTool();
      const args = {
        question: "Pick",
        options: [{ label: "Red" }, { label: "Blue" }],
      };
      const component = tool.renderCall!(args, theme, {} as any);
      const lines = component.render(100);
      const text = lines.join("\n");
      expect(text).toContain("1. Red");
      expect(text).toContain("2. Blue");
      expect(text).toContain("3. Type your own answer…");
    });

    it("shows scenario preset options", () => {
      const tool = registerTool();
      const args = { question: "ignored", preset: "scenario" };
      const component = tool.renderCall!(args, theme, {} as any);
      const lines = component.render(100);
      const text = lines.join("\n");
      expect(text).toContain("Brute-force detector");
      expect(text).toContain("Impossible travel");
      expect(text).toContain("Shift handoff");
    });
  });

  /* ---------------------------------------------------------------- */
  /*  /ask_user command — free-text policy + repeat loop               */
  /* ---------------------------------------------------------------- */

  describe("/ask_user command", () => {
    const FREE_TEXT_ROW = "Type your own answer…";
    const SCENARIO_BF = [KEY.enter]; // option 1 — Bruteforce
    const SCENARIO_INC = [KEY.down, KEY.enter]; // option 2 — Incident
    const SCENARIO_HF = [KEY.down, KEY.down, KEY.enter]; // option 3 — Handoff
    const TASK_FIRST = [KEY.enter]; // option 1
    const REPEAT = [KEY.enter]; // option 1 — Pick another scenario
    const EXIT = [KEY.down, KEY.enter]; // option 2 — Exit

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("disables free text on the bruteforce task picker", async () => {
      const command = registerCommand();
      const { ctx, renders } = commandContext([SCENARIO_BF, TASK_FIRST, EXIT]);

      await command.handler("", ctx);

      expect(renders[1]).toContain("5 failures in 10 minutes");
      expect(renders[1]).not.toContain(FREE_TEXT_ROW);
    });

    it("keeps free text on the incident task picker", async () => {
      const command = registerCommand();
      const { ctx, renders } = commandContext([SCENARIO_INC, TASK_FIRST, EXIT]);

      await command.handler("", ctx);

      expect(renders[1]).toContain("Revoke sessions and force a password reset");
      expect(renders[1]).toContain(FREE_TEXT_ROW);
    });

    it("disables free text on the handoff task picker", async () => {
      const command = registerCommand();
      const { ctx, renders } = commandContext([SCENARIO_HF, TASK_FIRST, EXIT]);

      await command.handler("", ctx);

      expect(renders[1]).toContain("Short — 5 bullets");
      expect(renders[1]).not.toContain(FREE_TEXT_ROW);
    });

    it("asks 'Run another scenario?' without free text", async () => {
      const command = registerCommand();
      const { ctx, renders } = commandContext([SCENARIO_BF, TASK_FIRST, EXIT]);

      await command.handler("", ctx);

      expect(renders[2]).toContain("Run another scenario?");
      expect(renders[2]).toContain("Pick another scenario");
      expect(renders[2]).toContain("Exit");
      expect(renders[2]).not.toContain(FREE_TEXT_ROW);
    });

    it("shows flagged IPs in the repeat picker description after bruteforce", async () => {
      const command = registerCommand();
      const { ctx, renders } = commandContext([SCENARIO_BF, TASK_FIRST, EXIT]);

      await command.handler("", ctx);

      const repeatRender = renders[2].replace(/\n/g, " ");
      expect(repeatRender).toContain("Run another scenario?");
      expect(repeatRender).toContain("Flagged IPs (2):");
      expect(repeatRender).toContain("203.0.113.20");
      expect(repeatRender).toContain("203.0.113.30");
      expect(repeatRender).toContain("Full output:");
      expect(repeatRender).toContain("bruteforce_result.txt");
    });

    it("shows containment summary in the repeat picker description after incident", async () => {
      const command = registerCommand();
      const { ctx, renders } = commandContext([SCENARIO_INC, TASK_FIRST, EXIT]);

      await command.handler("", ctx);

      const repeatRender = renders[2].replace(/\n/g, " ");
      expect(repeatRender).toContain("Run another scenario?");
      expect(repeatRender).toContain("Chosen containment:");
      expect(repeatRender).toContain("Revoke sessions and force a password reset");
      expect(repeatRender).toContain("Recorded, NOT executed");
      expect(repeatRender).toContain("incident_note.md");
    });

    it("shows 5 bullets in the repeat picker description after short handoff", async () => {
      const command = registerCommand();
      const { ctx, renders } = commandContext([SCENARIO_HF, TASK_FIRST, EXIT]);

      await command.handler("", ctx);

      const repeatRender = renders[2].replace(/\n/g, " ");
      expect(repeatRender).toContain("Run another scenario?");
      expect(repeatRender).toContain("Firewall alert");
      expect(repeatRender).toContain("IDS signature");
      expect(repeatRender).toContain("Failed login spike");
      expect(repeatRender).toContain("Proxy block");
      expect(repeatRender).toContain("EDR alert");
    });

    it("shows timeline saved message in the repeat picker description after detailed handoff", async () => {
      const command = registerCommand();
      const { ctx, renders } = commandContext([
        SCENARIO_HF,
        [KEY.down, KEY.enter],
        EXIT,
      ]);

      await command.handler("", ctx);

      const repeatRender = renders[2].replace(/\n/g, " ");
      expect(repeatRender).toContain("Run another scenario?");
      expect(repeatRender).toContain("Full 10-event timeline saved to shift_handoff.md");
    });

    it("shows task failure in the repeat picker description when the detector fails", async () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error("Python not found");
      });
      const command = registerCommand();
      const { ctx, renders } = commandContext([SCENARIO_BF, TASK_FIRST, EXIT]);

      await command.handler("", ctx);

      const repeatRender = renders[2].replace(/\n/g, " ");
      expect(repeatRender).toContain("Run another scenario?");
      expect(repeatRender).toContain("Task failed:");
      expect(repeatRender).toContain("Python not found");
    });

    it("loops through two scenarios in a row, then exits with 'Done.'", async () => {
      const command = registerCommand();
      const { ctx, notifications } = commandContext([
        SCENARIO_BF,
        TASK_FIRST,
        REPEAT, // → back to the scenario picker
        SCENARIO_HF,
        TASK_FIRST,
        EXIT,
      ]);

      await command.handler("", ctx);

      const messages = notifications.map((n) => n.message);
      expect(messages.some((m) => m.includes("Brute-force detector ran"))).toBe(true);
      expect(messages.some((m) => m.includes("Shift handoff drafted"))).toBe(true);
      expect(messages.at(-1)).toBe("Done.");
      expect(vi.mocked(execSync)).toHaveBeenCalledTimes(1); // one brute-force run
      expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(2); // bf result + handoff
    });

    it("Esc at the repeat question exits with 'Done.' (not a cancellation)", async () => {
      const command = registerCommand();
      const { ctx, notifications } = commandContext([SCENARIO_BF, TASK_FIRST, [KEY.escape]]);

      await command.handler("", ctx);

      const messages = notifications.map((n) => n.message);
      expect(messages).toContain("Done.");
      expect(messages).not.toContain("no decision has been supplied");
    });

    it("cancel at the scenario picker still stops with the exact phrase", async () => {
      const command = registerCommand();
      const { ctx, notifications } = commandContext([[KEY.escape]]);

      await command.handler("", ctx);

      expect(notifications.map((n) => n.message)).toContain("no decision has been supplied");
      expect(vi.mocked(execSync)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    });

    it("cancel at the task picker still stops with the exact phrase", async () => {
      const command = registerCommand();
      const { ctx, notifications } = commandContext([SCENARIO_BF, [KEY.escape]]);

      await command.handler("", ctx);

      expect(notifications.map((n) => n.message)).toContain("no decision has been supplied");
      expect(vi.mocked(execSync)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    });
  });
});
