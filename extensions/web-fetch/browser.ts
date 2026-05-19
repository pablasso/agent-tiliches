import { extractHtml } from "./extract.ts";
import { assessExtractionQuality } from "./quality.ts";
import { DEFAULT_TIMEOUT_MS, type NormalizedParams, type WebFetchDetails, type WebFetchRunResult } from "./types.ts";

export interface BrowserWebFetchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface BrowserExpansionSummary {
	detailsOpened: number;
	controlsClicked: number;
	controlsAttempted: number;
	skipped: number;
	errors: number;
	examples: string[];
}

const EMPTY_EXPANSION: BrowserExpansionSummary = {
	detailsOpened: 0,
	controlsClicked: 0,
	controlsAttempted: 0,
	skipped: 0,
	errors: 0,
	examples: [],
};

export async function runBrowserWebFetch(
	input: NormalizedParams,
	requestedUrl: string,
	options: BrowserWebFetchOptions = {},
): Promise<WebFetchRunResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const { chromium } = await loadPlaywright();
	let browser: any | undefined;
	let engine: "chromium" | "chrome" = "chromium";

	try {
		const launched = await launchChromium(chromium, options.signal);
		browser = launched.browser;
		engine = launched.engine;
	} catch (error) {
		throw enrichPlaywrightLaunchError(error);
	}

	try {
		const context = await withAbort(
			browser.newContext({
				locale: "en-US",
			}),
			options.signal,
			"creating Playwright browser context",
		);
		const page = await withAbort(context.newPage(), options.signal, "creating Playwright page");
		page.setDefaultTimeout(timeoutMs);
		page.setDefaultNavigationTimeout(timeoutMs);

		const response = await withAbort(
			page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
			options.signal,
			`navigating to ${requestedUrl}`,
		);
		await waitForNetworkQuiet(page, Math.min(5_000, timeoutMs), options.signal);

		const expansion = input.foldables === "ignore" ? EMPTY_EXPANSION : await expandRenderedFoldables(page, input, options.signal);
		if (input.hidden === "exclude") {
			await pruneHiddenRenderedElements(page, input, options.signal);
		}
		if (expansion.controlsClicked > 0 || expansion.detailsOpened > 0) {
			await waitForNetworkQuiet(page, Math.min(3_000, timeoutMs), options.signal);
		}

		const renderedHtml = await withAbort(page.content(), options.signal, "reading rendered HTML");
		const finalUrl = page.url() || requestedUrl;
		const extracted = extractHtml(renderedHtml, input, finalUrl);
		const output = extracted.output;
		const warnings = [...extracted.warnings];
		const status = response?.status?.() ?? 0;
		const headers = response?.headers?.() ?? {};
		const contentType = headers["content-type"];

		if (status && (status < 200 || status >= 300)) {
			warnings.push(`HTTP status ${status}`);
		}
		if (!output.trim()) {
			warnings.push("Browser-rendered extraction produced no readable content.");
		}
		if (expansion.detailsOpened > 0 || expansion.controlsClicked > 0) {
			warnings.push(
				`Browser rendering expanded ${expansion.detailsOpened} <details> section(s) and clicked ${expansion.controlsClicked} foldable control(s) in the selected scope.`,
			);
		}
		if (expansion.errors > 0) {
			warnings.push(`Browser rendering failed to click ${expansion.errors} candidate foldable control(s).`);
		}

		const extraction = mapBrowserExtraction(extracted.extraction);
		const quality = assessExtractionQuality({
			isHtml: true,
			rawHtml: renderedHtml,
			output,
			foldablesDetected: extracted.foldables.detected,
			foldablesIgnored: extracted.foldables.ignored,
			browserRendered: true,
		});
		if (quality.reasons.length > 0) {
			warnings.push(`Browser-rendered extraction may still be incomplete: ${quality.reasons[0]}`);
		}

		const details: WebFetchDetails = {
			url: requestedUrl,
			finalUrl,
			status,
			contentType,
			title: extracted.title || (await withAbort(page.title(), options.signal, "reading rendered title")) || undefined,
			mode: input.mode,
			format: input.format,
			scope: input.scope,
			extraction,
			bytesFetched: Buffer.byteLength(renderedHtml, "utf8"),
			outputBytes: Buffer.byteLength(output, "utf8"),
			outputLines: output ? output.split("\n").length : 0,
			responseTruncated: false,
			foldables: extracted.foldables,
			hidden: extracted.hidden,
			quality,
			warnings,
			browserRecommended: false,
			browserReason: undefined,
			browser: {
				engine,
				renderedHtmlBytes: Buffer.byteLength(renderedHtml, "utf8"),
				detailsOpened: expansion.detailsOpened,
				controlsClicked: expansion.controlsClicked,
				controlsAttempted: expansion.controlsAttempted,
				skipped: expansion.skipped,
				errors: expansion.errors,
				examples: expansion.examples,
			},
		};

		return { output, rawHtml: renderedHtml, details };
	} finally {
		await browser?.close?.().catch(() => undefined);
	}
}

async function loadPlaywright(): Promise<any> {
	try {
		return await import("playwright");
	} catch (error) {
		throw new Error(
			"web_fetch mode=browser requires the `playwright` package. Run `npm install` in the agent-tiliches repo, then run `npx playwright install chromium` if Chromium is not already installed.",
			{ cause: error },
		);
	}
}

async function launchChromium(chromium: any, signal?: AbortSignal): Promise<{ browser: any; engine: "chromium" | "chrome" }> {
	try {
		return {
			browser: await withAbort(chromium.launch({ headless: true }), signal, "launching Playwright Chromium"),
			engine: "chromium",
		};
	} catch (error) {
		if (!isMissingBundledBrowserError(error)) throw error;
	}

	return {
		browser: await withAbort(chromium.launch({ channel: "chrome", headless: true }), signal, "launching installed Google Chrome"),
		engine: "chrome",
	};
}

function enrichPlaywrightLaunchError(error: unknown): Error {
	if (error instanceof Error && /Executable doesn't exist|browserType\.launch|playwright install/i.test(error.message)) {
		return new Error(
			`web_fetch mode=browser could not launch Chromium or installed Google Chrome. Run \`npx playwright install chromium\` in the agent-tiliches repo. Original error: ${error.message}`,
			{ cause: error },
		);
	}
	return error instanceof Error ? error : new Error(String(error));
}

function isMissingBundledBrowserError(error: unknown): boolean {
	return error instanceof Error && /Executable doesn't exist|playwright install/i.test(error.message);
}

async function waitForNetworkQuiet(page: any, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	if (timeoutMs <= 0) return;
	await withAbort(page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined), signal, "waiting for network idle");
}

async function expandRenderedFoldables(page: any, input: NormalizedParams, signal?: AbortSignal): Promise<BrowserExpansionSummary> {
	return withAbort(
		page.evaluate(async ({ scope }) => {
			const summary = { detailsOpened: 0, controlsClicked: 0, controlsAttempted: 0, skipped: 0, errors: 0, examples: [] };
			const root = selectScopeRoot(scope);
			const clicked = new Set();
			const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

			for (const details of Array.from(root.querySelectorAll("details:not([open])"))) {
				if (shouldSkipElement(details, root, scope)) {
					summary.skipped++;
					continue;
				}
				details.setAttribute("open", "");
				summary.detailsOpened++;
				addExample(summary.examples, details);
			}

			for (let pass = 0; pass < 3; pass++) {
				const controls = collectFoldableControls(root, scope).filter((control) => !clicked.has(control));
				if (controls.length === 0) break;

				for (const control of controls.slice(0, 50 - summary.controlsAttempted)) {
					clicked.add(control);
					summary.controlsAttempted++;
					if (summary.controlsAttempted > 50) break;

					try {
						control.scrollIntoView?.({ block: "center", inline: "center" });
						control.click();
						summary.controlsClicked++;
						addExample(summary.examples, control);
						await sleep(75);
					} catch {
						summary.errors++;
					}
				}

				await sleep(125);
				if (summary.controlsAttempted >= 50) break;
			}

			return summary;

			function selectScopeRoot(scope) {
				if (scope === "page") return document.body || document.documentElement;
				return document.querySelector("main, [role='main'], article") || document.body || document.documentElement;
			}

			function collectFoldableControls(root, scope) {
				return Array.from(
					root.querySelectorAll("button, [role='button'], summary, a[aria-expanded], a[aria-controls], [aria-expanded], [aria-controls]"),
				).filter((element) => isFoldableControl(element, root, scope));
			}

			function isFoldableControl(element, root, scope) {
				if (shouldSkipElement(element, root, scope)) return false;
				if (!isVisible(element)) return false;
				if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;

				const tag = element.tagName.toLowerCase();
				const role = (element.getAttribute("role") || "").toLowerCase();
				const ariaExpanded = (element.getAttribute("aria-expanded") || "").toLowerCase();
				const hasAriaControls = element.hasAttribute("aria-controls");
				const likelyControl = tag === "button" || tag === "summary" || role === "button" || hasAriaControls || ariaExpanded === "false";
				if (!likelyControl) return false;

				if (tag === "summary") {
					const details = element.closest("details");
					return Boolean(details && !details.open);
				}

				if (tag === "a") {
					const href = element.getAttribute("href") || "";
					if (href && href !== "#" && !href.startsWith("#") && !hasAriaControls && ariaExpanded !== "false" && role !== "button") {
						return false;
					}
				}

				if (ariaExpanded === "false") return true;
				if (hasAriaControls && (tag === "button" || role === "button" || tag === "a")) return true;

				const classAndId = `${element.getAttribute("class") || ""} ${element.getAttribute("id") || ""}`;
				if ((tag === "button" || role === "button") && /accordion|collapse|expand|drawer|toggle/i.test(classAndId)) return true;

				const text = visibleText(element).toLowerCase();
				return (tag === "button" || role === "button") && /^(show more|read more|view more|see more|show all|expand_more|more)$/.test(text);
			}

			function shouldSkipElement(element, root, scope) {
				if (!root.contains(element)) return true;
				if (scope !== "main") return false;
				const chrome = element.closest("nav, header, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo'], [role='menu']");
				return Boolean(chrome && root.contains(chrome));
			}

			function isVisible(element) {
				const style = getComputedStyle(element);
				if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
				if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
				return element.getClientRects().length > 0;
			}

			function visibleText(element) {
				return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
			}

			function addExample(examples, element) {
				if (examples.length >= 5) return;
				const text = visibleText(element);
				if (text) examples.push(text.slice(0, 160));
			}
		}, { scope: input.scope }),
		signal,
		"expanding rendered foldables",
	);
}

async function pruneHiddenRenderedElements(page: any, input: NormalizedParams, signal?: AbortSignal): Promise<void> {
	await withAbort(
		page.evaluate(({ scope }) => {
			const root = scope === "page" ? document.body || document.documentElement : document.querySelector("main, [role='main'], article") || document.body || document.documentElement;
			const elements = Array.from(root.querySelectorAll("*")).reverse();
			for (const element of elements) {
				if (scope === "main" && element.closest("nav, header, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo'], [role='menu']")) {
					continue;
				}
				const style = getComputedStyle(element);
				const hidden = element.hidden || element.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden";
				if (hidden) element.remove();
			}
		}, { scope: input.scope }),
		signal,
		"pruning hidden rendered elements",
	);
}

function mapBrowserExtraction(extraction: WebFetchDetails["extraction"]): WebFetchDetails["extraction"] {
	if (extraction === "html-readability") return "browser-readability";
	if (extraction === "html-cleaned") return "browser-cleaned";
	return extraction;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, label: string): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError(signal, label));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal, label));
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

function abortError(signal: AbortSignal, label: string): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return new Error(`web_fetch browser mode aborted while ${label}: ${reason.message}`);
	if (typeof reason === "string") return new Error(`web_fetch browser mode aborted while ${label}: ${reason}`);
	return new Error(`web_fetch browser mode aborted while ${label}`);
}
