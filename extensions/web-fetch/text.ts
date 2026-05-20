export function countMatches(text: string, pattern: RegExp): number {
	return [...text.matchAll(pattern)].length;
}

export function normalizeInlineText(text: string): string {
	return text.replace(/\r/g, "").replace(/\u00a0/g, " ").replace(/[\t\n ]+/g, " ").trim();
}

export function normalizeMarkdown(markdown: string): string {
	const lines = markdown
		.replace(/\r/g, "")
		.replace(/\u00a0/g, " ")
		.split("\n")
		.map((line) => line.replace(/[\t ]+$/g, ""));

	const normalized: string[] = [];
	let blankCount = 0;
	let fence: "`" | "~" | undefined;
	let fenceLength = 0;

	for (const line of lines) {
		const trimmed = line.trim();
		const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);

		if (fence) {
			normalized.push(line);
			const closingMatch = trimmed.match(/^(`{3,}|~{3,})\s*$/);
			if (closingMatch && closingMatch[1][0] === fence && closingMatch[1].length >= fenceLength) {
				fence = undefined;
				fenceLength = 0;
			}
			continue;
		}

		if (!trimmed) {
			blankCount++;
			if (blankCount <= 2) normalized.push("");
			continue;
		}

		blankCount = 0;
		const normalizedLine = line.replace(/[\t ]+/g, " ").trim();
		normalized.push(normalizedLine);

		if (fenceMatch) {
			fence = fenceMatch[1][0] as "`" | "~";
			fenceLength = fenceMatch[1].length;
		}
	}

	return normalized.join("\n").replace(/^\n+|\n+$/g, "").trim();
}

export function normalizeText(text: string): string {
	const lines = text
		.replace(/\r/g, "")
		.replace(/\u00a0/g, " ")
		.split("\n")
		.map((line) => line.replace(/[\t ]+/g, " ").trim())
		.filter(Boolean);

	const normalized: string[] = [];
	for (const line of lines) {
		if (line === normalized[normalized.length - 1]) continue;
		normalized.push(line);
	}

	return normalized.join("\n").trim();
}
