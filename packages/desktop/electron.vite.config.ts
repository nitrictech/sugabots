import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {
		build: { rolldownOptions: { input: { main: "src/main.ts" } } },
	},
	preload: {
		build: {
			rolldownOptions: {
				input: {
					"setup-preload": "src/setup/preload.ts",
					"switcher-preload": "src/switcher/preload.ts",
					"unreachable-preload": "src/unreachable/preload.ts",
				},
				// Electron runs a sandboxed preload as a classic script, never as an ES module.
				output: { format: "cjs", entryFileNames: "[name].cjs" },
			},
		},
	},
	renderer: {
		root: "src",
		build: {
			rolldownOptions: {
				input: {
					setup: resolve(import.meta.dirname, "src/setup/page.html"),
					switcher: resolve(import.meta.dirname, "src/switcher/page.html"),
					unreachable: resolve(import.meta.dirname, "src/unreachable/page.html"),
				},
			},
		},
	},
});
