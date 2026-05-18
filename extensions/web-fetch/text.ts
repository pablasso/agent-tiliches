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
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			blankCount++;
			if (blankCount <= 2) normalized.push("");
			continue;
		}
		blankCount = 0;
		normalized.push(line.replace(/[\t ]+/g, " ").trim());
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
