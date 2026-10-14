import { App } from 'obsidian-test-mocks/obsidian';
import { auditCsv, copyName, MAX_BYTES } from '../src/csv';
import CsvFormulaShieldPlugin from '../src/main';
import manifest from '../manifest.json';

export interface CaseInput { csv?: string; retain?: boolean; action?: string; source?: string; existing?: string[] }
export async function runAcceptanceCase(input: CaseInput): Promise<unknown> {
	if (input.action === 'name') return copyName(input.source!, (path) => input.existing!.includes(path));
	if (input.action === 'cancel') {
		const app = App.createConfigured__({ files: { 'data.csv': 'a,b\nx,=2' } });
		const plugin = new CsvFormulaShieldPlugin(app as never, manifest as never);
		await plugin.preview(app.vault.getFiles()[0]! as never);
		plugin.onunload();
		return app.vault.getFiles().map((f) => f.path).sort();
	}
	try { return auditCsv(input.action === 'oversize' ? 'x'.repeat(MAX_BYTES + 1) : input.csv!, { retainNegativeNumbers: input.retain === true }); }
	catch (error) {
		const msg = String(error);
		return { error: msg.includes('over 1 MiB') ? 'size' : msg.includes('parse error') ? 'parse' : msg.includes('Row-width') ? 'width' : msg.includes('empty') ? 'empty' : 'encoding' };
	}
}
