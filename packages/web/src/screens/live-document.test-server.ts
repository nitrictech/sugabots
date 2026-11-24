import { createHash } from "node:crypto";
import { Server } from "@hocuspocus/server";
import {
	imageTypeOf,
	LIVE_EDITOR_REFUSED_CLOSE_CODE,
	type LiveArtifactKind,
	liveEditorQuerySchema,
} from "@sugabots/contracts";
import { artifactImageAddress, artifactImageIds } from "@sugabots/contracts/http";
import { LIVE_DOCUMENT_SCHEMA } from "@sugabots/contracts/live-document";
import {
	liveDocumentFromMarkdown,
	liveDocumentSchema,
	markdownOfLiveDocument,
} from "@sugabots/contracts/live-document-markdown";
import {
	prosemirrorToYXmlFragment,
	updateYFragment,
	yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import { Option, Schema } from "effect";
import { WebSocketServer } from "ws";
import { XmlElement } from "yjs";

/*
 * A sync server standing in for the API's live route in `live-document.test.tsx`,
 * run as its own process because a server can't share one with jsdom's globals.
 * It holds each document or deck asked for, does to one what the test asks,
 * and keeps the images an editor uploads, as the API's image route does:
 * refusing one whose bytes aren't the kind it says it is, and keeping none
 * for one document, as if the API couldn't be reached. As the API does, it
 * refuses an editor built for another schema or kind than the artifact's.
 */

/** An image upload's path, holding the pod's and the artifact's ids. */
const IMAGE_UPLOAD = /^\/api\/pods\/([^/]+)\/artifacts\/([^/?]+)\/images\?/;

/** A live route's path, holding the artifact's id. */
const LIVE_ROUTE = /^\/api\/pods\/[^/]+\/artifacts\/([^/?]+)\/live\?/;

/** The document whose images the stand-in never keeps. */
const UNREACHABLE_ARTIFACT_ID = "0199a3a0-0000-7000-8000-000000000005";

/** The artifacts the stand-in holds as decks. Every other one is a document. */
const DECK_IDS = new Set([
	"0199a3a0-0000-7000-8000-0000000000d1",
	"0199a3a0-0000-7000-8000-0000000000d2",
]);

const kindOf = (artifactId: string): LiveArtifactKind =>
	DECK_IDS.has(artifactId) ? "slides" : "document";

/** What the stand-in holds of each kind before anybody changes it. */
const STARTING_MARKDOWN: Record<LiveArtifactKind, string> = {
	document: "# Launch plan\n\nShip on Friday.",
	slides:
		"<!-- layout: title -->\n\n# Launch review\n\n---\n\n<!-- layout: bullets -->\n\n## Goals\n\n- Ship on Friday",
};

/** How many editors each artifact's route has refused. */
const refusals = new Map<string, number>();

/** Opens the socket of an editor it refuses, only to close it saying why. */
const refusing = new WebSocketServer({ noServer: true });

const decodeBuiltFor = Schema.decodeUnknownOption(liveEditorQuerySchema);

const server = new Server({
	port: Number(process.argv[2]),
	quiet: true,
	onLoadDocument: async ({ documentName, document }) => {
		const kind = kindOf(documentName);
		prosemirrorToYXmlFragment(
			liveDocumentFromMarkdown(kind, STARTING_MARKDOWN[kind]),
			document.getXmlFragment("default"),
		);
	},
	onUpgrade: async ({ request, socket, head }) => {
		const [, artifactId = ""] = LIVE_ROUTE.exec(request.url ?? "") ?? [];
		const query = new URL(request.url ?? "", "http://stand-in").searchParams;
		const builtFor = decodeBuiltFor(Object.fromEntries(query));
		const fits = Option.exists(
			builtFor,
			({ schema, kind }) => schema === LIVE_DOCUMENT_SCHEMA && kind === kindOf(artifactId),
		);
		if (fits) return;
		refusals.set(artifactId, (refusals.get(artifactId) ?? 0) + 1);
		refusing.handleUpgrade(request, socket, head, (refused) =>
			refused.close(LIVE_EDITOR_REFUSED_CLOSE_CODE),
		);
		// Refusing with nothing is how a hook says it has answered the request itself.
		return Promise.reject();
	},
	onRequest: async ({ request, response }) => {
		const [, podId, artifactId] = IMAGE_UPLOAD.exec(request.url ?? "") ?? [];
		if (request.method !== "POST" || !podId || !artifactId) return;
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk);
		const bytes = Buffer.concat(chunks);
		const imageId = createHash("sha256").update(bytes).digest("hex");
		const image = artifactImageIds({ podId, artifactId, imageId });
		const type = new URL(request.url ?? "", "http://stand-in").searchParams.get("type");
		if (artifactId === UNREACHABLE_ARTIFACT_ID || !image) {
			response.writeHead(503);
			response.end();
		} else if (imageTypeOf(bytes) !== type) {
			response.writeHead(400);
			response.end();
		} else {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ address: artifactImageAddress(image) }));
		}
		// Refusing with nothing is how a hook says it has answered the request itself.
		return Promise.reject();
	},
});

/**
 * What the test asks of the document: a bot's rewrite, or one to `markdown`,
 * a block no editor here can hold, how many blocks it has, what it holds as
 * markdown, or how many editors its route has refused.
 */
type Asked = {
	artifactId: string;
	ask: "rewrite" | "unknown block" | "count blocks" | "markdown" | "count refusals";
	markdown?: string;
};

process.on("message", async ({ artifactId, ask, markdown }: Asked) => {
	if (ask === "count refusals") {
		return void process.send?.({ refusals: refusals.get(artifactId) ?? 0 });
	}
	const connection = await server.hocuspocus.openDirectConnection(artifactId);
	await connection.transact((document) => {
		const content = document.getXmlFragment("default");
		if (ask === "count blocks") return void process.send?.({ blocks: content.length });
		if (ask === "markdown") {
			const held = yXmlFragmentToProseMirrorRootNode(content, liveDocumentSchema("document"));
			return void process.send?.({ markdown: markdownOfLiveDocument(held) });
		}
		if (ask === "unknown block") return void content.push([new XmlElement("fromANewerVersion")]);
		document.awareness.setLocalState({
			user: {
				name: "Planner",
				color: "#0d9488",
				agent: { color: "green", face: "pill", shape: "circle" },
			},
		});
		updateYFragment(
			document,
			content,
			liveDocumentFromMarkdown("document", markdown ?? "# Launch plan\n\nShip on Monday."),
			{ mapping: new Map(), isOMark: new Map() },
		);
	});
});

await server.listen();
process.send?.("listening");
