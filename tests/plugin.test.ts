import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import { auditCsv } from '../src/csv';
import CsvFormulaShieldPlugin from '../src/main';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';
import { bindPro, resetPro, SPONSORS } from '../src/pro';
import type { SponsorsManager } from '../src/license/index';
import manifest from '../manifest.json';

function setup(text = 'name,value\nAda,=1+1') {
	const app = App.createConfigured__({ files: { 'data.csv': text, 'data.escaped.csv': 'existing' } });
	const plugin = new CsvFormulaShieldPlugin(app as never, manifest as never);
	return { app, plugin, file: app.vault.getFileByPath('data.csv')! };
}
function pro(on: boolean) { bindPro({ isPro: () => on, onChange: () => () => undefined } as unknown as SponsorsManager); }

beforeEach(() => { resetPro(); document.body.replaceChildren(); });
describe('vault operations and Pro gates', () => {
	it('loads defaults and repairs invalid saved values', async () => {
		const { plugin } = setup(); await plugin.loadSettings();
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ retainNegativeNumbers: 'yes', policies: { a: { retainNegativeNumbers: 1 }, b: { retainNegativeNumbers: true } } })).toEqual({ retainNegativeNumbers: false, policies: { b: { retainNegativeNumbers: true } } });
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});
	it('writes a numbered copy and keeps source and existing output', async () => {
		const { app, plugin, file } = setup();
		const text = await app.vault.read(file);
		const policy = { retainNegativeNumbers: false };
		const copy = await plugin.writeCopy({ file: file as never, text, policy, audit: auditCsv(text, policy) });
		expect(copy.path).toBe('data.escaped 2.csv');
		expect(await app.vault.read(file)).toBe(text);
		expect(await app.vault.read(app.vault.getFileByPath('data.escaped.csv')!)).toBe('existing');
		expect(await app.vault.read(copy as never)).toContain("'=1+1");
	});
	it('stops if the source changed after preview', async () => {
		const { app, plugin, file } = setup(); const text = await app.vault.read(file); const policy = { retainNegativeNumbers: false };
		await app.vault.modify(file, 'changed');
		await expect(plugin.writeCopy({ file: file as never, text, policy, audit: auditCsv(text, policy) })).rejects.toThrow('source changed');
		expect(app.vault.getFiles()).toHaveLength(2);
	});
	it('does not write if the plugin unloads during the approval read', async () => {
		const { app, plugin, file } = setup();
		const text = await app.vault.read(file); const policy = { retainNegativeNumbers: false };
		vi.spyOn(plugin, 'readSource').mockImplementation(async () => { plugin.onunload(); return text; });
		await expect(plugin.writeCopy({ file: file as never, text, policy, audit: auditCsv(text, policy) }).then(() => 'created')).rejects.toThrow('closed');
		expect(app.vault.getFiles()).toHaveLength(2);
	});
	it('writes the policy approved before the asynchronous source read', async () => {
		const { app, plugin, file } = setup('value\n-12');
		const text = await app.vault.read(file); const policy = { retainNegativeNumbers: false };
		const source = { file: file as never, text, policy, audit: auditCsv(text, policy) };
		vi.spyOn(plugin, 'readSource').mockImplementation(async () => { source.policy.retainNegativeNumbers = true; return text; });
		const output = await plugin.writeCopy(source);
		expect(await app.vault.read(output as never)).toContain("'-12");
	});
	it('does not write if the preview closes during the approval read', async () => {
		const { app, plugin, file } = setup();
		const text = await app.vault.read(file); const policy = { retainNegativeNumbers: false };
		const controller = new AbortController();
		vi.spyOn(plugin, 'readSource').mockImplementation(async () => { controller.abort(); return text; });
		await expect(plugin.writeCopy({ file: file as never, text, policy, audit: auditCsv(text, policy) }, controller.signal).then(() => 'created')).rejects.toThrow('cancelled');
		expect(app.vault.getFiles()).toHaveLength(2);
	});
	it('rejects an oversized combined report before creating a file', async () => {
		pro(true); const { app, plugin, file } = setup('é'.repeat(4096) + '\n' + Array(3000).fill('=1').join('\n'));
		const report = await plugin.auditBatch([file as never]);
		await expect(plugin.writeReport(report).then(() => 'created')).rejects.toThrow('report is over 20 MiB');
		expect(app.vault.getFiles()).toHaveLength(2);
	});
	it('rejects oversized files before reading', async () => {
		const { app, plugin, file } = setup(); file.stat.size = 1048577;
		const read = vi.spyOn(app.vault, 'read');
		await expect(plugin.readSource(file as never)).rejects.toThrow('over 1 MiB');
		expect(read).not.toHaveBeenCalled();
	});
	it('invalid CSV preview does not write a file', async () => {
		const { app, plugin, file } = setup('a,b\nx');
		await plugin.preview(file as never);
		expect(app.vault.getFiles()).toHaveLength(2);
		expect(document.querySelector('.csv-shield-modal')).toBeNull();
	});
	it('free mode denies policy save and batch audit and ignores saved policies', async () => {
		const { app, plugin, file } = setup();
		plugin.settings.policies['data.csv'] = { retainNegativeNumbers: true };
		expect(plugin.policy('data.csv').retainNegativeNumbers).toBe(false);
		expect(await plugin.savePolicy('other.csv', { retainNegativeNumbers: true })).toBe(false);
		expect(await plugin.auditBatch([file as never])).toEqual([]);
		expect(await plugin.writeReport([])).toBeNull();
		expect(app.vault.getFiles()).toHaveLength(2);
	});
	it('Pro saves and reloads policies through plugin data', async () => {
		pro(true); const { plugin } = setup();
		expect(await plugin.savePolicy('data.csv', { retainNegativeNumbers: true })).toBe(true);
		await plugin.loadSettings();
		expect(plugin.policy('data.csv').retainNegativeNumbers).toBe(true);
		resetPro();
		expect(plugin.policy('data.csv').retainNegativeNumbers).toBe(false);
	});
	it('keeps 200 source policies and rejects a new path at the limit', async () => {
		pro(true); const { plugin } = setup();
		for (let n = 0; n < 200; n++) await plugin.savePolicy(`${n}.csv`, { retainNegativeNumbers: true });
		await expect(plugin.savePolicy('overflow.csv', { retainNegativeNumbers: true })).rejects.toThrow('limit is 200');
		expect(await plugin.savePolicy('0.csv', { retainNegativeNumbers: false })).toBe(true);
		await plugin.loadSettings();
		expect(Object.keys(plugin.settings.policies)).toHaveLength(200);
		expect(plugin.policy('0.csv').retainNegativeNumbers).toBe(false);
	});
	it('Pro audit includes file errors and needs a separate report write', async () => {
		pro(true); const { app, plugin, file } = setup();
		const bad = await app.vault.create('bad.csv', 'a,b\nx');
		const report = await plugin.auditBatch([file as never, bad as never]);
		expect(report[0]?.findings).toHaveLength(1);
		expect(report[1]?.error).toContain('Row-width');
		expect(app.vault.getFiles()).toHaveLength(3);
		const output = await plugin.writeReport(report);
		expect(JSON.parse(await app.vault.read(output! as never)).files).toEqual(report);
		const next = await plugin.writeReport(report);
		expect(next?.path).toBe('CSV Formula Shield audit 2.json');
		resetPro(); expect(await plugin.writeReport(report)).toBeNull();
	});
	it('caps batch selection and stops writes after unload', async () => {
		pro(true); const { plugin, file } = setup();
		await expect(plugin.auditBatch([])).rejects.toThrow('1 to 20');
		await expect(plugin.auditBatch(Array(21).fill(file) as never)).rejects.toThrow('1 to 20');
		plugin.onunload();
		expect(await plugin.writeReport([])).toBeNull();
	});
	it('pins the required GitHub Sponsors values', () => {
		expect(SPONSORS).toEqual({ clientId: 'Ov23lic5UPGPZqhBlBGg', sponsorLogin: 'theluckystrike', minMonthlyUsd: 5, oneTimeUsd: 15, oneTimeMonths: 0, scope: 'read:user' });
	});
});
