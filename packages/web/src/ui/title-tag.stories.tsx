import preview from "#storybook/preview";
import { TitleTag } from "./title-tag.tsx";

const meta = preview.meta({
	title: "Controls/TitleTag",
	component: TitleTag,
	args: { children: "Owner" },
});

/** MemberRole puts the workspace role beside the member’s name. */
export const MemberRole = meta.story({
	render: (args) => (
		<span className="flex items-center gap-2">
			Rowan Ellis <TitleTag {...args} />
		</span>
	),
});
