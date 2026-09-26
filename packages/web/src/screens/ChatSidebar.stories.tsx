import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { ChatSidebar, SidebarSection } from "./ChatSidebar.tsx";

/** Something to sit beside, or under: a chat's worth of lines. */
function Chat() {
	return (
		<div className="flex flex-1 flex-col gap-3 p-6">
			{["Morning. Three things need you today.", "Move the budget one to Friday", "Done."].map(
				(line) => (
					<p
						key={line}
						className="m-0 max-w-[70%] rounded-bubble bg-chip px-3.5 py-2.5 text-[15px]"
					>
						{line}
					</p>
				),
			)}
		</div>
	);
}

const meta = preview.meta({
	title: "Product/ChatSidebar",
	component: ChatSidebar,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { label: "Collaboration", onClose: fn(), children: null },
	render: (args) => (
		<div className="relative flex h-screen bg-background">
			<Chat />
			<ChatSidebar {...args} className="bg-background">
				<div className="flex flex-col gap-4 px-3.5 pb-4">
					<SidebarSection title="Summary" className="px-3.5 py-3">
						<p className="m-0 text-[14px]">Linear Handler checked Sentry and opened an issue.</p>
					</SidebarSection>
				</div>
			</ChatSidebar>
		</div>
	),
});

/** Beside the chat; on a phone it covers it, as Details does. */
export const Beside = meta.story({
	play: async ({ canvas, args, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Close" }));
		await expect(args.onClose).toHaveBeenCalledOnce();
	},
});

/**
 * A collaboration on a phone: a sheet risen over the chat, which stays in
 * view above it and closes it when tapped. Beside the chat on a wide screen.
 */
export const Sheet = meta.story({
	args: { sheet: true },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("complementary", { name: "Collaboration" })).toBeInTheDocument();
	},
});
