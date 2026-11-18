import {
	BOT_NAME_MAX_LENGTH,
	type CollaborationPart,
	conversationStream,
	conversationUpdateEventSchema,
	MESSAGE_MAX_LENGTH,
} from "@sugabots/contracts";
import { tool } from "ai";
import { Duration, Effect, Option, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { EventBus } from "../../../database/events/bus.ts";
import type { Collaborations } from "./collaborations.ts";

export const COLLABORATE_TOOL = "collaborate";

/** How long the asking bot's turn waits for the collaborator before moving on. */
const DEFAULT_WAIT = Duration.seconds(120);

const readConversationUpdate = Schema.decodeUnknownOption(conversationUpdateEventSchema);

export interface CollaborateToolOptions {
	/** The turn the tool runs in: its conversation, its bot, its turn and its reply. */
	from: { conversationId: string; botId: string; turnId: string; messageId: string };
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

type CollaborateResult =
	| { status: "answered"; answer: string }
	| { status: "pending"; conversationId: string; note: string }
	| { status: "failed"; conversationId: string; note: string }
	| { status: "refused"; reason: string };

/**
 * The `collaborate` tool, bound to one turn.
 *
 * Opening the collaboration is one transaction. Waiting for the answer is
 * not: it watches the asking conversation's stream for the collaboration to be
 * answered, up to `wait`, then takes the answer if there is one, reports a
 * collaboration that failed, or records that the asking bot moved on so the
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
			"Ask another bot in the workspace, any bot, private ones included, to help. Write a self-contained brief: the bot sees only what you write here, not this conversation. You get its answer back, or a note that it is still coming.",
		inputSchema: Schema.Struct({
			to: Schema.String.check(Schema.isMaxLength(BOT_NAME_MAX_LENGTH)).annotate({
				description: "The other bot's name, exactly as listed",
			}),
			brief: Schema.String.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(MESSAGE_MAX_LENGTH),
			).annotate({
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

			await waitUntilSettled(bus, from.conversationId, collaboration.id, wait, signal);
			const outcome = await run(collaborations.collectAnswer(collaboration.id));
			if (outcome._tag === "Answered") {
				return { status: "answered", answer: outcome.answer };
			}
			if (outcome._tag === "Failed") {
				return {
					status: "failed",
					conversationId: collaboration.conversationId,
					note: `${collaborator.name} will not answer: the collaboration was stopped. Carry on without their answer.`,
				};
			}
			return {
				status: "pending",
				conversationId: collaboration.conversationId,
				note: `${collaborator.name} is still working on it. When they answer, or it turns out they cannot, you get a new turn to tell the person. For now, tell the person you have asked ${collaborator.name} and will follow up.`,
			};
		},
	});
}

/**
 * Waits until the collaboration, made in `conversationId`, is answered or failed,
 * `wait` passes, or `signal` aborts.
 */
async function waitUntilSettled(
	bus: Pick<EventBus.Interface, "subscribe">,
	conversationId: string,
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
		for await (const { event } of bus.subscribe(conversationStream(conversationId), {
			signal: giveUp.signal,
		})) {
			const update = Option.getOrUndefined(readConversationUpdate(event));
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
