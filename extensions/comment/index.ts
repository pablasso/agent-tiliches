// Inspired by Badlogic's /comment workflow: open the latest assistant
// response in $VISUAL/$EDITOR, let the user annotate it, then send the
// edited comments back into the session.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type EditorResult =
	| { type: "saved"; text: string }
	| { type: "cancelled" }
	| { type: "failed"; message: string };

export default function (pi: ExtensionAPI) {
	pi.registerCommand("comment", {
		description: "Open $VISUAL/$EDITOR to comment on the latest assistant message",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/comment requires interactive TUI mode.", "error");
				return;
			}

			const latestAssistantText = getLatestAssistantText(ctx);
			if (!latestAssistantText) {
				ctx.ui.notify("No assistant message found to comment on.", "error");
				return;
			}

			const template = buildCommentTemplate(latestAssistantText);
			const editorResult = await openExternalEditor(ctx, template);

			if (editorResult.type === "failed") {
				ctx.ui.notify(editorResult.message, "error");
				return;
			}

			if (editorResult.type === "cancelled") {
				ctx.ui.notify("Comment cancelled.", "info");
				return;
			}

			const edited = stripInstructionComment(stripTrailingNewline(editorResult.text));
			const original = stripInstructionComment(template);
			if (edited.trim().length === 0 || edited.trim() === original.trim()) {
				ctx.ui.notify("No comment changes found.", "info");
				return;
			}

			const prompt = composeCommentPrompt(edited);
			const options = ctx.isIdle() ? undefined : { deliverAs: "followUp" as const };
			pi.sendUserMessage(prompt, options);
		},
	});
}

function getLatestAssistantText(ctx: ExtensionCommandContext): string | null {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;

		const message = entry.message as {
			role?: string;
			content?: unknown;
			stopReason?: string;
		};
		if (message.role !== "assistant") continue;

		const text = contentToText(message.content).trim();
		if (text.length > 0) return text;
	}

	return null;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const typedPart = part as { type?: unknown; text?: unknown };
			if (typedPart.type === "text" && typeof typedPart.text === "string") return typedPart.text;
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function buildCommentTemplate(latestAssistantText: string): string {
	return `<!--
/comment

Add your comments as normal Markdown anywhere below. The quoted block is the
latest assistant message for context. Save and quit to send your comments.
Leave this file unchanged to cancel.
-->

# Comments on latest assistant message

${quoteMarkdown(latestAssistantText)}
`;
}

function quoteMarkdown(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => (line.length === 0 ? ">" : `> ${line}`))
		.join("\n");
}

async function openExternalEditor(ctx: ExtensionCommandContext, initialText: string): Promise<EditorResult> {
	const editorCmd = (process.env.VISUAL || process.env.EDITOR || "").trim();
	if (!editorCmd) {
		return { type: "failed", message: "No editor configured. Set $VISUAL or $EDITOR." };
	}

	return ctx.ui.custom<EditorResult>((tui, theme, _keybindings, done) => {
		let settled = false;
		const finish = (result: EditorResult): void => {
			if (settled) return;
			settled = true;
			done(result);
		};

		queueMicrotask(async () => {
			let tempDir: string | undefined;
			let tuiStopped = false;
			let result: EditorResult;

			try {
				tempDir = await mkdtemp(join(tmpdir(), "pi-comment-"));
				const tempFile = join(tempDir, "comment.md");
				await writeFile(tempFile, initialText, "utf8");

				tui.stop();
				tuiStopped = true;

				process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);
				const { code, error } = await runEditor(editorCmd, tempFile);
				if (error) {
					result = { type: "failed", message: `Failed to launch editor: ${error.message}` };
				} else if (code !== 0) {
					result = { type: "cancelled" };
				} else {
					result = { type: "saved", text: await readFile(tempFile, "utf8") };
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result = { type: "failed", message: `Comment editor failed: ${message}` };
			} finally {
				if (tuiStopped) {
					tui.start();
					tui.requestRender(true);
				}
				if (tempDir) {
					await rm(tempDir, { recursive: true, force: true }).catch(() => {});
				}
			}

			finish(result);
		});

		return {
			render(_width: number): string[] {
				const title = theme.fg("accent", theme.bold("Opening /comment editor"));
				const editor = theme.fg("muted", editorCmd);
				return [
					title,
					`Launching ${editor} with a temporary Markdown file...`,
					"Save and quit to send comments; quit with a non-zero exit to cancel.",
				];
			},
			handleInput(): void {},
			invalidate(): void {},
		};
	});
}

function runEditor(editorCmd: string, filePath: string): Promise<{ code: number | null; error?: Error }> {
	const [editor, ...editorArgs] = editorCmd.split(/\s+/);
	return new Promise((resolve) => {
		const child = spawn(editor, [...editorArgs, filePath], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});

		child.on("error", (error) => resolve({ code: null, error }));
		child.on("close", (code) => resolve({ code }));
	});
}

function stripTrailingNewline(text: string): string {
	return text.replace(/\n$/, "");
}

function stripInstructionComment(text: string): string {
	return text.replace(/^<!--\n\/comment\n[\s\S]*?-->\n*/, "");
}

function composeCommentPrompt(editedMarkdown: string): string {
	return `I made comments on your latest response in an external editor.

In the Markdown below, quoted lines are your previous response for context and unquoted lines are my comments or edits. Please address the comments directly.

${editedMarkdown.trim()}`;
}
