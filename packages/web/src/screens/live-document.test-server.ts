import { createHash } from "node:crypto";
import { Server } from "@hocuspocus/server";
import { imageTypeOf } from "@sugabots/contracts";
import { artifactImageAddress, artifactImageIds } from "@sugabots/contracts/http";
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
import { XmlElement } from "yjs";

/*
 * A sync server standing in for the API's live route in `live-document.test.tsx`,
 * run as its own process because a server can't share one with jsdom's globals.
 * It holds each document asked for, does to one what the test asks, and keeps
 * the images an editor uploads, as the API's image route does: refusing one
 * whose bytes aren't the kind it says it is, and keeping none for one
 * document, as if the API couldn't be reached.
 */

/** An image upload's path, holding the pod's and the artifact's ids. */
const IMAGE_UPLOAD = /^\/api\/pods\/([^/]+)\/artifacts\/([^/?]+)\/images\?/;

/** The document whose images the stand-in never keeps. */
const UNREACHABLE_ARTIFACT_ID = "0199a3a0-0000-7000-8000-000000000005";

const server = new Server({
	port: Number(process.argv[2]),
	quiet: true,
	onLoadDocument: async ({ document }) => {
		prosemirrorToYXmlFragment(
			liveDocumentFromMarkdown("# Launch plan\n\nShip on Friday."),
			document.getXmlFragment("default"),
		);
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
 * a block no editor here can hold, how many blocks it has, or what it holds
 * as markdown.
 */
type Asked = {
	artifactId: string;
	ask: "rewrite" | "unknown block" | "count blocks" | "markdown";
	markdown?: string;
};

process.on("message", async ({ artifactId, ask, markdown }: Asked) => {
	const connection = await server.hocuspocus.openDirectConnection(artifactId);
	await connection.transact((document) => {
		const content = document.getXmlFragment("default");
		if (ask === "count blocks") return void process.send?.({ blocks: content.length });
		if (ask === "markdown") {
			const held = yXmlFragmentToProseMirrorRootNode(content, liveDocumentSchema);
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
			liveDocumentFromMarkdown(markdown ?? "# Launch plan\n\nShip on Monday."),
			{ mapping: new Map(), isOMark: new Map() },
		);
	});
});

await server.listen();
process.send?.("listening");
