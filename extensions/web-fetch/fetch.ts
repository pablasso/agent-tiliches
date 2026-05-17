import { TextDecoder } from "node:util";
import { DEFAULT_TIMEOUT_MS, MAX_FETCH_BYTES } from "./types.ts";

export interface FetchTextOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxBytes?: number;
}

export interface FetchTextResult {
	finalUrl: string;
	status: number;
	statusText: string;
	contentType?: string;
	bytes: Uint8Array;
	body: string;
	responseTruncated: boolean;
}

export async function fetchText(url: string, options: FetchTextOptions = {}): Promise<FetchTextResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);

	const onAbort = () => controller.abort(options.signal?.reason ?? new Error("Aborted"));
	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		const response = await fetch(url, {
			redirect: "follow",
			signal: controller.signal,
			headers: {
				"user-agent": "Mozilla/5.0 (compatible; Pi web_fetch/0.1; +https://pi.dev)",
				accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8",
				"accept-language": "en-US,en;q=0.9",
			},
		});

		const contentType = response.headers.get("content-type") ?? undefined;
		if (contentType && !isTextualContentType(contentType)) {
			throw new Error(`web_fetch v1 only supports textual responses. Got Content-Type: ${contentType}`);
		}

		const { bytes, truncated } = await readResponseBytes(response, maxBytes, controller.signal);
		if (!contentType && isProbablyBinary(bytes)) {
			throw new Error("web_fetch v1 only supports textual responses; response appears to be binary.");
		}

		return {
			finalUrl: response.url || url,
			status: response.status,
			statusText: response.statusText,
			contentType,
			bytes,
			body: decodeBytes(bytes, contentType),
			responseTruncated: truncated,
		};
	} catch (error) {
		if (controller.signal.aborted) throw abortError(controller.signal);
		throw error;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

async function readResponseBytes(
	response: Response,
	maxBytes: number,
	signal: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	throwIfAborted(signal);

	if (!response.body) {
		const bytes = new Uint8Array(await withAbort(response.arrayBuffer(), signal));
		return bytes.byteLength > maxBytes ? { bytes: bytes.slice(0, maxBytes), truncated: true } : { bytes, truncated: false };
	}

	const reader = response.body.getReader();
	const onAbort = () => {
		reader.cancel(signal.reason).catch(() => undefined);
	};
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		const chunks: Uint8Array[] = [];
		let total = 0;
		let truncated = false;

		while (true) {
			throwIfAborted(signal);
			const { value, done } = await reader.read();
			throwIfAborted(signal);
			if (done) break;
			if (!value) continue;

			if (total + value.byteLength > maxBytes) {
				const remaining = maxBytes - total;
				if (remaining > 0) {
					chunks.push(value.slice(0, remaining));
					total += remaining;
				}
				truncated = true;
				await reader.cancel();
				break;
			}

			chunks.push(value);
			total += value.byteLength;
		}

		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}

		return { bytes, truncated };
	} catch (error) {
		if (signal.aborted) throw abortError(signal);
		throw error;
	} finally {
		signal.removeEventListener("abort", onAbort);
		try {
			reader.releaseLock();
		} catch {
			// Ignore release errors after cancellation.
		}
	}
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return new Error(`web_fetch failed: ${reason.message}`);
	if (typeof reason === "string") return new Error(`web_fetch failed: ${reason}`);
	return new Error("web_fetch was aborted");
}

function isTextualContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	return (
		normalized.startsWith("text/") ||
		normalized.includes("html") ||
		normalized.includes("json") ||
		normalized.includes("xml") ||
		normalized.includes("javascript") ||
		normalized.includes("svg") ||
		normalized.includes("x-www-form-urlencoded")
	);
}

function isProbablyBinary(bytes: Uint8Array): boolean {
	const sample = bytes.slice(0, Math.min(bytes.byteLength, 4096));
	if (sample.byteLength === 0) return false;
	let suspicious = 0;
	for (const byte of sample) {
		if (byte === 0) return true;
		if (byte < 8 || (byte > 13 && byte < 32)) suspicious++;
	}
	return suspicious / sample.byteLength > 0.2;
}

function decodeBytes(bytes: Uint8Array, contentType?: string): string {
	const charset = contentType?.match(/charset\s*=\s*([^;]+)/i)?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "utf-8";
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")}MB`;
}
