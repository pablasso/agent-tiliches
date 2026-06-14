import { findDiffLine, formatLineLocation, type DiffFile, type DiffHunk, type LocatedDiffLine, type ParsedDiff } from "./diff.ts";

export interface SubmittedReviewComment {
	lineKey: string;
	body: string;
}

export interface ReviewPromptOptions {
	cwd?: string;
	gitCommand?: string;
	contextRadius?: number;
	maxLineLength?: number;
}

interface ResolvedComment {
	id: string;
	body: string;
	location: LocatedDiffLine;
}

interface HunkGroup {
	file: DiffFile;
	hunk: DiffHunk;
	comments: ResolvedComment[];
}

export function buildReviewPrompt(
	diff: ParsedDiff,
	comments: SubmittedReviewComment[],
	options: ReviewPromptOptions = {},
): string | undefined {
	const resolved = resolveComments(diff, comments);
	if (resolved.length === 0) return undefined;

	const contextRadius = options.contextRadius ?? 3;
	const maxLineLength = options.maxLineLength ?? 240;
	const groups = groupByHunk(resolved);
	const parts: string[] = [];

	parts.push("Review this annotated diff. Lines starting `>>> REVIEW` are comments, not code.");
	parts.push("Apply comments you agree with; if you disagree or need clarification, say so briefly.");

	for (const group of groups) {
		parts.push("");
		parts.push(`### ${group.file.displayPath}`);
		parts.push("```diff");
		parts.push(...fileHeaderForPrompt(group.file));
		parts.push(group.hunk.header);
		parts.push(...annotatedHunkExcerpt(group.hunk, group.comments, contextRadius, maxLineLength));
		parts.push("```");
	}

	parts.push("");
	parts.push("Keep the final response concise.");

	return parts.join("\n");
}

function resolveComments(diff: ParsedDiff, comments: SubmittedReviewComment[]): ResolvedComment[] {
	const resolved: ResolvedComment[] = [];
	const seen = new Set<string>();

	for (const rawComment of comments) {
		const body = rawComment.body.trim();
		if (!body) continue;
		const location = findDiffLine(diff, rawComment.lineKey);
		if (!location) continue;
		const key = `${rawComment.lineKey}:${body}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resolved.push({ id: `C${resolved.length + 1}`, body, location });
	}

	return resolved;
}

function groupByHunk(comments: ResolvedComment[]): HunkGroup[] {
	const groups = new Map<string, HunkGroup>();

	for (const comment of comments) {
		const { file, hunk } = comment.location;
		const key = `${file.id}:h${hunk.index}`;
		let group = groups.get(key);
		if (!group) {
			group = { file, hunk, comments: [] };
			groups.set(key, group);
		}
		group.comments.push(comment);
	}

	return Array.from(groups.values());
}

function fileHeaderForPrompt(file: DiffFile): string[] {
	const oldDiffPath = file.oldPath === "/dev/null" ? file.displayPath : file.oldPath;
	const newDiffPath = file.newPath === "/dev/null" ? file.displayPath : file.newPath;
	return [
		`diff --git a/${oldDiffPath} b/${newDiffPath}`,
		`--- ${prefixedPath(file.oldPath, "a")}`,
		`+++ ${prefixedPath(file.newPath, "b")}`,
	];
}

function annotatedHunkExcerpt(hunk: DiffHunk, comments: ResolvedComment[], contextRadius: number, maxLineLength: number): string[] {
	const commentsByLine = new Map<string, ResolvedComment[]>();
	for (const comment of comments) {
		const lineComments = commentsByLine.get(comment.location.line.key) ?? [];
		lineComments.push(comment);
		commentsByLine.set(comment.location.line.key, lineComments);
	}

	const ranges = mergeRanges(
		comments.map((comment) => ({
			start: Math.max(0, comment.location.line.lineIndex - contextRadius),
			end: Math.min(hunk.lines.length - 1, comment.location.line.lineIndex + contextRadius),
		})),
	);

	const result: string[] = [];
	let previousEnd = -1;
	for (const range of ranges) {
		if (previousEnd >= 0 && range.start > previousEnd + 1) {
			result.push("...");
		}
		for (let index = range.start; index <= range.end; index++) {
			const line = hunk.lines[index];
			if (!line) continue;
			result.push(truncateLine(line.raw, maxLineLength));
			for (const comment of commentsByLine.get(line.key) ?? []) {
				result.push(formatInlineComment(comment));
			}
		}
		previousEnd = range.end;
	}

	return result;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
	const sorted = ranges
		.filter((range) => range.start <= range.end)
		.sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
	const merged: Array<{ start: number; end: number }> = [];

	for (const range of sorted) {
		const previous = merged.at(-1);
		if (!previous || range.start > previous.end + 1) {
			merged.push({ ...range });
		} else {
			previous.end = Math.max(previous.end, range.end);
		}
	}

	return merged;
}

function prefixedPath(path: string, prefix: "a" | "b"): string {
	return path === "/dev/null" ? path : `${prefix}/${path}`;
}

function formatInlineComment(comment: ResolvedComment): string {
	return `>>> REVIEW ${comment.id} ${formatLineLocation(comment.location.line)}: ${sanitizeCommentText(comment.body)}`;
}

function sanitizeCommentText(value: string): string {
	return value
		.replace(/```/g, "ˋˋˋ")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ");
}

function truncateLine(line: string, maxLength: number): string {
	if (line.length <= maxLength) return line;
	return `${line.slice(0, Math.max(0, maxLength - 20))} … [truncated]`;
}
