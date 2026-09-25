import { attention, isOpen, type Observation, type Run } from "./core.ts";
import { observeAgent, type LiveAgent } from "./herdr.ts";

interface MonitorOptions {
	getRun(): Run | undefined;
	sample(run: Run, signal: AbortSignal): Promise<LiveAgent[]>;
	record(assignmentId: string, observation: Observation): void;
	refresh(): void;
	intervalMs?: number;
	now?: () => number;
}

/** Local polling and cancellable waiting, never agent execution or automatic model continuations. */
export class FactoryMonitor {
	private options: MonitorOptions;
	private timer?: ReturnType<typeof setInterval>;
	private controller?: AbortController;
	private generation = 0;
	private inFlight?: Promise<void>;
	private waiting?: (reason: string) => void;
	lastCheckedAt?: number;

	constructor(options: MonitorOptions) { this.options = options; }
	private now(): number { return this.options.now?.() ?? Date.now(); }

	start(): void {
		if (this.controller) return;
		this.controller = new AbortController();
		this.timer = setInterval(() => { void this.poll().catch(() => {}); }, this.options.intervalMs ?? 5_000);
		this.timer.unref?.();
	}

	stop(): void {
		this.generation++;
		this.controller?.abort();
		this.controller = undefined;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.inFlight = undefined;
		this.lastCheckedAt = undefined;
		this.cancelWait("Monitoring paused because the session/run changed. Helpers were not stopped.");
	}

	async poll(): Promise<void> {
		if (!this.controller) return;
		if (this.inFlight) return this.inFlight;
		const pending = this.sample(this.generation, this.controller.signal);
		this.inFlight = pending;
		try { await pending; }
		finally { if (this.inFlight === pending) this.inFlight = undefined; }
	}

	private async sample(generation: number, signal: AbortSignal): Promise<void> {
		const initial = this.options.getRun();
		if (!initial || initial.finish) return;
		const assignments = initial.assignments.filter(isOpen);
		let agents: LiveAgent[] = [];
		let failure: string | undefined;
		if (assignments.length) {
			try { agents = await this.options.sample(initial, signal); }
			catch (error) { failure = error instanceof Error ? error.message : String(error); }
		}
		if (generation !== this.generation || signal.aborted) return;
		const run = this.options.getRun();
		if (!run || run.id !== initial.id || run.finish) return;
		this.lastCheckedAt = this.now();
		for (const original of assignments) {
			const current = this.options.getRun()?.assignments.find((a) => a.id === original.id);
			if (!current || !isOpen(current)) continue;
			const observed = failure ? { state: "unavailable" as const, detail: failure } : observeAgent(current.agent, agents);
			if (current.observation?.state !== observed.state || current.observation?.detail !== observed.detail) {
				this.options.record(current.id, { ...observed, at: new Date(this.lastCheckedAt).toISOString() });
			}
		}
		this.changed();
	}

	changed(): void {
		this.options.refresh();
		const reason = this.reason();
		if (reason) this.waiting?.(reason);
	}

	private reason(): string | undefined {
		const run = this.options.getRun();
		if (!run) return "No owned factory run is active.";
		if (run.finish) return `Run already finished: ${run.finish.outcome}.`;
		const notices = attention(run);
		return notices.length ? notices.join("\n") : undefined;
	}

	async wait(signal?: AbortSignal, timeoutSeconds?: number): Promise<string> {
		if (this.waiting) throw new Error("A factory wait is already active.");
		if (!this.controller) return "Monitoring is paused. Helpers were not stopped.";
		if (signal?.aborted) return "Wait cancelled. Helpers were not stopped.";
		return new Promise<string>((resolve) => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const finish = (message: string): void => {
				if (this.waiting !== finish) return;
				this.waiting = undefined;
				if (timeout) clearTimeout(timeout);
				signal?.removeEventListener("abort", aborted);
				resolve(message);
			};
			const aborted = (): void => finish("Wait cancelled. Helpers were not stopped; do not resume waiting until the user asks.");
			// Register before polling: cancellation must also work while a CLI request is pending.
			this.waiting = finish;
			signal?.addEventListener("abort", aborted, { once: true });
			if (signal?.aborted) aborted();
			if (timeoutSeconds !== undefined && this.waiting) {
				timeout = setTimeout(() => finish("Wait timed out; work is still open. This is not a completion or failure signal."), timeoutSeconds * 1_000);
			}
			if (this.waiting) void this.poll().then(() => {
				const reason = this.reason();
				if (reason) finish(reason);
			}).catch((error) => finish(`Monitoring failed: ${error instanceof Error ? error.message : String(error)}`));
		});
	}

	cancelWait(reason = "Wait cancelled by the user. Helpers were not stopped; do not resume waiting until asked."): void {
		this.waiting?.(reason);
	}
}
