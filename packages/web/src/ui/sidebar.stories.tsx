import { Ellipsis, Plus } from "lucide-react";
import { useState } from "react";
import { expect, fn, userEvent } from "storybook/test";
import preview from "#storybook/preview";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SidebarRow, SidebarSection } from "./sidebar.tsx";

const roster = [
	{ name: "Linear Handler", hue: 265, face: "bar" },
	{ name: "Release Notes", hue: 95, face: "square" },
	{ name: "PR Reviewer", hue: 20, face: "smile" },
] as const;

function Rows({ selected }: { selected?: string }) {
	return (
		<>
			{roster.map((agent) => (
				<SidebarRow
					key={agent.name}
					as="button"
					type="button"
					selected={agent.name === selected}
					className="min-h-11 w-full gap-2.5 rounded-xl px-2.5 py-1.5 text-left"
				>
					<AgentAvatar hue={agent.hue} face={agent.face} size={28} />
					<span className="min-w-0 flex-1 truncate text-base font-medium">{agent.name}</span>
				</SidebarRow>
			))}
		</>
	);
}

const actions = (
	<>
		<IconButton label="New agent in Suga-Team" size="lg" onClick={fn()}>
			<Plus />
		</IconButton>
		<IconButton label="Suga-Team actions" size="lg" onClick={fn()}>
			<Ellipsis />
		</IconButton>
	</>
);

const meta = preview.meta({
	title: "Product/SidebarSection",
	component: SidebarSection,
	tags: ["ai-generated"],
	args: {
		label: "Suga-Team",
		open: true,
		count: roster.length,
		onToggle: fn(),
		children: <Rows selected="Linear Handler" />,
	},
	decorators: [
		(Story) => (
			<div className="w-[272px] bg-background p-2">
				<Story />
			</div>
		),
	],
});

/** Open, the rows speak for themselves and the heading carries no number. */
export const Open = meta.story({});

/** Folded, the heading is all that is left, so it says how much it is hiding. */
export const Folded = meta.story({ args: { open: false } });

/** Actions sit outside the disclosure and stay drawn, on a touchscreen too. */
export const WithActions = meta.story({ args: { actions } });

/** A pod with nothing in it yet still folds, and admits to being empty. */
export const Empty = meta.story({ args: { count: 0, children: null } });

/**
 * The whole heading is the target, rather than a chevron to aim at — and the
 * actions beside it are not part of it.
 */
export const TogglesFromTheHeading = meta.story({
	render: (args) => {
		const [open, setOpen] = useState(true);
		return <SidebarSection {...args} open={open} onToggle={() => setOpen(!open)} />;
	},
	play: async ({ canvas }) => {
		const heading = canvas.getByRole("button", { name: "Suga-Team" });
		await expect(canvas.getByText("Linear Handler")).toBeVisible();

		await userEvent.click(heading);

		await expect(canvas.queryByText("Linear Handler")).toBeNull();
		// Named rather than left to the contents, which would be read "Suga-Team3".
		await expect(canvas.getByRole("button", { name: "Suga-Team, 3" })).toBeVisible();
	},
});
