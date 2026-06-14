export type DiffLineType = "context" | "add" | "del" | "meta";

export interface ParsedDiff {
	raw: string;
	files: DiffFile[];
	stats: DiffStats;
}

export interface DiffStats {
	files: number;
	hunks: number;
	added: number;
	deleted: number;
	lines: number;
}

export interface DiffFile {
	id: string;
	index: number;
	oldPath: string;
	newPath: string;
	displayPath: string;
	isNew: boolean;
	isDeleted: boolean;
	isBinary: boolean;
	headerLines: string[];
	hunks: DiffHunk[];
}

export interface DiffHunk {
	index: number;
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	section: string;
	lines: DiffLine[];
}

export interface DiffLine {
	key: string;
	type: DiffLineType;
	raw: string;
	content: string;
	oldLine?: number;
	newLine?: number;
	hunkIndex: number;
	lineIndex: number;
}

export interface LocatedDiffLine {
	file: DiffFile;
	hunk: DiffHunk;
	line: DiffLine;
}

export function parseGitDiff(raw: string): ParsedDiff {
	const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	if (lines.at(-1) === "") lines.pop();

	const files: DiffFile[] = [];
	let currentFile: DiffFile | undefined;
	let currentHunk: DiffHunk | undefined;
	let oldLine = 0;
	let newLine = 0;

	const startFile = (line: string): DiffFile => {
		const index = files.length;
		const paths = parseDiffGitLine(line);
		const file: DiffFile = {
			id: `file-${index}`,
			index,
			oldPath: paths?.oldPath ?? `unknown-${index}`,
			newPath: paths?.newPath ?? paths?.oldPath ?? `unknown-${index}`,
			displayPath: paths?.newPath ?? paths?.oldPath ?? `unknown-${index}`,
			isNew: false,
			isDeleted: false,
			isBinary: false,
			headerLines: [line],
			hunks: [],
		};
		files.push(file);
		currentFile = file;
		currentHunk = undefined;
		return file;
	};

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			startFile(line);
			continue;
		}

		if (!currentFile) {
			// Ignore preamble lines. `git diff` normally starts each file with `diff --git`.
			continue;
		}

		const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
		if (hunkMatch) {
			const hunk: DiffHunk = {
				index: currentFile.hunks.length,
				header: line,
				oldStart: Number(hunkMatch[1]),
				oldLines: hunkMatch[2] ? Number(hunkMatch[2]) : 1,
				newStart: Number(hunkMatch[3]),
				newLines: hunkMatch[4] ? Number(hunkMatch[4]) : 1,
				section: hunkMatch[5]?.trim() ?? "",
				lines: [],
			};
			currentFile.hunks.push(hunk);
			currentHunk = hunk;
			oldLine = hunk.oldStart;
			newLine = hunk.newStart;
			continue;
		}

		if (!currentHunk) {
			currentFile.headerLines.push(line);
			applyHeaderMetadata(currentFile, line);
			continue;
		}

		const prefix = line[0] ?? "";
		const diffLine: DiffLine = {
			key: `${currentFile.id}:h${currentHunk.index}:l${currentHunk.lines.length}`,
			type: "meta",
			raw: line,
			content: line.startsWith("\\") ? line : line.slice(1),
			hunkIndex: currentHunk.index,
			lineIndex: currentHunk.lines.length,
		};

		if (prefix === " ") {
			diffLine.type = "context";
			diffLine.oldLine = oldLine++;
			diffLine.newLine = newLine++;
		} else if (prefix === "+") {
			diffLine.type = "add";
			diffLine.newLine = newLine++;
		} else if (prefix === "-") {
			diffLine.type = "del";
			diffLine.oldLine = oldLine++;
		}

		currentHunk.lines.push(diffLine);
	}

	for (const file of files) {
		file.displayPath = displayPath(file);
		file.isNew ||= file.oldPath === "/dev/null";
		file.isDeleted ||= file.newPath === "/dev/null";
	}

	return {
		raw: normalized,
		files,
		stats: computeStats(files),
	};
}

export function findDiffLine(diff: ParsedDiff, lineKey: string): LocatedDiffLine | undefined {
	for (const file of diff.files) {
		for (const hunk of file.hunks) {
			const line = hunk.lines.find((candidate) => candidate.key === lineKey);
			if (line) return { file, hunk, line };
		}
	}
	return undefined;
}

export function formatLineLocation(line: DiffLine): string {
	if (line.oldLine !== undefined && line.newLine !== undefined) return `old ${line.oldLine} / new ${line.newLine}`;
	if (line.newLine !== undefined) return `new ${line.newLine}`;
	if (line.oldLine !== undefined) return `old ${line.oldLine}`;
	return "metadata";
}

function computeStats(files: DiffFile[]): DiffStats {
	let hunks = 0;
	let added = 0;
	let deleted = 0;
	let lines = 0;

	for (const file of files) {
		hunks += file.hunks.length;
		for (const hunk of file.hunks) {
			for (const line of hunk.lines) {
				lines++;
				if (line.type === "add") added++;
				else if (line.type === "del") deleted++;
			}
		}
	}

	return { files: files.length, hunks, added, deleted, lines };
}

function applyHeaderMetadata(file: DiffFile, line: string): void {
	if (line.startsWith("--- ")) {
		file.oldPath = normalizeGitPath(line.slice(4));
		file.isNew = file.oldPath === "/dev/null";
		return;
	}
	if (line.startsWith("+++ ")) {
		file.newPath = normalizeGitPath(line.slice(4));
		file.isDeleted = file.newPath === "/dev/null";
		return;
	}
	if (line.startsWith("new file mode")) file.isNew = true;
	if (line.startsWith("deleted file mode")) file.isDeleted = true;
	if (line.startsWith("Binary files ") || line === "GIT binary patch") file.isBinary = true;
}

function displayPath(file: DiffFile): string {
	if (file.newPath && file.newPath !== "/dev/null") return file.newPath;
	if (file.oldPath && file.oldPath !== "/dev/null") return file.oldPath;
	return `file-${file.index}`;
}

function parseDiffGitLine(line: string): { oldPath: string; newPath: string } | undefined {
	const rest = line.slice("diff --git ".length);
	const tokens = splitGitTokens(rest);
	if (tokens.length === 2) {
		return {
			oldPath: normalizeGitPath(tokens[0]),
			newPath: normalizeGitPath(tokens[1]),
		};
	}

	const match = rest.match(/^a\/(.*?) b\/(.*)$/);
	if (!match) return undefined;
	return { oldPath: match[1], newPath: match[2] };
}

function splitGitTokens(value: string): string[] {
	const tokens: string[] = [];
	let index = 0;

	while (index < value.length) {
		while (value[index] === " ") index++;
		if (index >= value.length) break;

		if (value[index] === '"') {
			const parsed = readQuotedToken(value, index);
			tokens.push(parsed.token);
			index = parsed.nextIndex;
			continue;
		}

		let end = index;
		while (end < value.length && value[end] !== " ") end++;
		tokens.push(value.slice(index, end));
		index = end;
	}

	return tokens;
}

function readQuotedToken(value: string, start: number): { token: string; nextIndex: number } {
	let token = "";
	let index = start + 1;

	while (index < value.length) {
		const char = value[index];
		if (char === '"') return { token, nextIndex: index + 1 };
		if (char === "\\" && index + 1 < value.length) {
			const next = value[index + 1];
			if (next === "t") token += "\t";
			else if (next === "n") token += "\n";
			else if (next === "r") token += "\r";
			else token += next;
			index += 2;
			continue;
		}
		token += char;
		index++;
	}

	return { token, nextIndex: value.length };
}

function normalizeGitPath(path: string): string {
	let normalized = path.trim();
	if (normalized === "/dev/null") return normalized;
	if (normalized.startsWith('"') && normalized.endsWith('"')) {
		normalized = readQuotedToken(normalized, 0).token;
	}
	return normalized.replace(/^[ab]\//, "");
}
