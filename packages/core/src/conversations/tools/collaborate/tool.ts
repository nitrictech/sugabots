import {
	type CollaborationPart,
	threadChannel,
	threadUpdateEventSchema,
} from "@sugabots/contracts";
import { tool } from "ai";
import { Duration, Effect, Option, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { EventBus } from "../../../database/events/bus.ts";
import type { Collaborations } from "./collaborations.ts";

/** How long the asking agent's turn waits for the collaborator before moving on. */
const DEFAULT_WAIT = Duration.seconds(120);

const readThreadUpdate = Schema.decodeUnknownOption(threadUpdateEventSchema);

export interface CollaborateToolOptions {
	/** The turn the tool runs in: its thread, its agent, its turn and its reply. */
	from: { threadId: string; agentId: string; turnId: string; messageId: string };
	collaborations: Pick<Collaborations.Interface, "open" | "collectAnswer">;
	/** For noticing the collaboration being answered. */
	bus: Pick<EventBus.Interface, "subscribe">;
	/** Runs a service's Effect from the tool's promise. */
	run: RunEffect;
	/** How much of the reply has been written so far, which is where the collaboration sits. */
	replyLength: () => number;
	/** Tells the running turn a collaboration began, so the reply's parts include it from now on. */
	noteCollaboration: (
		collaboration: Pick<CollaborationPart, "id" | "atOffset">,
	) => Effect.Effect<void>;
	/** The asking turn's own abort signal; a cancelled turn stops waiting. */
	signal: AbortSignal;
	wait?: Duration.Input;
}

export type CollaborateResult =
	| { status: "answered"; answer: string }
	| { status: "pending"; threadId: string; note: string }
	| { status: "failed"; threadId: string; note: string }
	| { status: "refused"; reason: string };

/**
 * The `collaborate` tool, bound to one turn.
 *
 * Opening the collaboration is one transaction. Waiting for the answer is
 * not: it watches the asking thread's channel for the collaboration to be
 * answered, up to `wait`, then takes the answer if there is one, reports a
 * collaboration that failed, or records that the asking agent moved on so the
 * answer resumes it later.
 */
export function collaborateTool({
	from,
	collaborations,
	bus,
	run,
	replyLength,
	noteCollaboration,
	signal,
	wait = DEFAULT_WAIT,
}: CollaborateToolOptions) {
	return tool({
		description:
			"Collaborate with another agent in this pod. Write a self-contained brief: the collaborator sees only what you write here, not this conversation. You get their answer back, or a note that it is still coming.",
		inputSchema: Schema.Struct({
			to: Schema.String.annotate({ description: "The other agent's name, exactly as listed" }),
			brief: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
				description: "What you need from them, with all the context they need",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ to, brief }): Promise<CollaborateResult> => {
			const opened = await run(
				collaborations.open({ from: { ...from, atOffset: replyLength() }, to, brief }).pipe(
					Effect.tap((opened) => noteCollaboration(opened.collaboration)),
					Effect.map((opened) => ({ ok: true as const, opened })),
					Effect.catchTag("CollaborationRefused", (refusal) =>
						Effect.succeed({ ok: false as const, reason: refusal.reason }),
					),
				),
			);
			if (!opened.ok) {
				return { status: "refused", reason: opened.reason };
			}
			const { collaboration, collaborator } = opened.opened;

			await waitUntilSettled(bus, from.threadId, collaboration.id, wait, signal);
			const outcome = await run(collaborations.collectAnswer(collaboration.id));
			if (outcome._tag === "Answered") {
				return { status: "answered", answer: outcome.answer };
			}
			if (outcome._tag === "Failed") {
				return {
					status: "failed",
					threadId: collaboration.threadId,
					note: `${collaborator.name} will not answer: the collaboration was stopped. Carry on without their answer.`,
				};
			}
			return {
				status: "pending",
				threadId: collaboration.threadId,
				note: `${collaborator.name} has not answered yet. Tell the person you have asked and will follow up when the answer arrives.`,
			};
		},
	});
}

/**
 * Waits until the collaboration, made in `threadId`, is answered or failed,
 * `wait` passes, or `signal` aborts.
 */
async function waitUntilSettled(
	bus: Pick<EventBus.Interface, "subscribe">,
	threadId: string,
	collaborationId: string,
	wait: Duration.Input,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) {
		return;
	}
	const giveUp = new AbortController();
	const timer = setTimeout(() => giveUp.abort(), Duration.toMillis(Duration.fromInputUnsafe(wait)));
	const onAbort = () => giveUp.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		for await (const { event } of bus.subscribe(threadChannel(threadId), {
			signal: giveUp.signal,
		})) {
			const update = Option.getOrUndefined(readThreadUpdate(event));
			if (
				update?.type === "collaboration.updated" &&
				update.collaboration.id === collaborationId &&
				(update.collaboration.status === "answered" || update.collaboration.status === "failed")
			) {
				return;
			}
		}
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
		giveUp.abort();
	}
}
