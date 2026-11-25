import { UserText } from "@sugabots/errors";
import { Effect, Schema } from "effect";
import { ApprovalNeeded, ApprovalRefused, ResourceHidden } from "../errors/proofs.ts";
import { WebToolOff } from "../errors/web.ts";
import { MAX_URL_CHARACTERS } from "../urls.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

export const WEB_FETCH_TOOL = "web_fetch";
export const WEB_SEARCH_TOOL = "web_search";

const MAX_QUERY_LENGTH = 400;
const MAX_SEARCH_RESULTS = 10;
const refusals = [ResourceHidden, WebToolOff, ApprovalNeeded, ApprovalRefused] as const;

export const webContracts = {
	"web.fetch": OperationContract.make("web.fetch", {
		description:
			"Read a public web page. Give it the full address of a page a member shared, one you know, or one from a search result, and you get the page's title and main content as Markdown to quote or summarise. Pages are fetched over HTTPS; it cannot sign in, run scripts, or reach private networks. When your reply relies on what a page says, name its URL.",
		input: Schema.Struct({
			url: Schema.String.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(MAX_URL_CHARACTERS),
			).annotate({ description: "The full http or https address of the page" }),
		}),
		output: Schema.Union([
			Schema.Struct({
				ok: Schema.Literal(true),
				page: Schema.Struct({
					url: Schema.String,
					finalUrl: Schema.String,
					title: Schema.NullOr(Schema.String),
					contentType: Schema.String,
					text: Schema.String,
					truncated: Schema.Boolean,
				}),
			}),
			Schema.Struct({ ok: Schema.Literal(false), reason: UserText.schema }),
		]),
		errors: refusals,
		changes: false,
	}),
	"web.search": OperationContract.make("web.search", {
		description:
			"Search the web. Returns titles, addresses and short snippets for a query; use web_fetch to read any result in full. Good for finding a page you do not have the address of, and for anything recent. When your reply relies on a result, name its URL. A failed search gives the web search settings page, which only workspace admins can change; link it when telling the member how to fix it.",
		input: Schema.Struct({
			query: Schema.String.check(
				Schema.makeFilter(
					(query) => {
						const length = query.trim().length;
						return length >= 1 && length <= MAX_QUERY_LENGTH;
					},
					{
						expected: `a query with 1 to ${MAX_QUERY_LENGTH} characters after trimming`,
						toJsonSchema: () => ({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
					},
				),
			)
				.annotate({ description: "What to search for, as you would type it" })
				.pipe(Schema.decodeTo(Schema.Trim)),
			count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_RESULTS }))
				.annotate({ description: "How many results to return", default: 5 })
				.pipe(Schema.withDecodingDefaultKey(Effect.succeed(5))),
		}),
		output: Schema.Union([
			Schema.Struct({
				ok: Schema.Literal(true),
				results: Schema.Array(
					Schema.Struct({
						title: Schema.String,
						url: Schema.String,
						snippet: Schema.String,
						published: Schema.NullOr(Schema.String),
					}),
				),
			}),
			Schema.Struct({
				ok: Schema.Literal(false),
				reason: UserText.schema,
				providerMessage: Schema.optionalKey(Schema.String),
				settingsPageUrl: Schema.String,
			}),
		]),
		errors: refusals,
		changes: false,
	}),
};

export const webExposure = {
	"web.fetch": {
		http: { kind: "heldBack", reason: "Only offered to bots in turns." },
		botLoop: {
			kind: "offered",
			tool: WEB_FETCH_TOOL,
			offeredIn: "everywhere",
			approval: { kind: "outsideRunsOrMemberBounds" },
		},
	},
	"web.search": {
		http: { kind: "heldBack", reason: "Only offered to bots in turns." },
		botLoop: {
			kind: "offered",
			tool: WEB_SEARCH_TOOL,
			offeredIn: "everywhere",
			approval: { kind: "never" },
		},
	},
} as const satisfies DomainExposure<typeof webContracts>;
