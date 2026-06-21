import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'test/**/*.test.js',
	coverage: {
		include: ['concepts/**'],
		exclude: ['test/**', 'node_modules/**'],
		reporter: ['text', 'lcov'],
		all: true,
	},
});
