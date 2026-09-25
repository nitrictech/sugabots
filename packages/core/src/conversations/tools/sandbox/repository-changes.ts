import type { ToolApprovalSummary } from "@sugabots/contracts";
import { type ToolSet, tool } from "ai";
import { Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import { describeBranch, pushBranch } from "../../../github/push.ts";
import type { GithubForTurns } from "../../../github/work.ts";
import type { ToolApprovalStore } from "../approvals/store.ts";
import { type CheckoutContext, checkoutPlace } from "./tools.ts";
import type { TurnSandbox } from "./turn-sandbox.ts";

export const REPO_PUSH_TOOL = "repo_push";
export const REPO_OPEN_PULL_REQUEST_TOOL = "repo_open_pull_request";

export interface RepositoryChangeOptions {
	turn: TurnSandbox;
	run: RunEffect;
	checkout: CheckoutContext;
	workspaceId: string;
	turnId: string;
	github: GithubForTurns;
	approvals: Pick<ToolApprovalStore, "approvedSummary">;
}

// A refusal from GitHub or the push reaches the model as its message: the
// recording wrapper passes any thrown error's message on as the call's result.

/**
 * The tools that change a repository on GitHub from a thread's worktree:
 * push its branch, and open a draft pull request from it. Each waits for a
 * person to approve it, and is carried out by the server with the workspace's
 * token, which the sandbox never sees. Only the pod's own repositories, and
 * only the thread's own branch.
 */
export function repositoryChangeTools(options: RepositoryChangeOptions) {
	const { turn, run, checkout, workspaceId, turnId, github, approvals } = options;

	const podRepository = (name: string) => {
		const known = checkout.repositories.find(
			(candidate) => candidate.fullName.toLowerCase() === name.toLowerCase(),
		);
		if (!known) {
			throw new Error(
				`${name} isn't one of this pod's repositories (${checkout.repositories.map((repository) => repository.fullName).join(", ") || "it has none"}), so it can't be pushed to.`,
			);
		}
		return known;
	};

	const credentials = async (repository: string) => {
		const found = await run(github.credentials(workspaceId, repository));
		if (!found) {
			throw new Error(
				"There's no GitHub access for this repository: the workspace's GitHub connection is gone, or its app isn't installed where the repository is.",
			);
		}
		return found;
	};

	const repositoryInput = Schema.String.check(
		Schema.isPattern(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, { message: "owner/repository" }),
	).annotate({ description: "owner/repository, one this pod has" });

	const tools: ToolSet = {
		[REPO_PUSH_TOOL]: tool({
			description:
				"Push this thread's branch of a repository to GitHub, so people can see and review it. Commit your work in the checkout first. A person approves each push after seeing its commits and changed files; it goes to this thread's own branch only, never the default branch, and never overwrites commits already on GitHub.",
			inputSchema: Schema.Struct({ repository: repositoryInput }).pipe(
				Schema.toStandardSchemaV1,
				Schema.toStandardJSONSchemaV1,
			),
			execute: async ({ repository }, { toolCallId }) => {
				const known = podRepository(repository);
				const place = checkoutPlace(checkout, known.fullName);
				const approved = await run(approvals.approvedSummary(turnId, toolCallId));
				const pushed = await run(
					pushBranch({
						sandbox: await turn.sandbox(),
						worktree: place.worktree,
						branch: place.branch,
						repository: known.fullName,
						defaultBranch: known.defaultBranch,
						credentials: await credentials(known.fullName),
						...(approved?.kind === "push" ? { head: approved.head } : {}),
					}),
				);
				return pushed;
			},
		}),
		[REPO_OPEN_PULL_REQUEST_TOOL]: tool({
			description:
				"Open a draft pull request on GitHub from this thread's branch into the repository's default branch, once the branch is pushed. A person approves it first. Write a title and a description a reviewer can follow: what changed and why.",
			inputSchema: Schema.Struct({
				repository: repositoryInput,
				title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
				body: Schema.String.check(Schema.isMaxLength(20_000)),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, title, body }) => {
				const known = podRepository(repository);
				const place = checkoutPlace(checkout, known.fullName);
				const opened = await run(
					github.openPullRequest(await credentials(known.fullName), known.fullName, {
						title,
						body: `${body}\n\n---\nOpened by @${checkout.agent.handle} in Sugabots.`,
						head: place.branch,
						base: known.defaultBranch,
					}),
				);
				return { ...opened, draft: true };
			},
		}),
	};

	/**
	 * What to show whoever decides, worked out by the server from the
	 * sandbox rather than taken from the model. Undefined for anything else.
	 */
	const summarize = (
		toolName: string,
		input: unknown,
	): Effect.Effect<ToolApprovalSummary | undefined> =>
		Effect.promise(async () => {
			const repository =
				input && typeof input === "object" && "repository" in input
					? String(input.repository)
					: undefined;
			const known = repository
				? checkout.repositories.find(
						(candidate) => candidate.fullName.toLowerCase() === repository.toLowerCase(),
					)
				: undefined;
			if (!known) return undefined;
			const place = checkoutPlace(checkout, known.fullName);
			if (toolName === REPO_OPEN_PULL_REQUEST_TOOL) {
				return {
					kind: "pull_request" as const,
					repository: known.fullName,
					head: place.branch,
					base: known.defaultBranch,
					title: input && typeof input === "object" && "title" in input ? String(input.title) : "",
				};
			}
			if (toolName !== REPO_PUSH_TOOL) return undefined;
			const described = await run(
				describeBranch(await turn.sandbox(), place.worktree, place.branch, known.defaultBranch),
			).catch(() => undefined);
			if (!described?.head) return undefined;
			return {
				kind: "push" as const,
				repository: known.fullName,
				branch: place.branch,
				base: known.defaultBranch,
				...described,
			};
		});

	return { tools, summarize };
}
