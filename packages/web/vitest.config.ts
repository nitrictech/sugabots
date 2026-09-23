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
			browser: {
				enabled: true,
				provider: playwright(),
				headless: true,
				instances: [{ browser: "chromium" }],
			},
		},
	}),
);
