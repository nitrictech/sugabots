import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** The files in a project's chats, and those bots wrote, each endpoint its operation. */
export const fileRoutes = HttpApiBuilder.group(ServerApi, "files", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
			.handle("listInProject", ({ params }) =>
				callOperation("files.listInProject", { projectId: params.projectId }).pipe(
					asHttpError(refusals),
				),
			)
			.handle("get", ({ params }) =>
				callOperation("files.get", { fileId: params.fileId }).pipe(asHttpError(refusals)),
			)
			.handle("versions", ({ params }) =>
				callOperation("files.versions", { fileId: params.fileId }).pipe(asHttpError(refusals)),
			)
			.handle("getVersion", ({ params }) =>
				callOperation("files.getVersion", { fileId: params.fileId, version: params.version }).pipe(
					asHttpError(refusals),
				),
			)
			.handle("pageAddress", ({ params }) =>
				callOperation("files.pageAddress", {
					fileId: params.fileId,
					version: params.version,
				}).pipe(asHttpError(refusals)),
			)
			.handle("remove", ({ params }) =>
				callOperation("files.remove", { fileId: params.fileId }).pipe(asHttpError(refusals)),
			),
	),
);
