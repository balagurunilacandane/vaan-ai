// The line editor replaced readline, which means every binding people already
// have in their fingers is now ours to get right. A prompt where ctrl-w does
// the wrong thing feels broken even when the agent behind it works perfectly.

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  applyKey,
  emptyState,
  PROMPT,
  renderFrame,
  visibleLength,
  type EditorState,
} from "../src/cli/editor.js";
import { createTheme } from "../src/cli/theme.js";

const plain = createTheme({ isTTY: false, env: {} });

/** Type a string one keypress at a time, the way a person would. */
function type(text: string, from: EditorState = emptyState()): EditorState {
  let state = from;
  for (const character of text) {
    const action = applyKey(state, character, { name: character });
    if (action.kind === "edit") state = action.state;
  }
  return state;
}

const press = (state: EditorState, name: string, extra: Record<string, boolean> = {}) =>
  applyKey(state, "", { name, ...extra });

test("typing inserts at the cursor", () => {
  const state = type("hello");
  assert.equal(state.value, "hello");
  assert.equal(state.cursor, 5);
});

test("the cursor moves and inserts where it is", () => {
  let state = type("helo");
  const back = press(state, "left");
  assert.equal(back.kind, "edit");
  state = back.kind === "edit" ? back.state : state;
  state = type("l", state);
  assert.equal(state.value, "hello");
});

test("backspace at the start of the line does nothing", () => {
  const state = emptyState();
  const action = press(state, "backspace");
  assert.equal(action.kind, "edit");
  assert.equal(action.kind === "edit" ? action.state.value : "x", "");
});

test("ctrl-a and ctrl-e jump to the ends", () => {
  const typed = type("some text");
  const home = press(typed, "a", { ctrl: true });
  assert.equal(home.kind === "edit" ? home.state.cursor : -1, 0);
  const end = press(home.kind === "edit" ? home.state : typed, "e", { ctrl: true });
  assert.equal(end.kind === "edit" ? end.state.cursor : -1, 9);
});

test("ctrl-u clears to the start, ctrl-k to the end", () => {
  let state = type("delete before me");
  const home = press(state, "left");
  state = home.kind === "edit" ? home.state : state;

  const killLeft = press(state, "u", { ctrl: true });
  assert.equal(killLeft.kind === "edit" ? killLeft.state.value : "", "e");
  assert.equal(killLeft.kind === "edit" ? killLeft.state.cursor : -1, 0);

  const killRight = press(state, "k", { ctrl: true });
  assert.equal(killRight.kind === "edit" ? killRight.state.value : "", "delete before m");
});

test("ctrl-w deletes the word behind the cursor", () => {
  const state = type("git commit --amend");
  const action = press(state, "w", { ctrl: true });
  assert.equal(action.kind === "edit" ? action.state.value : "", "git commit ");
});

test("ctrl-w over trailing space eats the space and the word", () => {
  const state = type("npm test   ");
  const action = press(state, "w", { ctrl: true });
  assert.equal(action.kind === "edit" ? action.state.value : "", "npm ");
});

test("ctrl-c cancels the line; ctrl-d on an empty line ends the session", () => {
  assert.equal(press(type("half typed"), "c", { ctrl: true }).kind, "interrupt");
  assert.equal(press(emptyState(), "d", { ctrl: true }).kind, "eof");
});

test("ctrl-d with text on the line is a forward delete, not an exit", () => {
  let state = type("abc");
  const home = press(state, "a", { ctrl: true });
  state = home.kind === "edit" ? home.state : state;
  const action = press(state, "d", { ctrl: true });
  assert.equal(action.kind, "edit", "must not quit when there is text to delete");
  assert.equal(action.kind === "edit" ? action.state.value : "", "bc");
});

test("enter submits trimmed, and remembers it", () => {
  const action = press(type("  run the tests  "), "return");
  assert.equal(action.kind, "submit");
  if (action.kind !== "submit") return;
  assert.equal(action.value, "run the tests");
  assert.deepEqual(action.state.history, ["run the tests"]);
  assert.equal(action.state.value, "", "the line is cleared for the next one");
});

test("history does not record the same line twice in a row", () => {
  const first = press(type("npm test"), "return");
  if (first.kind !== "submit") throw new Error("expected submit");
  const second = press(type("npm test", first.state), "return");
  if (second.kind !== "submit") throw new Error("expected submit");
  assert.deepEqual(second.state.history, ["npm test"]);
});

test("up and down walk history and put the draft back", () => {
  let state = emptyState(["first", "second"]);
  state = type("half wri", state);

  const up = press(state, "up");
  state = up.kind === "edit" ? up.state : state;
  assert.equal(state.value, "second");
  assert.equal(state.cursor, 6, "cursor lands at the end of the recalled line");

  const again = press(state, "up");
  state = again.kind === "edit" ? again.state : state;
  assert.equal(state.value, "first");

  const down = press(state, "down");
  state = down.kind === "edit" ? down.state : state;
  assert.equal(state.value, "second");

  const back = press(state, "down");
  state = back.kind === "edit" ? back.state : state;
  assert.equal(state.value, "half wri", "the unsent draft comes back");
});

test("up at the oldest entry stays there rather than wrapping", () => {
  const state = emptyState(["only"]);
  const up = press(state, "up");
  const past = press(up.kind === "edit" ? up.state : state, "up");
  assert.equal(past.kind === "edit" ? past.state.value : "", "only");
});

test("control sequences are never inserted as text", () => {
  // A stray escape sequence typed into the buffer is how a prompt ends up
  // sending ANSI codes to a model.
  const action = applyKey(emptyState(), "[A", { name: "up" });
  assert.equal(action.kind === "edit" ? action.state.value : "x", "");
});

// --- the frame -------------------------------------------------------------

test("the frame is a rule, the input, a rule and a hint line", () => {
  const frame = renderFrame(
    { state: type("hello"), width: 40, hint: "/help", status: "↑1.2k ↓340", placeholder: "ask" },
    plain,
  );
  const lines = frame.text.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0] ?? "", /^ ─+$/);
  assert.match(lines[1] ?? "", /^ > hello$/);
  assert.match(lines[2] ?? "", /^ ─+$/);
  assert.match(lines[3] ?? "", /\/help.*↑1\.2k ↓340/);
  assert.equal(frame.rows, 4);
});

test("an empty line shows the placeholder, not nothing", () => {
  const frame = renderFrame(
    { state: emptyState(), width: 40, hint: "", status: "", placeholder: "ask anything" },
    plain,
  );
  assert.match(frame.text, /ask anything/);
});

test("the cursor sits just after the prompt on an empty line", () => {
  const frame = renderFrame(
    { state: emptyState(), width: 40, hint: "", status: "", placeholder: "" },
    plain,
  );
  assert.equal(frame.cursorRow, 1, "the input row");
  // One for the leading space, then past "> ".
  assert.equal(frame.cursorColumn, 1 + PROMPT.length);
});

test("a wrapped line puts the cursor on the row it wrapped onto", () => {
  // The case that breaks naive cursor maths: input longer than the terminal.
  const state = type("x".repeat(45));
  const frame = renderFrame(
    { state, width: 20, hint: "", status: "", placeholder: "" },
    plain,
  );
  assert.ok(frame.rows > 4, "a wrapped input takes more rows than a short one");
  assert.equal(frame.cursorRow, 1 + Math.floor((PROMPT.length + 45) / 20));
});

test("the hint and status never overlap, however narrow the terminal", () => {
  const frame = renderFrame(
    {
      state: emptyState(),
      width: 24,
      hint: "/help for commands",
      status: "↑12.4k ↓780",
      placeholder: "",
    },
    plain,
  );
  const footer = frame.text.split("\n")[3] ?? "";
  assert.match(footer, /\/help for commands\s+↑12\.4k ↓780/);
});

test("visibleLength ignores colour, so layout survives a theme", () => {
  const colour = createTheme({ isTTY: true, env: {} });
  assert.equal(visibleLength(colour.lime("hello")), 5);
  assert.equal(visibleLength("hello"), 5);
});
