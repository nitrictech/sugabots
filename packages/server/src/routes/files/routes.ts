import { Files } from "@sugabots/core/files/files";
import { FilePages } from "@sugabots/core/files/pages";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSignedInPerson } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const fileRoutes = HttpApiBuilder.group(ServerApi, "files", (handlers) =>
	Effect.gen(function* () {
		const files = yield* Files.Service;
		const pages = yield* FilePages.Service;
		return handlers
			.handle("listInProject", ({ params }) =>
				files.listInProject(params).pipe(asSignedInPerson, asHttpError(refusals)),
			)
			.handle("get", ({ params }) =>
				files.get(params).pipe(asSignedInPerson, asHttpError(refusals)),
			)
			.handle("versions", ({ params }) =>
				files.versions(params).pipe(asSignedInPerson, asHttpError(refusals)),
			)
			.handle("getVersion", ({ params }) =>
				files.getVersion(params).pipe(asSignedInPerson, asHttpError(refusals)),
			)
			.handle("pageAddress", ({ params }) =>
				pages.address(params).pipe(
					Effect.map((url) => ({ url: url ?? null })),
					asSignedInPerson,
					asHttpError(refusals),
				),
			)
			.handle("remove", ({ params }) =>
				files.remove(params).pipe(asSignedInPerson, asHttpError(refusals)),
			);
	}),
);
