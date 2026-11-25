export * as AutomationWorkAdmission from "./work-admission.ts";

import { and, eq, isNull, or } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { query, serviceOperations, Transaction } from "../../database/database.ts";
import { placedChat, project, workspace } from "../../database/schema.ts";
import { processLayer } from "../../tiers.ts";
import { WorkAdmission } from "../turns/turns.ts";
import { automationAcceptsWork } from "./execution.ts";

/** Admits work while the chat's project and any automation run still take work. */
export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<WorkAdmission.Interface>("AutomationWorkAdmission");
	return WorkAdmission.Service.of({
		refusal: (chatId) =>
			operation(
				"refusal",
				Effect.gen(function* () {
					yield* Transaction;
					const [placed] = yield* query((db) =>
						db
							.select({ workspaceId: placedChat.workspaceId })
							.from(placedChat)
							.where(eq(placedChat.id, chatId)),
					);
					if (!placed) return "chatUnavailable" as const;
					const [open] = yield* query((db) =>
						db
							.select({ id: workspace.id })
							.from(workspace)
							.where(and(eq(workspace.id, placed.workspaceId), eq(workspace.deleting, false)))
							.for("share"),
					);
					if (!open) return "chatUnavailable" as const;
					const [acceptsWork] = yield* query((db) =>
						db
							.select({ id: placedChat.id })
							.from(placedChat)
							.leftJoin(project, eq(project.id, placedChat.projectId))
							.where(
								and(
									eq(placedChat.id, chatId),
									or(isNull(placedChat.projectId), eq(project.deleting, false)),
								),
							),
					);
					if (!acceptsWork) return "chatUnavailable" as const;
					return (yield* automationAcceptsWork(chatId)) ? undefined : ("automationEnded" as const);
				}),
			),
	});
});

export const layer = processLayer(Layer.effect(WorkAdmission.Service, make));
