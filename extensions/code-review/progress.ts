import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ReviewProgressState, ReviewProgressUpdate } from "./runner.ts";

export interface ReviewProgressItem {
	id: string;
	label: string;
	subtitle?: string;
	state: ReviewProgressState;
	startedAt?: number;
	finishedAt?: number;
	detail?: string;
	logDir: string;
}

export class CodeReviewProgressPanel implements Component {
	private readonly controller = new AbortController();
	private readonly items = new Map<string, ReviewProgressItem>();
	private readonly order: string[];
	private readonly timer: NodeJS.Timeout;
	private readonly runDir: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private disposed = false;

	constructor(
		initialItems: ReviewProgressItem[],
		runDir: string,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
	) {
		this.runDir = runDir;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.order = initialItems.map((item) => item.id);
		for (const item of initialItems) this.items.set(item.id, { ...item });
		this.timer = setInterval(() => this.tui.requestRender(), 250);
		this.timer.unref?.();
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	update(update: ReviewProgressUpdate): void {
		const current = this.items.get(update.id);
		if (!current) this.order.push(update.id);
		if (current && isTerminalState(current.state)) return;
		this.items.set(update.id, { ...current, ...update });
		this.tui.requestRender();
	}

	cancel(): void {
		if (this.controller.signal.aborted) return;
		this.controller.abort();
		const now = Date.now();
		for (const [id, item] of this.items) {
			if (!isTerminalState(item.state)) this.items.set(id, { ...item, state: "cancelled", finishedAt: now });
		}
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (!this.keybindings.matches(data, "tui.select.cancel")) return;
		this.cancel();
	}

	render(width: number): string[] {
		const items = this.order.map((id) => this.items.get(id)).filter((item): item is ReviewProgressItem => Boolean(item));
		const complete = items.filter((item) => isTerminalState(item.state)).length;
		const active = items.some((item) => item.state === "in_progress");
		const title = active ? `Code review · ${complete}/${items.length} complete` : "Code review";
		const lines = [
			this.theme.fg("border", "─".repeat(Math.max(1, width))),
			this.theme.fg("accent", this.theme.bold(title)),
			"",
			...items.flatMap((item) => this.renderItem(item)),
			"",
			this.theme.fg("dim", `Logs: ${this.runDir}`),
			this.theme.fg("dim", this.controller.signal.aborted ? "Cancelling…" : "esc cancel"),
			this.theme.fg("border", "─".repeat(Math.max(1, width))),
		];
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), ""));
	}

	invalidate(): void {
		// Rendering is stateless and uses the current theme on every pass.
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
	}

	private renderItem(item: ReviewProgressItem): string[] {
		const duration = formatElapsed(item.startedAt, item.finishedAt);
		const suffix = duration ? ` · ${duration}` : "";
		let status: string;
		switch (item.state) {
			case "pending":
				status = `${this.theme.fg("dim", "○ pending")}  ${item.label}`;
				break;
			case "in_progress":
				status = `${this.theme.fg("accent", spinnerFrame())} ${this.theme.fg("accent", "in progress")}  ${item.label}${suffix}`;
				break;
			case "finished":
				status = `${this.theme.fg("success", "✓ finished")}  ${item.label}${suffix}`;
				break;
			case "handed_off":
				status = `${this.theme.fg("success", "→ handed off")}  ${item.label}${suffix}`;
				break;
			case "failed":
				status = `${this.theme.fg("error", "✗ failed")}  ${item.label}${suffix}`;
				break;
			case "cancelled":
				status = `${this.theme.fg("warning", "– cancelled")}  ${item.label}${suffix}`;
				break;
		}
		return item.subtitle ? [status, this.theme.fg("muted", `  ${item.subtitle}`)] : [status];
	}
}

function isTerminalState(state: ReviewProgressState): boolean {
	return state === "finished" || state === "handed_off" || state === "failed" || state === "cancelled";
}

function formatElapsed(startedAt: number | undefined, finishedAt: number | undefined): string {
	if (!startedAt) return "";
	const elapsedMs = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
	if (elapsedMs < 1_000) return "<1s";
	if (elapsedMs < 60_000) return `${Math.floor(elapsedMs / 1_000)}s`;
	const minutes = Math.floor(elapsedMs / 60_000);
	const seconds = Math.floor((elapsedMs % 60_000) / 1_000);
	return `${minutes}m ${seconds}s`;
}

function spinnerFrame(): string {
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	return frames[Math.floor(Date.now() / 100) % frames.length];
}
