import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./.storybook/vite.config.ts";

export default mergeConfig(
	viteConfig,
	defineConfig({
		plugins: [
			storybookTest({
				configDir: fileURLToPath(new URL("./.storybook/", import.meta.url)),
				storybookScript: "bun run storybook",
			}),
		],
		publicDir: fileURLToPath(new URL("./.storybook/public", import.meta.url)),
		test: {
			name: "storybook",
			// A story's waits each take up to 10 seconds on a busy machine (see the preview), and the
			// accessibility check up to 5 more, so this leaves room for a real miss to fail as itself.
			testTimeout: 30_000,
			browser: {
				enabled: true,
				provider: playwright(),
				headless: true,
				instances: [{ browser: "chromium" }],
			},
		},
	}),
);
