import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { localPapaPlugin, localPapa } from '../build/local-papa.mjs';
import vectors from './vectors/csv-formula-shield.json';

describe('the shipped text-only Papa Parse build', () => {
	it('passes the CSV vectors with remote and Node adapters removed', async () => {
		const result = await build({ entryPoints: ['src/csv.ts'], bundle: true, write: false, format: 'cjs', plugins: [localPapaPlugin] });
		const code = result.outputFiles![0]!.text;
		expect(code).not.toMatch(/XMLHttpRequest|require\(["']stream|createObjectURL/);
		const module = { exports: {} as { auditCsv: (input: string, policy: { retainNegativeNumbers: boolean }) => unknown } };
		runInNewContext(code, { module, exports: module.exports, TextEncoder });
		for (const vector of vectors.cases) {
			const input = vector.args[0];
			if (typeof input.csv !== 'string' || !('rows' in vector.expected)) continue;
			expect(JSON.parse(JSON.stringify(module.exports.auditCsv(input.csv, { retainNegativeNumbers: input.retain === true })))).toEqual(vector.expected);
		}
	});
	it('rejects download, worker, and non-string parse requests', async () => {
		const require = createRequire(import.meta.url);
		const source = await readFile(require.resolve('papaparse'), 'utf8');
		const module = { exports: {} as { parse: (input: unknown, config: unknown) => unknown } };
		runInNewContext(localPapa(source), { module, exports: module.exports });
		expect(() => module.exports.parse('text', { download: true })).toThrow('disabled');
		expect(() => module.exports.parse('text', { worker: true })).toThrow('disabled');
		expect(() => module.exports.parse({}, {})).toThrow('text only');
	});
});
