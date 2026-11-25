import preview from "#storybook/preview";
import { LetterTile } from "./letter-tile.tsx";

const meta = preview.meta({
	title: "Controls/LetterTile",
	component: LetterTile,
	args: { name: "Nitric" },
});

/** WorkspaceInitial identifies a workspace that has no logo. */
export const WorkspaceInitial = meta.story({
	render: (args) => (
		<span className="flex items-center gap-2">
			<LetterTile {...args} />
			{args.name}
		</span>
	),
});
