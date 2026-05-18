import { allElements, isHiddenElement } from "./dom.ts";
import { normalizeInlineText } from "./text.ts";
import type { Foldables, Hidden } from "./types.ts";

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

export function detectFoldables(root: ParentNode): FoldableDetection {
	const examples: string[] = [];
	const elements = allElements(root);
	const details = elements.filter((element) => element.tagName.toLowerCase() === "details");
	for (const element of details) addExample(examples, element);

	const dynamicControls = new Set<Element>();
	for (const element of elements) {
		if (element.tagName.toLowerCase() === "details") continue;
		if (isDynamicFoldableControl(element)) {
			dynamicControls.add(element);
			addExample(examples, element);
		}
	}

	return {
		detected: details.length + dynamicControls.size,
		staticDetails: details.length,
		dynamicControls: dynamicControls.size,
		examples: dedupe(examples).slice(0, 5),
	};
}

export function detectHidden(root: ParentNode): HiddenDetection {
	return { detected: allElements(root).filter(isHiddenElement).length };
}

export function summarizeFoldables(detection: FoldableDetection, mode: Foldables): FoldableSummary {
	const included = mode === "ignore" ? 0 : detection.staticDetails;
	return {
		detected: detection.detected,
		included,
		ignored: Math.max(0, detection.detected - included),
		examples: detection.examples,
	};
}

export function summarizeHidden(detection: HiddenDetection, mode: Hidden): HiddenSummary {
	const included = mode === "exclude" ? 0 : detection.detected;
	return {
		detected: detection.detected,
		included,
		ignored: Math.max(0, detection.detected - included),
	};
}

export function foldableWarning(detection: FoldableDetection, foldables: FoldableSummary, mode: Foldables): string {
	if (mode === "ignore") {
		return `Detected ${detection.detected} foldable/collapsible element(s) in selected scope; foldables=ignore removed static <details> content and did not expand JS/ARIA-controlled panels.`;
	}
	return `Detected ${detection.detected} foldable/collapsible element(s) in selected scope; included ${foldables.included} static <details> section(s), but ${foldables.ignored} JS/ARIA-controlled element(s) were not expanded by static extraction.`;
}

export function hiddenWarning(detection: HiddenDetection, hidden: HiddenSummary, mode: Hidden): string {
	if (mode === "exclude") {
		return `Detected ${detection.detected} hidden-content element(s) in selected scope; removed identifiable hidden elements before extraction.`;
	}
	return `Detected ${detection.detected} hidden-content element(s) in selected scope; included ${hidden.included} because hidden=${mode}.`;
}

function isDynamicFoldableControl(element: Element): boolean {
	if ((element.getAttribute("aria-expanded") ?? "").toLowerCase() === "false") return true;
	if (element.hasAttribute("aria-controls")) return true;

	const classAndId = `${element.getAttribute("class") ?? ""} ${element.getAttribute("id") ?? ""}`;
	if (/accordion|collapse|expand|drawer|toggle/i.test(classAndId)) return true;

	if (!isLikelyControl(element)) return false;
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
	if (text) examples.push(text.slice(0, 240));
}

function dedupe(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}
