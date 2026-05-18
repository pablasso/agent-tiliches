import { allElements, isHiddenElement, isInPageChrome } from "./dom.ts";
import { normalizeInlineText } from "./text.ts";
import type { Foldables, Hidden } from "./types.ts";

export interface DetectionOptions {
	/** Ignore controls/hidden nodes inside obvious page chrome such as nav/header/footer. */
	ignorePageChrome?: boolean;
}

export interface FoldableDetection {
	detected: number;
	staticDetails: number;
	dynamicControls: number;
	/** Hidden aria-controls targets that can be included without running JavaScript. */
	controlledPanels: number;
	examples: string[];
}

export interface HiddenDetection {
	detected: number;
}

export interface FoldableSummary {
	detected: number;
	included: number;
	ignored: number;
	controlledPanelsIncluded: number;
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
		controlledPanels: getControlledPanelTargets(root, dynamicControls, options).size,
		examples: dedupe(examples).slice(0, 5),
	};
}

export function detectHidden(root: ParentNode, options: DetectionOptions = {}): HiddenDetection {
	return {
		detected: candidateElements(root, options).filter((element) => isHiddenElement(element) && hasMeaningfulText(element)).length,
	};
}

/**
 * Statically include simple aria-controls panels by removing common hidden markers.
 * This only handles content already present in the fetched HTML; it does not run JS.
 */
export function expandControlledPanels(root: ParentNode, options: DetectionOptions = {}): number {
	const dynamicControls = getDynamicControls(root, options);
	const targets = getControlledPanelTargets(root, dynamicControls, options);
	for (const target of targets) {
		unhideElementAndAncestors(target, root);
	}
	return targets.size;
}

export function summarizeFoldables(
	detection: FoldableDetection,
	mode: Foldables,
	controlledPanelsIncluded = 0,
): FoldableSummary {
	const included = mode === "ignore" ? 0 : detection.staticDetails + (mode === "include" ? controlledPanelsIncluded : 0);
	return {
		detected: detection.detected,
		included,
		ignored: Math.max(0, detection.detected - included),
		controlledPanelsIncluded: mode === "include" ? controlledPanelsIncluded : 0,
		examples: detection.examples,
	};
}

export function summarizeHidden(detection: HiddenDetection, mode: Hidden, foldableControlledIncluded = 0): HiddenSummary {
	const included = mode === "exclude" ? Math.min(detection.detected, foldableControlledIncluded) : detection.detected;
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
	if (mode === "include") {
		return `Detected ${detection.detected} foldable/collapsible element(s) in selected scope; included ${detection.staticDetails} static <details> section(s) and ${foldables.controlledPanelsIncluded} aria-controls panel(s), but ${foldables.ignored} control(s) could not be statically expanded.`;
	}
	return `Detected ${detection.detected} foldable/collapsible element(s) in selected scope; included ${foldables.included} static <details> section(s), but ${foldables.ignored} JS/ARIA-controlled element(s) were not expanded by static extraction.`;
}

export function hiddenWarning(detection: HiddenDetection, hidden: HiddenSummary, mode: Hidden): string {
	if (mode === "exclude") {
		if (hidden.included > 0) {
			return `Detected ${detection.detected} hidden-content element(s) in selected scope; kept ${hidden.included} foldable-controlled panel(s) and removed ${hidden.ignored} generic hidden element(s).`;
		}
		return `Detected ${detection.detected} hidden-content element(s) in selected scope; removed identifiable hidden elements before extraction.`;
	}
	return `Detected ${detection.detected} hidden-content element(s) in selected scope; included ${hidden.included} because hidden=${mode}.`;
}

function getDynamicControls(root: ParentNode, options: DetectionOptions): Element[] {
	const rawControls = new Set<Element>();
	for (const element of candidateElements(root, options)) {
		if (element.tagName.toLowerCase() === "details") continue;
		if (isDynamicFoldableControl(element)) rawControls.add(element);
	}
	return pruneNestedControls(rawControls);
}

function getControlledPanelTargets(root: ParentNode, controls: Element[], options: DetectionOptions): Set<Element> {
	const targets = new Set<Element>();
	for (const control of controls) {
		const controlledIds = (control.getAttribute("aria-controls") ?? "").split(/\s+/).filter(Boolean);
		for (const id of controlledIds) {
			const target = control.ownerDocument.getElementById(id);
			if (!target || !containsNode(root, target)) continue;
			if (shouldSkipSignalElement(target, options)) continue;
			if (!isHiddenElement(target)) continue;
			if (!hasMeaningfulText(target)) continue;
			targets.add(target);
		}
	}
	return targets;
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

function unhideElementAndAncestors(target: Element, root: ParentNode): void {
	let current: Element | null = target;
	while (current && containsNode(root, current)) {
		removeHiddenMarkers(current);
		if (current === root) break;
		current = current.parentElement;
	}
}

function removeHiddenMarkers(element: Element): void {
	element.removeAttribute("hidden");
	if ((element.getAttribute("aria-hidden") ?? "").toLowerCase() === "true") {
		element.removeAttribute("aria-hidden");
	}

	const style = element.getAttribute("style");
	if (!style) return;
	const cleaned = style
		.replace(/display\s*:\s*none\s*;?/gi, "")
		.replace(/visibility\s*:\s*hidden\s*;?/gi, "")
		.trim();
	if (cleaned) element.setAttribute("style", cleaned);
	else element.removeAttribute("style");
}

function containsNode(root: ParentNode, node: Node): boolean {
	return root === node || root.contains(node);
}

function dedupe(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}
