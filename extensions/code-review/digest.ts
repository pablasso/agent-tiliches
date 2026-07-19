import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import type { ReviewerDigest, ReviewerDigestClaim, ReviewerDigestItem } from "./core.ts";

export interface CodeReviewHandoffDetails {
	runDir: string;
	digest: ReviewerDigest;
}

export function createReviewerDigestPanel(details: CodeReviewHandoffDetails | undefined, theme: Theme): Component {
	const container = new Container();
	const border = (text: string): string => theme.fg("borderAccent", text);
	container.addChild(new DynamicBorder(border));

	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("accent", theme.bold("Independent reviews complete")), 0, 0));

	const digest = details?.digest;
	if (!digest || !Array.isArray(digest.reviewers)) {
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("warning", "Reviewer digest unavailable."), 0, 0));
	} else {
		box.addChild(
			new Text(
				theme.fg(
					"muted",
					`${digest.completed}/${digest.total} reviewers completed · Claims below are unverified until lead adjudication.`,
				),
				0,
				0,
			),
		);
		box.addChild(new Spacer(1));
		digest.reviewers.forEach((reviewer, index) => {
			renderReviewer(box, reviewer, theme);
			if (index < digest.reviewers.length - 1) box.addChild(new Spacer(1));
		});
	}

	box.addChild(new Spacer(1));
	box.addChild(
		new Text(
			theme.fg("accent", theme.bold("→ Verifying reviewer claims and preparing the final recommendation…")),
			0,
			0,
		),
	);
	box.addChild(new Text(theme.fg("dim", "Full reports: /code-review-logs"), 0, 0));
	container.addChild(box);
	container.addChild(new DynamicBorder(border));
	return container;
}

function renderReviewer(box: Box, reviewer: ReviewerDigestItem, theme: Theme): void {
	const marker = reviewerMarker(reviewer, theme);
	box.addChild(new Text(`${marker} ${theme.bold(reviewer.name)}`, 0, 0));
	box.addChild(
		new Text(theme.fg("dim", `${reviewer.model} · effort: ${reviewer.effort} · ${reviewer.duration}`), 2, 0),
	);

	switch (reviewer.status) {
		case "claims": {
			const counts = reviewer.severityCounts.map(({ severity, count }) => `${count} ${severity}`).join(", ");
			const noun = reviewer.claimCount === 1 ? "claim" : "claims";
			box.addChild(new Text(theme.fg("warning", `${reviewer.claimCount} unverified ${noun} · ${counts}`), 2, 0));
			for (const claim of reviewer.claims) renderClaim(box, claim, theme);
			if (reviewer.remainingClaims > 0) {
				box.addChild(
					new Text(
						theme.fg("dim", `+${reviewer.remainingClaims} more in the full reviewer report`),
						4,
						0,
					),
				);
			}
			break;
		}
		case "no-defects":
			box.addChild(new Text(theme.fg("success", "Reported no actionable defects."), 2, 0));
			break;
		case "summary-unavailable":
			box.addChild(new Text(theme.fg("warning", "Completed, but the structured summary was unavailable."), 2, 0));
			break;
		case "failed":
			box.addChild(new Text(theme.fg("error", "Reviewer failed; inspect the full report for diagnostics."), 2, 0));
			break;
		case "cancelled":
			box.addChild(new Text(theme.fg("warning", "Reviewer was cancelled."), 2, 0));
			break;
	}
}

function renderClaim(box: Box, claim: ReviewerDigestClaim, theme: Theme): void {
	const color = claim.severity === "P0" || claim.severity === "P1" ? "error" : claim.severity === "P2" ? "warning" : "muted";
	box.addChild(new Text(`${theme.fg(color, `[${claim.severity}]`)} ${claim.title}`, 4, 0));
}

function reviewerMarker(reviewer: ReviewerDigestItem, theme: Theme): string {
	switch (reviewer.status) {
		case "no-defects":
			return theme.fg("success", "✓");
		case "claims":
		case "summary-unavailable":
			return theme.fg("warning", "!");
		case "failed":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("warning", "–");
	}
}
