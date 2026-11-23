import { Server } from "@hocuspocus/server";
import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node } from "@tiptap/pm/model";
import { StarterKit } from "@tiptap/starter-kit";
import { prosemirrorToYXmlFragment, updateYFragment } from "@tiptap/y-tiptap";

/*
 * A sync server standing in for the API's live route in `live-document.test.tsx`,
 * run as its own process because a server can't share one with jsdom's globals.
 * It holds one document, and a bot rewrites it when the test sends its name.
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

process.on("message", async (artifactId: string) => {
	const bot = await server.hocuspocus.openDirectConnection(artifactId);
	await bot.transact((document) => {
		document.awareness.setLocalState({
			user: {
				name: "Planner",
				color: "#0d9488",
				agent: { color: "green", face: "pill", shape: "circle" },
			},
		});
		updateYFragment(
			document,
			document.getXmlFragment("default"),
			fromMarkdown("# Launch plan\n\nShip on Monday."),
			{ mapping: new Map(), isOMark: new Map() },
		);
	});
});

await server.listen();
process.send?.("listening");
