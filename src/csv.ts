import Papa from 'papaparse';

export const MAX_BYTES = 1024 * 1024;
export const PREVIEW_LIMIT = 200;
const PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r', '\n', '＝', '＋', '－', '＠']);
const NEGATIVE_NUMBER = /^-(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export interface Policy { retainNegativeNumbers: boolean }
export interface Finding { row: number; column: number; header: string; before: string; after: string }
export interface Audit { rows: string[][]; findings: Finding[]; output: string }

export function risky(cell: string, policy: Policy): boolean {
	return PREFIXES.has(cell.charAt(0)) && !(policy.retainNegativeNumbers && NEGATIVE_NUMBER.test(cell));
}

/** Comma CSV, text cells, with no formula evaluation or prefix normalization. */
export function parseCsv(input: string): string[][] {
	if (new TextEncoder().encode(input).byteLength > MAX_BYTES) throw new Error('The source is over 1 MiB. No copy was written.');
	if (input.includes('\u0000') || input.includes('\ufffd')) throw new Error('Use a UTF-8 CSV without NUL or replacement characters.');
	const text = input.replace(/^\uFEFF/, '');
	if (!text) throw new Error('The source is empty.');
	const parsed = Papa.parse<string[]>(text, { delimiter: ',', dynamicTyping: false, skipEmptyLines: false, quoteChar: '"', escapeChar: '"' });
	if (parsed.errors.length) throw new Error(`CSV parse error: ${parsed.errors[0]?.message ?? 'Invalid quotes'}`);
	const rows = parsed.data;
	// A final record separator does not add an empty record. Interior blank records remain subject to width checks.
	if (/(?:\r\n|\n|\r)$/.test(text) && rows[rows.length - 1]?.length === 1 && rows[rows.length - 1]?.[0] === '') rows.pop();
	const width = rows[0]?.length ?? 0;
	for (let i = 0; i < rows.length; i++) {
		if (rows[i]?.length !== width) throw new Error(`Row-width error at logical row ${i + 1}: expected ${width} columns.`);
	}
	return rows;
}

export function writeCsv(rows: string[][]): string {
	return Papa.unparse(rows, { delimiter: ',', quotes: true, newline: '\r\n', escapeFormulae: false });
}

export function auditCsv(input: string, policy: Policy): Audit {
	const rows = parseCsv(input);
	const findings: Finding[] = [];
	const outputRows = rows.map((row, r) => row.map((cell, c) => {
		if (!risky(cell, policy)) return cell;
		const after = "'" + cell;
		findings.push({ row: r + 1, column: c + 1, header: rows[0]?.[c] ?? '', before: cell, after });
		return after;
	}));
	return { rows, findings, output: writeCsv(outputRows) };
}

/** Visible control characters, bounded so a long cell cannot fill the dialog. */
export function previewText(text: string): string {
	const visible = JSON.stringify(text);
	return visible.length > 180 ? visible.slice(0, 177) + '…' : visible;
}

export function copyName(sourcePath: string, exists: (path: string) => boolean): string {
	const stem = sourcePath.replace(/\.csv$/i, '') + '.escaped';
	for (let n = 0; n < 10000; n++) {
		const path = `${stem}${n ? ` ${n + 1}` : ''}.csv`;
		if (!exists(path)) return path;
	}
	throw new Error('No free output name was found.');
}
