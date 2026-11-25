import { FileText } from "lucide-react";
import preview from "#storybook/preview";
import { IconTile } from "./icon-tile.tsx";

const meta = preview.meta({
	title: "Controls/IconTile",
	component: IconTile,
	args: { size: "md", children: <FileText /> },
});

/** FileType marks the kind of file beside its title. */
export const FileType = meta.story({
	render: (args) => (
		<span className="flex items-center gap-2">
			<IconTile {...args} />
			Weekly traction
		</span>
	),
});
