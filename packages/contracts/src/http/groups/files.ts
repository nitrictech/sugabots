import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { fileSummarySchema, fileVersionSummarySchema, writtenFileSchema } from "../../files.ts";
import { uuidSchema } from "../../uuid.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/files";
const file = { fileId: uuidSchema };
const version = {
	...file,
	version: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
};

export class FilesApi extends HttpApiGroup.make("files")
	.add(
		/** The files uploaded or made in the channel's conversations. */
		HttpApiEndpoint.get("listInChannel", "/channels/:channelId/files", {
			params: { channelId: uuidSchema },
			success: Schema.Array(fileSummarySchema),
			error: refused,
		}),
		/** The files uploaded or made in the bot's tasks. */
		HttpApiEndpoint.get("listForBot", "/bots/:botId/files", {
			params: { botId: uuidSchema },
			success: Schema.Array(fileSummarySchema),
			error: refused,
		}),
		/** A file a bot wrote, at its current version. */
		HttpApiEndpoint.get("get", `${root}/:fileId`, {
			params: file,
			success: writtenFileSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("versions", `${root}/:fileId/versions`, {
			params: file,
			success: Schema.Array(fileVersionSummarySchema),
			error: refused,
		}),
		HttpApiEndpoint.get("getVersion", `${root}/:fileId/versions/:version`, {
			params: version,
			success: writtenFileSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("pageAddress", `${root}/:fileId/versions/:version/page`, {
			params: version,
			success: Schema.Struct({
				/** Where the page loads from on the content origin, for a few minutes; `null` when no content origin is set. */
				url: Schema.NullOr(Schema.String),
			}),
			error: refused,
		}),
		HttpApiEndpoint.delete("remove", `${root}/:fileId`, {
			params: file,
			error: refused,
		}),
	)
	.middleware(Session) {}
