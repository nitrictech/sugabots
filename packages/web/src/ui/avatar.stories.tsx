import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { PersonAvatar } from "./avatar.tsx";

/** A photo drawn inline, so the story needs nothing from the network. */
const PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#0ea5e9"/><circle cx="20" cy="16" r="7" fill="#e0f2fe"/><rect x="8" y="26" width="24" height="14" rx="7" fill="#e0f2fe"/></svg>',
)}`;

const meta = preview.meta({
	title: "Controls/PersonAvatar",
	component: PersonAvatar,
	tags: ["ai-generated"],
	args: { person: { name: "Ryan Eyes", email: "ryan@example.com" } },
});

/** Initials on a grey disc at each size the app uses: rows, lists, the rail, a page's hero. */
export const Sizes = meta.story({
	render: (args) => (
		<div style={{ display: "flex", alignItems: "center", gap: 16 }}>
			{[22, 30, 32, 36, 46, 88].map((size) => (
				<PersonAvatar key={size} {...args} size={size} />
			))}
		</div>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getAllByText("RE")).toHaveLength(6);
	},
});

/** One name gives its first two letters; several give the first and last initial. */
export const Initials = meta.story({
	render: () => (
		<div style={{ display: "flex", gap: 16 }}>
			<PersonAvatar person={{ name: "Mara", email: "mara@example.com" }} size={36} />
			<PersonAvatar person={{ name: "Jay Young", email: "jay@example.com" }} size={36} />
			<PersonAvatar person={{ name: "Sam de la Park", email: "sam@example.com" }} size={36} />
		</div>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByText("MA")).toBeInTheDocument();
		await expect(canvas.getByText("SP")).toBeInTheDocument();
	},
});

/** A photo fills the disc in place of the initials. */
export const WithPhoto = meta.story({
	args: { person: { name: "Ryan Eyes", email: "ryan@example.com", image: PHOTO }, size: 46 },
	play: async ({ canvas }) => {
		await expect(canvas.getByTitle("Ryan Eyes").querySelector("img")).not.toBeNull();
	},
});
