import type {
	BotParticipant,
	Connector,
	CurrentUser,
	Message,
	MessagePart,
	ToolCallPart,
} from "@sugabots/contracts";
import { testMember } from "@sugabots/contracts/testing";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { linear } from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";
import { createQueryClient } from "@/lib/query.ts";
import { ChatMessages } from "./ChatMessages.tsx";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

const PROJECT = "0199a3a0-0000-7000-8000-0000000000b1";
const CHAT = "0199a3a0-0000-7000-8000-0000000000b2";

const host: BotParticipant = {
	kind: "bot",
	id: "0199a3a0-0000-7000-8000-0000000000b3",
	name: "Linear Handler",
	handle: "linear-handler",
	color: "green",
	eyes: "pill",
	shape: "circle",
};

const signedIn: CurrentUser = {
	id: "0199a3a0-0000-7000-8000-0000000000b4",
	name: "Rowan Ellis",
	email: "rowan@example.com",
	image: null,
} as CurrentUser;

let nextId = 0;

function toolCall(tool: string, over: Partial<ToolCallPart> = {}): ToolCallPart {
	nextId += 1;
	return {
		type: "tool_call",
		id: `0199a3a0-0000-7000-8000-${String(nextId).padStart(12, "0")}`,
		tool,
		input: { query: "timeout" },
		output: { found: 3 },
		status: "completed",
		error: null,
		approval: null,
		atOffset: 0,
		startedAt: "2026-09-18T09:00:00.000Z",
		finishedAt: "2026-09-18T09:00:01.400Z",
		...over,
	};
}

function reply(parts: MessagePart[], over: Partial<Message> = {}): Message {
	const content = parts.map((part) => (part.type === "text" ? part.text : "")).join("");
	return {
		id: "0199a3a0-0000-7000-8000-0000000000c1",
		chatId: CHAT,
		author: host,
		status: "complete",
		parts,
		content,
		createdAt: "2026-09-18T09:00:02.000Z",
		...over,
	};
}

function connector(handle: string, name: string, url: string): Connector {
	return {
		id: `0199a3a0-0000-7000-8000-00000000${handle.length}aa1`,
		workspaceId: "0199a3a0-0000-7000-8000-0000000000a1",
		projectId: PROJECT,
		name,
		handle,
		url,
		kind: "mcp",
		auth: "oauth",
		signedIn: true,
		signInExpired: false,
		secretHeader: null,
		hasSecret: false,
		appSettingsUrl: null,
		status: "connected",
		toolCounts: { allow: 0, ask: 0, off: 0 },
		lastTestError: null,
		connectedBy: null,
		signedInAs: null,
		createdAt: "2026-09-18T08:00:00.000Z",
	};
}

/** Someone else in the project, whom a member's `@here` or `@channel` would notify. */
const jay = testMember({ id: "0199a3a0-0000-7000-8000-0000000000d1", name: "Jay Park" });

/** Renders the chat, and returns `update` to redraw it as a live one would. */
function show(
	messages: Message[],
	over: {
		canApprove?: boolean;
		participants?: BotParticipant[];
	} = {},
) {
	const queryClient = createQueryClient();
	// The roster the sidebar loads, which says where the host's connectors are.
	queryClient.setQueryData(
		["bots", linear.workspaceId],
		[{ ...linear, id: host.id, defaultProjectId: PROJECT }],
	);
	const chat = (shown: Message[], participants = over.participants ?? [host]) => (
		<QueryClientProvider client={queryClient}>
			<ChatMessages
				fileUrlOf={(fileId) => `/files/${fileId}`}
				messages={shown}
				typing={{ host, isRunning: false }}
				participants={participants}
				membersReachingProject={[jay]}
				chatKind="project_chat"
				dividers={false}
				approvalPermissions={{
					approveToolCallsIn: (over.canApprove ?? true) ? shown.map((message) => message.id) : [],
					approveComputerRequests: over.canApprove ?? true,
					interruptTurns: [],
				}}
			/>
		</QueryClientProvider>
	);
	const view = render(chat(messages));
	return {
		update: (shown: Message[], participants?: BotParticipant[]) =>
			view.rerender(chat(shown, participants)),
	};
}

beforeEach(() => {
	client.api.connectors.list.mockReturnValue(
		Effect.succeed([
			connector("sentry", "Sentry", "https://mcp.sentry.dev/mcp"),
			connector("linear", "Linear", "https://mcp.linear.app/mcp"),
		]),
	);
	client.api.approvals.decide.mockReturnValue(Effect.undefined);
});

describe("what members and bots write", () => {
	it("renders Markdown from members and bots alike", async () => {
		const asked = "Is **this** bold?";
		const answered = "**Theo's bill** is high.\n\n- Look up plans\n- Draft a note";
		show([
			reply([{ type: "text", text: asked }], {
				id: "0199a3a0-0000-7000-8000-0000000000c0",
				author: testMember({ id: signedIn.id, name: signedIn.name }),
				createdAt: "2026-09-18T09:00:00.000Z",
			}),
			reply([{ type: "text", text: answered }]),
		]);

		await screen.findByText("Theo's bill");
		expect(
			within(screen.getByRole("list"))
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["Look up plans", "Draft a note"]);
		screen.getByText("this");
	});

	it("copies a reply as the bot wrote it, Markdown and all", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		onTestFinished(() => {
			Reflect.deleteProperty(navigator, "clipboard");
		});
		const answered = "**Theo's bill** is high.\n\n- Look up plans";
		show([reply([{ type: "text", text: answered }])]);

		fireEvent.click(await screen.findByRole("button", { name: "Copy text" }));

		expect(writeText).toHaveBeenCalledWith(answered);
		await screen.findByRole("button", { name: "Copied" });
	});

	it("marks a mention in a reply already shown, once it names someone", async () => {
		const triager: BotParticipant = {
			kind: "bot",
			id: "0199a3a0-0000-7000-8000-0000000000b5",
			name: "Issue Triager",
			handle: "issue-triager",
			color: "orange",
			eyes: "dot",
			shape: "circle",
		};
		const answer = reply([{ type: "text", text: "I asked @issue-triager about it." }]);
		const { update } = show([answer]);
		await screen.findByText(/I asked/);
		expect(screen.queryByText("Issue Triager", { selector: "span" })).toBeNull();

		update([answer], [host, triager]);

		await screen.findByText("Issue Triager", { selector: "span" });
	});

	it("marks a member's @here and @channel as mentions of everyone, but not a bot's", async () => {
		show([
			reply([{ type: "text", text: "@here the deploy is out, @channel please check." }], {
				id: "0199a3a0-0000-7000-8000-0000000000c0",
				author: testMember({ id: signedIn.id, name: signedIn.name }),
				createdAt: "2026-09-18T09:00:00.000Z",
			}),
			reply([{ type: "text", text: "Checked. @channel it is fine." }]),
		]);

		const chips = await screen.findAllByText(/^(@here|@channel)$/, { selector: "span" });

		// The bot's `@channel` is not among them.
		expect(chips.map((chip) => chip.textContent)).toEqual(["@here", "@channel"]);
	});
});

describe("a finished reply that used tools", () => {
	const answered = reply([
		toolCall("sentry__search_issues"),
		toolCall("sentry__search_issues"),
		toolCall("sentry__search_issues"),
		toolCall("linear__list_issues"),
		{ type: "text", text: "Yes — 41 events, all on checkout." },
	]);

	it("shows the answer, and what it used on one line above it", async () => {
		show([answered]);

		screen.getByText("Yes — 41 events, all on checkout.");
		await screen.findByRole("button", { name: /Used Sentry and Linear for 6s/ });
		expect(screen.queryByText("Search issues")).toBeNull();
	});

	it("lists each tool source it used when its line is opened, and each call when a tool source's is", async () => {
		show([answered]);

		const line = await screen.findByRole("button", { name: /Used Sentry and Linear/ });
		fireEvent.click(line);

		expect(line.getAttribute("aria-expanded")).toBe("true");
		screen.getByText("List issues");
		fireEvent.click(screen.getByRole("button", { name: /^Used Sentry for .*3 steps/ }));
		expect(screen.getAllByText("Search issues")).toHaveLength(3);
	});
});

describe("a reply that wrote a line before each tool call", () => {
	const narrated = reply([
		{ type: "text", text: "Let me find the current cycle:" },
		toolCall("linear__get_cycle"),
		{ type: "text", text: "Now the issues in it:" },
		toolCall("linear__list_issues"),
		{ type: "text", text: "Here are the 2 issues in Cycle 33." },
	]);

	it("shows only the answer: what it said on the way is the tool line's to stand for", async () => {
		show([narrated]);

		const bubble = screen.getByRole("article");
		expect(bubble.textContent).toContain("Here are the 2 issues in Cycle 33.");
		expect(bubble.textContent).not.toContain("Let me find the current cycle:");
		await screen.findByRole("button", { name: /Used Linear/ });
	});
});

describe("a reply that wrote nothing but used tools", () => {
	// A turn that called a tool and produced no text has no text part at all —
	// `messagePartsFor` adds none when the content is empty. It still needs a
	// bubble: that is where a failure shows.
	const wordless = reply([toolCall("sentry__search_issues")], { content: "" });

	it("still shows who replied, and what it used", async () => {
		show([wordless]);

		await screen.findByRole("button", { name: /Used Sentry/ });
		screen.getByLabelText(/Linear Handler/);
	});

	it("still says a reply failed when it failed without words", async () => {
		show([
			reply([toolCall("sentry__search_issues")], {
				content: "",
				status: "failed",
				error: "Ran out of context",
			}),
		]);

		await screen.findByText("Reply failed.");
		screen.getByText(/Ran out of context/);
	});
});

describe("a reply still being written", () => {
	const answer: MessagePart = { type: "text", text: "Here are the 2 issues in Cycle 33." };

	it("shows its words as they come, and moves them to its work line once a call follows them", async () => {
		const search = toolCall("sentry__search_issues", {
			status: "running",
			output: null,
			finishedAt: null,
		});
		const { update } = show([
			reply([{ type: "text", text: "Let me look" }], { status: "writing" }),
		]);
		expect(screen.getByRole("article").textContent).toContain("Let me look");
		screen.getByRole("status", { name: "Linear Handler is typing" });

		update([reply([{ type: "text", text: "Let me look" }, search], { status: "writing" })]);
		await screen.findByRole("button", { name: /Working for/ });
		const narration = screen.getByText("Let me look");
		expect(narration.closest("[data-slot=activity-collapsible-content]")).not.toBeNull();

		update([reply([{ ...search, status: "completed", finishedAt: search.startedAt }, answer])]);
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByRole("article").textContent).toContain("Here are the 2 issues in Cycle 33.");
	});

	it("shows the text a reply is still writing after it shares a file", () => {
		const chart: MessagePart = {
			type: "file",
			id: "0199a3a0-0000-7000-8000-0000000000f1",
			name: "chart.png",
			contentType: "image/png",
			size: 2048,
		};
		show([reply([{ type: "text", text: "Here is the cha" }, chart], { status: "writing" })]);

		screen.getByText(/Here is the cha/);
	});

	it("says the bot is typing between one call and the next", () => {
		show([reply([toolCall("sentry__search_issues")], { status: "writing" })]);

		screen.getByRole("status", { name: "Linear Handler is typing" });
	});

	it("gives way to a write waiting on approval, which says so itself", async () => {
		show([
			reply(
				[
					toolCall("linear__create_issue", {
						status: "awaiting_approval",
						output: null,
						finishedAt: null,
						approval: {
							status: "pending",
							approvers: "chat",
							decidedByName: null,
							decidedAt: null,
						},
					}),
				],
				{ status: "writing" },
			),
		]);

		await screen.findByRole("button", { name: /^Allow/ });
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("types again once the write is allowed, before it starts", async () => {
		show([
			reply(
				[
					toolCall("linear__create_issue", {
						status: "awaiting_approval",
						output: null,
						finishedAt: null,
						approval: {
							status: "allowed",
							approvers: "chat",
							decidedByName: "Rowan Ellis",
							decidedAt: null,
						},
					}),
				],
				{ status: "writing" },
			),
		]);

		await screen.findByRole("button", { name: /Working for/ });
		screen.getByRole("status", { name: "Linear Handler is typing" });
		const card = screen.getByRole("region", { name: "Approval request: Create issue in Linear" });
		expect(within(card).queryByRole("button", { name: /^Allow/ })).toBeNull();
	});
});

describe("a write that needs approving", () => {
	const pending = toolCall("linear__create_issue", {
		status: "awaiting_approval",
		output: null,
		finishedAt: null,
		input: { team: "Platform", title: "Checkout requests time out" },
		approval: { status: "pending", approvers: "chat", decidedByName: null, decidedAt: null },
	});
	const asking = reply([{ type: "text", text: "I want to open an issue." }, pending]);

	it("stops the reply, says so on its work line, and shows what it would send", async () => {
		show([asking]);

		const card = await screen.findByRole("region", {
			name: "Approval request: Create issue in Linear",
		});
		screen.getByText("Waiting for approval");
		within(card).getByText("Linear Handler wants to use Linear");
		within(card).getByText("Team");
		within(card).getByText("Platform");
	});

	it("allows it once, with no standing permission offered here", async () => {
		const approval = client.api.approvals.decide;
		show([asking]);

		fireEvent.click(await screen.findByRole("button", { name: /^Allow/ }));
		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({ decision: "allow_once" });
		expect(screen.queryByRole("checkbox")).toBeNull();
	});

	it("sends a refusal when denied", async () => {
		const approval = client.api.approvals.decide;
		show([asking]);

		fireEvent.click(await screen.findByRole("button", { name: /^Deny/ }));
		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({ decision: "deny" });
	});

	it("says so when the reader is not the one who can answer", async () => {
		show([asking], { canApprove: false });

		await screen.findByText("Waiting for someone with permission to answer this.");
		expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
	});

	it("keeps a refused write as its card, and says on its tool line who refused it", async () => {
		show([
			reply([
				{ type: "text", text: "Left it untracked." },
				toolCall("linear__create_issue", {
					status: "awaiting_approval",
					output: null,
					finishedAt: null,
					approval: {
						status: "denied",
						approvers: "chat",
						decidedByName: "Rowan Ellis",
						decidedAt: null,
					},
				}),
			]),
		]);

		const line = await screen.findByRole("button", { name: /Linear denied/ });
		const card = screen.getByRole("region", { name: "Approval request: Create issue in Linear" });
		expect(within(card).queryByRole("button", { name: /^(Allow|Deny)/ })).toBeNull();
		fireEvent.click(line);
		screen.getByText("Denied by Rowan Ellis");
	});
});
