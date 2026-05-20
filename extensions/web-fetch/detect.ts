import { allElements, isHiddenElement, isInPageChrome } from "./dom.ts";
import { normalizeInlineText } from "./text.ts";

export interface DetectionOptions {
	/** Ignore controls/hidden nodes inside obvious page chrome such as nav/header/footer. */
	ignorePageChrome?: boolean;
}

export interface FoldableDetection {
	detected: number;
	staticDetails: number;
	dynamicControls: number;
	examples: string[];
}

export interface HiddenDetection {
	detected: number;
}

export interface FoldableSummary {
	detected: number;
	included: number;
	ignored: number;
	examples: string[];
}

export interface HiddenSummary {
	detected: number;
	included: number;
	ignored: number;
}

export function detectFoldables(root: ParentNode, options: DetectionOptions = {}): FoldableDetection {
	const examples: string[] = [];
	const elements = candidateElements(root, options);
	const details = elements.filter((element) => element.tagName.toLowerCase() === "details");
	for (const element of details) addExample(examples, element);

	const dynamicControls = getDynamicControls(root, options);
	for (const element of dynamicControls) addExample(examples, element);

	return {
		detected: details.length + dynamicControls.length,
		staticDetails: details.length,
		dynamicControls: dynamicControls.length,
		examples: dedupe(examples).slice(0, 5),
	};
}

export function detectHidden(root: ParentNode, options: DetectionOptions = {}): HiddenDetection {
	return {
		detected: candidateElements(root, options).filter((element) => isHiddenElement(element) && hasMeaningfulText(element)).length,
	};
}

export function summarizeFoldables(detection: FoldableDetection): FoldableSummary {
	return {
		detected: detection.detected,
		included: detection.staticDetails,
		ignored: detection.dynamicControls,
		examples: detection.examples,
	};
}

export function summarizeHidden(detection: HiddenDetection): HiddenSummary {
	return {
		detected: detection.detected,
		included: 0,
		ignored: detection.detected,
	};
}

export function foldableWarning(foldables: FoldableSummary): string {
	return `Detected ${foldables.detected} foldable/collapsible element(s) in selected scope; included ${foldables.included} static <details> section(s), but ${foldables.ignored} JavaScript/ARIA-controlled element(s) were not expanded by static extraction.`;
}

export function hiddenWarning(hidden: HiddenSummary): string {
	return `Detected ${hidden.detected} hidden-content element(s) in selected scope; removed identifiable hidden elements before extraction.`;
}

function getDynamicControls(root: ParentNode, options: DetectionOptions): Element[] {
	const rawControls = new Set<Element>();
	for (const element of candidateElements(root, options)) {
		if (element.tagName.toLowerCase() === "details") continue;
		if (isDynamicFoldableControl(element)) rawControls.add(element);
	}
	return pruneNestedControls(rawControls);
}

function candidateElements(root: ParentNode, options: DetectionOptions): Element[] {
	return allElements(root).filter((element) => !shouldSkipSignalElement(element, options));
}

function shouldSkipSignalElement(element: Element, options: DetectionOptions): boolean {
	return Boolean(options.ignorePageChrome && isInPageChrome(element));
}

function pruneNestedControls(rawControls: Set<Element>): Element[] {
	const controls = [...rawControls];
	return controls.filter((control) => !controls.some((other) => other !== control && other.contains(control)));
}

function isDynamicFoldableControl(element: Element): boolean {
	if ((element.getAttribute("aria-expanded") ?? "").toLowerCase() === "false") return true;
	if (element.hasAttribute("aria-controls")) return true;

	// Class/id names like "accordion" often live on containers. Only treat them
	// as foldable controls when the element itself is actionable, otherwise the
	// container can mask real nested buttons during nested-control pruning.
	if (!isLikelyControl(element)) return false;

	const classAndId = `${element.getAttribute("class") ?? ""} ${element.getAttribute("id") ?? ""}`;
	if (/accordion|collapse|expand|drawer|toggle/i.test(classAndId) && hasMeaningfulText(element)) return true;

	const text = normalizeInlineText(element.textContent ?? "").toLowerCase();
	return /^(show more|read more|expand_more|show less|view more)$/.test(text);
}

function isLikelyControl(element: Element): boolean {
	const tag = element.tagName.toLowerCase();
	return tag === "button" || tag === "a" || tag === "summary" || (element.getAttribute("role") ?? "").toLowerCase() === "button";
}

function addExample(examples: string[], element: Element): void {
	if (examples.length >= 5) return;
	const text = normalizeInlineText(element.textContent ?? "");
	if (text && hasMeaningfulText(element)) examples.push(text.slice(0, 240));
}

function hasMeaningfulText(element: Element): boolean {
	const text = normalizeInlineText(element.textContent ?? "");
	if (!text) return false;
	const compact = text.toLowerCase().replace(/[\s_-]+/g, "");
	if (/^(expandmore|openinnew|close|menu|home|search|help|feedback|morevert|chevronright|chevronleft)$/.test(compact)) return false;
	return /[\p{L}\p{N}]{2,}/u.test(text);
}

function dedupe(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}
