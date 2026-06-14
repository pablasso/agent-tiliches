import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import type { ParsedDiff } from "./diff.ts";
import type { SubmittedReviewComment } from "./prompt.ts";

export type ReviewServerResult =
	| { type: "submit"; comments: SubmittedReviewComment[] }
	| { type: "cancel" }
	| { type: "timeout" }
	| { type: "closed"; reason?: string };

export interface ReviewServer {
	url: string;
	result: Promise<ReviewServerResult>;
	close(): Promise<void>;
	abort(reason?: string): Promise<void>;
}

export interface StartReviewServerOptions {
	cwd: string;
	gitCommand: string;
	timeoutMs?: number;
}

interface WebAssets {
	indexHtml: string;
	appJs: string;
	styleCss: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_COMMENTS = 500;
const MAX_COMMENT_CHARS = 4000;

export async function startReviewServer(diff: ParsedDiff, options: StartReviewServerOptions): Promise<ReviewServer> {
	const token = randomBytes(32).toString("base64url");
	const reviewId = randomBytes(8).toString("hex");
	const assets = await loadAssets();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let closed = false;
	let settled = false;
	let timeout: NodeJS.Timeout | undefined;
	let resolveResult: (result: ReviewServerResult) => void = () => undefined;
	const result = new Promise<ReviewServerResult>((resolve) => {
		resolveResult = resolve;
	});

	const server = createServer(async (req, res) => {
		try {
			await handleRequest(req, res);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			respondJson(res, 500, { error: message });
		}
	});

	const finish = (value: ReviewServerResult): void => {
		if (settled) return;
		settled = true;
		if (timeout) clearTimeout(timeout);
		resolveResult(value);
		setTimeout(() => {
			void close();
		}, 50).unref?.();
	};

	async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;

		if (req.method === "GET" && (path === "/" || path === "/index.html")) {
			if (!isAuthorizedGet(req, url, token)) return respondText(res, 403, "Forbidden\n", "text/plain; charset=utf-8");
			return respondText(res, 200, assets.indexHtml, "text/html; charset=utf-8");
		}

		if (req.method === "GET" && path === "/app.js") {
			return respondText(res, 200, assets.appJs, "text/javascript; charset=utf-8");
		}

		if (req.method === "GET" && path === "/style.css") {
			return respondText(res, 200, assets.styleCss, "text/css; charset=utf-8");
		}

		if (req.method === "GET" && path === "/favicon.ico") {
			res.writeHead(204, baseHeaders());
			res.end();
			return;
		}

		if (req.method === "GET" && path === "/api/review") {
			if (!isAuthorizedGet(req, url, token)) return respondJson(res, 403, { error: "Forbidden" });
			return respondJson(res, 200, {
				id: reviewId,
				cwd: options.cwd,
				gitCommand: options.gitCommand,
				generatedAt: new Date().toISOString(),
				stats: diff.stats,
				files: diff.files,
			});
		}

		if (req.method === "POST" && path === "/api/submit") {
			const body = await readJsonBody(req);
			if (!isAuthorizedPost(req, body, token)) return respondJson(res, 403, { error: "Forbidden" });
			const comments = normalizeSubmittedComments(body);
			respondJson(res, 200, { ok: true, comments: comments.length });
			finish({ type: "submit", comments });
			return;
		}

		if (req.method === "POST" && path === "/api/cancel") {
			const body = await readJsonBody(req);
			if (!isAuthorizedPost(req, body, token)) return respondJson(res, 403, { error: "Forbidden" });
			respondJson(res, 200, { ok: true });
			finish({ type: "cancel" });
			return;
		}

		respondJson(res, 404, { error: "Not found" });
	}

	await listen(server);
	const address = server.address();
	if (!address || typeof address !== "object") throw new Error("Diff review server did not bind to a TCP port.");

	timeout = setTimeout(() => finish({ type: "timeout" }), timeoutMs);
	timeout.unref?.();

	async function close(): Promise<void> {
		if (closed) return;
		closed = true;
		await closeServer(server);
	}

	return {
		url: `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(token)}`,
		result,
		close,
		async abort(reason = "closed") {
			finish({ type: "closed", reason });
			await close();
		},
	};
}

export function openReviewUrl(url: string): string {
	if (process.platform === "darwin") {
		if (hasMacApp("Google Chrome")) {
			launchDetached("open", ["-na", "Google Chrome", "--args", `--app=${url}`]);
			return "Google Chrome app window";
		}
		launchDetached("open", [url]);
		return "default browser";
	}

	if (process.platform === "win32") {
		launchDetached("cmd", ["/c", "start", "", url]);
		return "default browser";
	}

	launchDetached("xdg-open", [url]);
	return "default browser";
}

async function loadAssets(): Promise<WebAssets> {
	const webRoot = new URL("./web/", import.meta.url);
	const [indexHtml, appJs, styleCss] = await Promise.all([
		readFile(new URL("index.html", webRoot), "utf8"),
		readFile(new URL("app.js", webRoot), "utf8"),
		readFile(new URL("style.css", webRoot), "utf8"),
	]);
	return { indexHtml, appJs, styleCss };
}

function listen(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, "127.0.0.1");
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function normalizeSubmittedComments(body: unknown): SubmittedReviewComment[] {
	if (!isRecord(body) || !Array.isArray(body.comments)) throw new Error("Expected JSON body with comments array.");
	if (body.comments.length > MAX_COMMENTS) throw new Error(`Too many comments; maximum is ${MAX_COMMENTS}.`);

	const comments: SubmittedReviewComment[] = [];
	for (const item of body.comments) {
		if (!isRecord(item)) continue;
		const lineKey = typeof item.lineKey === "string" ? item.lineKey : "";
		const text = typeof item.body === "string" ? item.body.trim() : "";
		if (!lineKey || !text) continue;
		if (lineKey.length > 200) throw new Error("Comment line key is too long.");
		if (text.length > MAX_COMMENT_CHARS) throw new Error(`Comment is too long; maximum is ${MAX_COMMENT_CHARS} characters.`);
		comments.push({ lineKey, body: text });
	}
	return comments;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const body = await readRequestBody(req, MAX_BODY_BYTES);
	if (!body.trim()) return {};
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new Error("Request body is not valid JSON.");
	}
}

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let tooLarge = false;

		req.on("data", (chunk: Buffer) => {
			total += chunk.byteLength;
			if (total > maxBytes) {
				tooLarge = true;
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (tooLarge) return reject(new Error(`Request body is too large; maximum is ${maxBytes} bytes.`));
			resolve(Buffer.concat(chunks).toString("utf8"));
		});

		req.on("error", reject);
	});
}

function isAuthorizedGet(req: IncomingMessage, url: URL, expectedToken: string): boolean {
	return tokenMatches(url.searchParams.get("token"), expectedToken) || tokenMatches(headerToken(req), expectedToken);
}

function isAuthorizedPost(req: IncomingMessage, body: unknown, expectedToken: string): boolean {
	return tokenMatches(headerToken(req), expectedToken) || tokenMatches(bodyToken(body), expectedToken);
}

function headerToken(req: IncomingMessage): string | undefined {
	const value = req.headers["x-diff-review-token"];
	if (Array.isArray(value)) return value[0];
	return value;
}

function bodyToken(body: unknown): string | undefined {
	return isRecord(body) && typeof body.token === "string" ? body.token : undefined;
}

function tokenMatches(candidate: string | null | undefined, expected: string): boolean {
	if (!candidate) return false;
	const candidateBuffer = Buffer.from(candidate);
	const expectedBuffer = Buffer.from(expected);
	if (candidateBuffer.byteLength !== expectedBuffer.byteLength) return false;
	return timingSafeEqual(candidateBuffer, expectedBuffer);
}

function respondJson(res: ServerResponse, status: number, value: unknown): void {
	respondText(res, status, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8");
}

function respondText(res: ServerResponse, status: number, value: string, contentType: string): void {
	res.writeHead(status, baseHeaders(contentType));
	res.end(value);
}

function baseHeaders(contentType?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"cache-control": "no-store",
		"content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
	};
	if (contentType) headers["content-type"] = contentType;
	return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMacApp(name: string): boolean {
	return existsSync(`/Applications/${name}.app`) || existsSync(`${homedir()}/Applications/${name}.app`);
}

function launchDetached(command: string, args: string[]): void {
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// Opening the browser is best-effort; the command handler also shows the URL.
	}
}
