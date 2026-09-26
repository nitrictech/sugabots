import { useState } from "react";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "./button.tsx";
import { DeleteDialog } from "./delete-dialog.tsx";
import { DialogContent } from "./dialog.tsx";

const providers = [
	{ name: "Anthropic", detail: "6 models enabled" },
	{ name: "OpenAI", detail: "3 models enabled" },
	{ name: "Ollama", detail: "Connects to localhost:11434" },
];

function ProvidersPage() {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex min-h-dvh flex-col gap-4 bg-background p-8">
			<h1 className="font-bold text-2xl text-foreground">Providers</h1>
			<p className="max-w-prose text-muted-foreground">
				Every provider you connect offers its models to the bots in this workspace.
			</p>
			{providers.map((provider) => (
				<div key={provider.name} className="flex justify-between gap-4 rounded-panel bg-list p-4">
					<span className="font-medium">{provider.name}</span>
					<span className="text-muted-foreground">{provider.detail}</span>
				</div>
			))}
			<Button variant="destructive" className="self-start" onClick={() => setOpen(true)}>
				Disconnect Anthropic
			</Button>
			<DeleteDialog
				open={open}
				onOpenChange={setOpen}
				title="Disconnect Anthropic?"
				description="Bots using its models stop answering until you connect another provider."
				confirmLabel="Disconnect"
				pending={false}
				onDelete={() => setOpen(false)}
			/>
		</div>
	);
}

const meta = preview.meta({
	title: "Patterns/Dialog",
	component: DialogContent,
	parameters: { layout: "fullscreen" },
	args: {},
	render: () => <ProvidersPage />,
});

/** Scrim dims the page behind the dialog, which is what separates a modal from a panel. */
export const Scrim = meta.story({
	play: async ({ canvas, canvasElement, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Disconnect Anthropic" }));
		const { body } = canvasElement.ownerDocument;
		await within(body).findByRole("dialog", { name: "Disconnect Anthropic?" });

		await expect(body.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull();
	},
});
