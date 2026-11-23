import { Server } from "@hocuspocus/server";
import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node } from "@tiptap/pm/model";
import { StarterKit } from "@tiptap/starter-kit";
import { prosemirrorToYXmlFragment, updateYFragment } from "@tiptap/y-tiptap";
import { XmlElement } from "yjs";

/*
 * A sync server standing in for the API's live route in `live-document.test.tsx`,
 * run as its own process because a server can't share one with jsdom's globals.
 * It holds each document asked for, and does to one what the test asks.
 */

const schema = getSchema([StarterKit]);
const markdown = new MarkdownManager({ extensions: [StarterKit] });
const fromMarkdown = (text: string) => Node.fromJSON(schema, markdown.parse(text));

const server = new Server({
	port: Number(process.argv[2]),
	quiet: true,
	onLoadDocument: async ({ document }) => {
		prosemirrorToYXmlFragment(
			fromMarkdown("# Launch plan\n\nShip on Friday."),
			document.getXmlFragment("default"),
		);
	},
});

/** What the test asks of the document: a bot's rewrite, a block no editor here can hold, or how many blocks it has. */
type Asked = { artifactId: string; ask: "rewrite" | "unknown block" | "count blocks" };

process.on("message", async ({ artifactId, ask }: Asked) => {
	const connection = await server.hocuspocus.openDirectConnection(artifactId);
	await connection.transact((document) => {
		const content = document.getXmlFragment("default");
		if (ask === "count blocks") return void process.send?.({ blocks: content.length });
		if (ask === "unknown block") return void content.push([new XmlElement("fromANewerVersion")]);
		document.awareness.setLocalState({
			user: {
				name: "Planner",
				color: "#0d9488",
				agent: { color: "green", face: "pill", shape: "circle" },
			},
		});
		updateYFragment(document, content, fromMarkdown("# Launch plan\n\nShip on Monday."), {
			mapping: new Map(),
			isOMark: new Map(),
		});
	});
});

await server.listen();
process.send?.("listening");
