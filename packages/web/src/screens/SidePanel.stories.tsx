import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { PanelSection, SidePanel } from "./SidePanel.tsx";

/** Something to sit beside, or under: a chat's worth of lines. */
function Chat() {
	return (
		<div className="flex flex-1 flex-col gap-3 p-6">
			{["Morning. Three things need you today.", "Move the budget one to Friday", "Done."].map(
				(line) => (
					<p key={line} className="m-0 max-w-7/10 rounded-bubble bg-chip px-3.5 py-2.5 text-sm">
						{line}
					</p>
				),
			)}
		</div>
	);
}

const meta = preview.meta({
	title: "Product/SidePanel",
	component: SidePanel,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { label: "Overnight outbound", onClose: fn(), children: null },
	render: (args) => (
		<div className="relative flex h-screen bg-background">
			<Chat />
			<SidePanel {...args} className="bg-background">
				<div className="flex flex-col gap-4 px-3.5 pb-4">
					<PanelSection title="Result">
						<p className="m-0 text-sm">
							Queued 38 leads. Six have replied; drafts are in the outbox.
						</p>
					</PanelSection>
				</div>
			</SidePanel>
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
