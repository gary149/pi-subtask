import assert from "node:assert/strict";
import test from "node:test";
import {
	isSubtaskEditorFocused,
	shouldEnterSubtaskPanel,
} from "../index.ts";
import subtask from "../index.ts";

test("uses terminal input instead of replacing an existing editor", async () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
	let terminalInput: ((data: string) => { consume: true } | undefined) | undefined;
	let editorReplacements = 0;

	subtask({
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on(event: string, handler: (event: unknown, ctx: any) => Promise<void>) {
			handlers.set(event, handler);
		},
	} as any);

	await handlers.get("session_start")?.({ reason: "startup" }, {
		hasUI: true,
		ui: {
			onTerminalInput(handler: typeof terminalInput) {
				terminalInput = handler;
				return () => {};
			},
			getEditorText: () => "",
			setEditorComponent() {
				editorReplacements++;
			},
			setWidget() {},
		},
	});

	assert.equal(editorReplacements, 0);
	assert.equal(typeof terminalInput, "function");
	assert.equal(terminalInput?.("x"), undefined);
	assert.equal(shouldEnterSubtaskPanel("\x1b[B", "", true), true);
	assert.equal(shouldEnterSubtaskPanel("\x1b[B", "draft", true), false);
	assert.equal(shouldEnterSubtaskPanel("\x1b[B", "", false), false);
	assert.equal(shouldEnterSubtaskPanel("\x1b[1;1:3B", "", true), false);
});

test("only handles keys while the main editor has focus", () => {
	const editor = { getText() {}, setText() {} };
	const dialog = { handleInput() {} };
	const tui = {
		focusedComponent: editor,
		hasOverlay: () => false,
	};

	assert.equal(isSubtaskEditorFocused(tui as any, editor), true);
	tui.focusedComponent = dialog;
	assert.equal(isSubtaskEditorFocused(tui as any, editor), false);
	tui.focusedComponent = editor;
	tui.hasOverlay = () => true;
	assert.equal(isSubtaskEditorFocused(tui as any, editor), false);
});
