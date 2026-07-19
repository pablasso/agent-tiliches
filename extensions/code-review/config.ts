import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CODE_REVIEW_CONFIG_NAME = "code-review.json";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReviewThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Reviewer {
	name: string;
	provider: string;
	model: string;
	thinking: ReviewThinkingLevel;
}

export interface CodeReviewConfig {
	reviewers: Reviewer[];
	extensions: string[];
}

export function getCodeReviewConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, CODE_REVIEW_CONFIG_NAME);
}

export async function loadCodeReviewConfig(agentDir = getAgentDir()): Promise<CodeReviewConfig> {
	const configPath = getCodeReviewConfigPath(agentDir);
	let source: string;
	try {
		source = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { reviewers: [], extensions: [] };
		throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new Error(`Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!isRecord(parsed)) throw new Error(`${configPath} must contain a JSON object.`);
	const reviewerValues = parsed.reviewers ?? [];
	if (!Array.isArray(reviewerValues)) throw new Error(`${configPath}: "reviewers" must be an array.`);
	if (reviewerValues.length > 16) throw new Error(`${configPath}: at most 16 reviewers are supported.`);

	const reviewers = reviewerValues.map((value, index) => parseReviewer(value, index, configPath));
	const identities = new Set<string>();
	for (const reviewer of reviewers) {
		const identity = `${reviewer.provider}\0${reviewer.model}`;
		if (identities.has(identity)) throw new Error(`${configPath}: duplicate reviewer model ${reviewer.provider}/${reviewer.model}.`);
		identities.add(identity);
	}
	const extensions = parseStringArray(parsed.extensions, `${configPath}.extensions`);
	return { reviewers, extensions };
}

export function emptyConfigExample(): string {
	return `${JSON.stringify({ reviewers: [], extensions: [] }, null, 2)}\n`;
}

function parseReviewer(value: unknown, index: number, configPath: string): Reviewer {
	const location = `${configPath}: reviewers[${index}]`;
	if (!isRecord(value)) throw new Error(`${location} must be an object.`);

	const provider = requiredString(value.provider, `${location}.provider`);
	const model = requiredString(value.model, `${location}.model`);
	const name = value.name === undefined ? `${provider}/${model}` : requiredString(value.name, `${location}.name`);
	const thinking = parseThinkingLevel(value.thinking, `${location}.thinking`, "max");

	return { name, provider, model, thinking };
}

function parseThinkingLevel(value: unknown, location: string, fallback: ReviewThinkingLevel): ReviewThinkingLevel {
	if (value === undefined) return fallback;
	const thinking = requiredString(value, location);
	if (!THINKING_LEVELS.includes(thinking as ReviewThinkingLevel)) {
		throw new Error(`${location} must be one of: ${THINKING_LEVELS.join(", ")}.`);
	}
	return thinking as ReviewThinkingLevel;
}

function parseStringArray(value: unknown, location: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${location} must be an array of strings.`);
	return value.map((entry, index) => requiredString(entry, `${location}[${index}]`));
}

function requiredString(value: unknown, location: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${location} must be a non-empty string.`);
	return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
