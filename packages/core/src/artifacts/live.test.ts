import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { Artifact } from "@sugabots/contracts";
import { Effect, Layer } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Doc, type XmlElement, type XmlFragment, XmlText } from "yjs";
import { agent, pod, thread, user, workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Artifacts } from "./artifacts.ts";
import { LiveDocuments } from "./live.ts";

describe.skipIf(!process.env.DATABASE_URL)("a live document, against Postgres", () => {
	let by: Artifacts.AgentInThread;

	/** The agents' authoring and the live documents it writes to, built together so they share one. */
	const services = () =>
		runOnPostgres(
			Effect.provide(
				Effect.all({ authoring: Artifacts.Authoring, live: LiveDocuments.Service }),
				Layer.merge(Artifacts.authoringLayer, LiveDocuments.layer),
			),
		);

	it("takes a person's and an agent's edits at once, each seeing the other's", async () => {
		const { authoring, live } = await services();
		const made = await runOnPostgres(
			authoring.create(by, {
				kind: "document",
				title: "Launch plan",
				content: "# Launch plan\n\nShip on Friday.",
			}),
		);
		const person = await joinAsPerson(live, made, "Kim");

		// The person retitles the plan in their editor.
		firstTextOf(person.document.getXmlFragment("default")).insert(
			"Launch plan".length,
			" (draft 2)",
		);
		const written = await runOnPostgres(
			authoring.edit(by, {
				artifactId: made.id,
				baseVersion: 1,
				oldText: "Ship on Friday.",
				newText: "Ship on Monday.",
			}),
		);

		await until(() => textOf(person.document).includes("Ship on Monday."));
		expect(textOf(person.document)).toBe("Launch plan (draft 2)Ship on Monday.");
		expect(written).toMatchObject({
			version: 2,
			content: "# Launch plan (draft 2)\n\nShip on Monday.",
		});
		expect(namesIn(person)).toEqual(["Kim", "Scribe"]);
		person.destroy();
	});

	it("gives an agent what people wrote, once they have left", async () => {
		const { authoring, live } = await services();
		const made = await runOnPostgres(
			authoring.create(by, { kind: "document", title: "Notes", content: "First draft." }),
		);
		const person = await joinAsPerson(live, made, "Kim");
		firstTextOf(person.document.getXmlFragment("default")).insert(0, "Kim's ");
		await until(async () =>
			(await runOnPostgres(authoring.read(by, made.id))).content.startsWith("Kim's"),
		);
		person.destroy();

		// A second process start: nothing in memory, only what was stored.
		const later = await services();
		expect(await runOnPostgres(later.authoring.read(by, made.id))).toMatchObject({
			content: "Kim's First draft.",
		});
	});

	it("leaves a document nobody has opened as its versions", async () => {
		const { authoring, live } = await services();
		const made = await runOnPostgres(
			authoring.create(by, {
				kind: "document",
				title: "Notes",
				content: "Text with a [^1] footnote.",
			}),
		);

		expect(await runOnPostgres(live.markdown(made.id))).toBeUndefined();
		expect(await runOnPostgres(authoring.read(by, made.id))).toMatchObject({
			content: "Text with a [^1] footnote.",
		});
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Live ${stamp}`, slug: `live-${stamp}` })
				.returning(),
		);
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Kim", email: `kim-${stamp}@example.com` })
				.returning(),
		);
		if (!space || !member) throw new Error("fixture");
		const workspaceId = space.id;
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({ workspaceId, kind: "shared", name: "Planning", slug: `planning-${stamp}` })
				.returning(),
		);
		if (!room) throw new Error("fixture");
		const [writer] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId: room.id,
					name: "Scribe",
					handle: `scribe-${stamp}`,
					color: "green",
					face: "pill",
					model: "claude-opus-4-1-20250805",
					createdById: member.id,
				})
				.returning(),
		);
		if (!writer) throw new Error("fixture");
		const [where] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId: room.id,
					hostAgentId: writer.id,
					type: "collaboration",
					title: "Planning",
				})
				.returning(),
		);
		if (!where) throw new Error("fixture");
		by = { workspaceId, podId: room.id, agentId: writer.id, threadId: where.id };
	});
});

/**
 * A person's editor in `artifact`'s live document: the sync client the web
 * app uses, over a socket that goes straight to `live.join` in place of the
 * API's WebSocket route.
 */
async function joinAsPerson(live: LiveDocuments.Interface, artifact: Artifact, name: string) {
	class SocketToLive extends EventTarget {
		readyState = 0;
		binaryType = "arraybuffer";
		private participant: LiveDocuments.Participant | undefined;

		constructor() {
			super();
			void runOnPostgres(
				live.join(artifact, {
					send: (bytes) =>
						this.dispatchEvent(new MessageEvent("message", { data: bytes.slice().buffer })),
					close: () => this.close(),
				}),
			).then((participant) => {
				this.participant = participant;
				this.readyState = 1;
				this.dispatchEvent(new Event("open"));
			});
		}

		send(data: Uint8Array) {
			this.participant?.receive(data);
		}

		close() {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this.participant?.leave();
			this.dispatchEvent(new Event("close"));
		}
	}

	const provider = new HocuspocusProvider({
		name: artifact.id,
		document: new Doc(),
		websocketProvider: new HocuspocusProviderWebsocket({
			url: "ws://live.invalid",
			WebSocketPolyfill: SocketToLive,
		}),
	});
	const synced = new Promise((resolve) => provider.on("synced", resolve));
	// A provider handed its socket doesn't start listening to it by itself.
	provider.attach();
	await synced;
	provider.setAwarenessField("user", { name });
	return provider;
}

/** The first run of text in the document, where a person's caret would be. */
function firstTextOf(fragment: XmlFragment): XmlText {
	const block = fragment.get(0) as XmlElement;
	const text = block.get(0);
	if (!(text instanceof XmlText)) throw new Error("The document doesn't start with text");
	return text;
}

const textOf = (document: Doc) =>
	document
		.getXmlFragment("default")
		.toArray()
		.map((block) => (block as XmlElement).toArray().join(""))
		.join("");

/** Who the person sees in the document, themselves included. */
const namesIn = (person: HocuspocusProvider) =>
	[...(person.awareness?.getStates().values() ?? [])]
		.map((state) => (state.user as { name: string } | undefined)?.name)
		.filter((name) => name !== undefined)
		.sort();

async function until(condition: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 5_000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("Waited 5 seconds for the document to catch up");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
