import { describe, expect, it } from 'vitest';
import vectors from './vectors/csv-formula-shield.json';
import { runAcceptanceCase } from './scenarios';
import { auditCsv, parseCsv, previewText, MAX_BYTES } from '../src/csv';

describe('acceptance vectors', () => {
	for (const vector of vectors.cases) it(vector.name, async () => expect(await runAcceptanceCase(vector.args[0])).toEqual(vector.expected));
});

describe('writer invariants', () => {
	it('the escaped output is idempotent with the same policy', () => {
		const a = auditCsv('a,b\n=2,"-1+2"\n\'@x,"a,b"', { retainNegativeNumbers: false });
		const b = auditCsv(a.output, { retainNegativeNumbers: false });
		expect(b.findings).toEqual([]);
		expect(b.output).toBe(a.output);
	});
	it('checks the rows after the 200-entry preview boundary', () => {
		const a = auditCsv('value\n' + Array.from({ length: 250 }, (_, i) => '=1+' + i).join('\n'), { retainNegativeNumbers: false });
		expect(a.findings).toHaveLength(250);
		expect(parseCsv(a.output)[250]).toEqual(["'=1+249"]);
	});
	it('counts UTF-8 bytes rather than UTF-16 characters', () => {
		expect(() => parseCsv('é'.repeat(MAX_BYTES / 2 + 1))).toThrow('over 1 MiB');
		expect(parseCsv('x'.repeat(MAX_BYTES))).toHaveLength(1);
	});
	it('renders control characters and bounds long preview text', () => {
		expect(previewText('\t\n\r')).toBe('"\\t\\n\\r"');
		expect(previewText('x'.repeat(1000))).toHaveLength(178);
	});
});
