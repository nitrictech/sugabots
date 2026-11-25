import { FileText } from "lucide-react";
import preview from "#storybook/preview";
import { FileRow } from "./file-row.tsx";
import { IconTile } from "./icon-tile.tsx";

const meta = preview.meta({
	title: "Controls/FileRow",
	component: FileRow,
	args: {
		look: "card",
		title: "Weekly traction",
		subtitle: "Document by Growth Desk",
		icon: (
			<IconTile size="md">
				<FileText />
			</IconTile>
		),
		className: "max-w-80",
	},
});

/** DocumentCard opens a document from within a bot’s reply. */
export const DocumentCard = meta.story({
	args: {
		className: "max-w-80 focus-ring",
		render: (props) => <a {...props} href="/weekly-traction" />,
	},
});
