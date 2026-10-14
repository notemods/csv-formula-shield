import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { pluginId } from './load';

interface Shield {
	preview(file: unknown): Promise<void>;
	settings: { retainNegativeNumbers: boolean; policies: Record<string, { retainNegativeNumbers: boolean }> };
	loadSettings(): Promise<void>;
	pro: { opts: { http: unknown }; refreshNow(): Promise<void>; signOut(): void };
}
const SOURCE = 'Shield sample.csv';
const TEXT = '=name,value\nAda,=1+1\nBea,-12\nCy,-1+2\n"a,b","line one\nline two"';

async function setPro(on: boolean): Promise<void> {
	await browser.executeObsidian(async ({ app }, id, value) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, Shield> } }).plugins.plugins[id];
		if (!value) { p.pro.signOut(); return; }
		p.pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
		app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36));
		await p.pro.refreshNow();
	}, pluginId, on);
}
async function button(text: string): Promise<void> {
	await browser.waitUntil(async () => browser.execute((label) => Array.from(document.querySelectorAll('.csv-shield-modal button')).some((b) => b.textContent === label), text), { timeout: 10000, timeoutMsg: `Missing ${text}` });
	await browser.execute((label) => (Array.from(document.querySelectorAll('.csv-shield-modal button')).find((b) => b.textContent === label) as HTMLButtonElement).click(), text);
}
async function openPreview(path = SOURCE): Promise<void> {
	await browser.executeObsidian(async ({ app }, id, path) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, Shield> } }).plugins.plugins[id];
		await p.preview(app.vault.getFileByPath(path));
	}, pluginId, path);
	await browser.waitUntil(async () => browser.execute(() => document.querySelector('.csv-shield-table tbody') !== null), { timeout: 10000, timeoutMsg: 'Preview did not open' });
}
async function count(): Promise<number> { return browser.execute(() => document.querySelectorAll('.csv-shield-table tbody tr').length); }
async function exists(path: string): Promise<boolean> { return browser.executeObsidian(({ app }, path) => app.vault.getAbstractFileByPath(path) !== null, path); }
async function write(path: string, text: string): Promise<void> {
	await obsidianPage.write(path, text);
	await browser.waitUntil(() => exists(path), { timeout: 10000, timeoutMsg: `File not ready ${path}` });
}

describe('CSV checks and local writes', () => {
	before(async () => { await write(SOURCE, TEXT); });
	beforeEach(async () => {
		await setPro(false);
		await browser.executeObsidian(({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, Shield> } }).plugins.plugins[id];
			p.settings.retainNegativeNumbers = false;
		}, pluginId);
	});
	it('chooses a CSV through the command and cancels without a write', async () => {
		await browser.executeObsidianCommand(`${pluginId}:audit-csv`);
		const input = browser.$('.prompt-input'); await input.waitForExist(); await input.setValue(SOURCE);
		await browser.waitUntil(async () => browser.execute((name) => Array.from(document.querySelectorAll('.suggestion-item')).some((e) => e.textContent === name), SOURCE), { timeout: 10000 });
		await browser.execute((name) => (Array.from(document.querySelectorAll('.suggestion-item')).find((e) => e.textContent === name) as HTMLElement).click(), SOURCE);
		await browser.waitUntil(async () => (await count()) === 4, { timeout: 10000 });
		expect(await browser.execute(() => document.querySelector('.csv-shield-table')?.textContent)).toContain('=name');
		await button('Cancel');
		expect(await exists('Shield sample.escaped.csv')).toBe(false);
		expect(await obsidianPage.read(SOURCE)).toBe(TEXT);
	});
	it('changes the numeric policy and writes the approved copy with quoted fields', async () => {
		await openPreview(); expect(await count()).toBe(4);
		await browser.execute(() => (document.querySelector('.csv-shield-modal .checkbox-container') as HTMLElement).click());
		await browser.waitUntil(async () => (await count()) === 3, { timeout: 10000 });
		await button('Approve and write copy');
		await browser.waitUntil(() => exists('Shield sample.escaped.csv'), { timeout: 10000 });
		const text = await obsidianPage.read('Shield sample.escaped.csv');
		expect(text).toContain('"\'=name","value"');
		expect(text).toContain('"Bea","-12"');
		expect(text).toContain('"Cy","\'-1+2"');
		expect(text).toContain('"a,b","line one\nline two"');
		expect(await obsidianPage.read(SOURCE)).toBe(TEXT);
	});
	it('cancels approval while the source read is pending', async () => {
		const path = 'Cancelled approval.csv';
		await write(path, TEXT);
		await openPreview(path);
		await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, { readSource(file: unknown): Promise<string> }> } }).plugins.plugins[id];
			const original = p.readSource;
			let resume: (() => void) | undefined;
			let pending: Promise<string> | undefined;
			p.readSource = (file) => {
				pending = new Promise<void>((r) => { resume = r; }).then(() => original.call(p, file));
				return pending;
			};
			try {
				const click = (text: string) => (Array.from(document.querySelectorAll('.csv-shield-modal button')).find((b) => b.textContent === text) as HTMLButtonElement).click();
				click('Approve and write copy');
				click('Cancel');
				resume!();
				await pending;
				await new Promise((r) => setTimeout(r, 100));
			} finally { p.readSource = original; }
		}, pluginId);
		expect(await exists('Cancelled approval.escaped.csv')).toBe(false);
		expect(await obsidianPage.read(path)).toBe(TEXT);
	});
	it('keeps an existing output and uses the next numbered name', async () => {
		const before = await obsidianPage.read('Shield sample.escaped.csv');
		await openPreview(); await button('Approve and write copy');
		await browser.waitUntil(() => exists('Shield sample.escaped 2.csv'), { timeout: 10000 });
		expect(await obsidianPage.read('Shield sample.escaped.csv')).toBe(before);
	});
	it('rejects bad CSV and oversized input without opening a write preview', async () => {
		for (const [path, text] of [['Bad width.csv', 'a,b\nx'], ['Bad quote.csv', 'a,b\nx,"oops'], ['Too large.csv', 'x'.repeat(1048577)]]) {
			await write(path, text);
			await browser.executeObsidian(async ({ app }, id, path) => { const p = (app as unknown as { plugins: { plugins: Record<string, Shield> } }).plugins.plugins[id]; await p.preview(app.vault.getFileByPath(path)); }, pluginId, path);
			expect(await browser.execute(() => document.querySelector('.csv-shield-modal') !== null)).toBe(false);
			expect(await exists(path.replace('.csv', '.escaped.csv'))).toBe(false);
		}
	});
	it('limits the displayed findings but escapes cells beyond the preview', async () => {
		await write('Long.csv', 'value\n' + Array(230).fill('=1').join('\n'));
		await openPreview('Long.csv'); expect(await count()).toBe(200);
		await button('Approve and write copy');
		await browser.waitUntil(() => exists('Long.escaped.csv'), { timeout: 10000 });
		expect((await obsidianPage.read('Long.escaped.csv')).split('\r\n')).toHaveLength(231);
		expect((await obsidianPage.read('Long.escaped.csv')).endsWith('"\'=1"')).toBe(true);
	});
	it('gates policy save then persists a policy with a simulated sponsor answer', async () => {
		await openPreview(); await button('Save policy');
		expect(await browser.executeObsidian(({ app }, id, path) => (app as unknown as { plugins: { plugins: Record<string, Shield> } }).plugins.plugins[id].settings.policies[path] ?? null, pluginId, SOURCE)).toBeNull();
		await button('Cancel'); await setPro(true); await openPreview();
		await browser.execute(() => (document.querySelector('.csv-shield-modal .checkbox-container') as HTMLElement).click());
		await browser.waitUntil(async () => (await count()) === 3, { timeout: 10000 });
		await button('Save policy');
		await browser.waitUntil(async () => browser.executeObsidian(({ app }, id, path) => (app as unknown as { plugins: { plugins: Record<string, Shield> } }).plugins.plugins[id].settings.policies[path]?.retainNegativeNumbers === true, pluginId, SOURCE), { timeout: 10000 });
		await button('Cancel');
		await browser.executeObsidian(async ({ app }, id) => { await (app as unknown as { plugins: { plugins: Record<string, Shield> } }).plugins.plugins[id].loadSettings(); }, pluginId);
		await openPreview(); expect(await count()).toBe(3); await button('Cancel');
		await setPro(false); await openPreview(); expect(await count()).toBe(4); await button('Cancel');
	});
	it('creates a combined report only after separate approval in Pro', async () => {
		await browser.executeObsidianCommand(`${pluginId}:audit-several`);
		expect(await browser.execute(() => document.querySelector('.csv-shield-modal') !== null)).toBe(false);
		await setPro(true); await browser.executeObsidianCommand(`${pluginId}:audit-several`);
		await browser.waitUntil(async () => browser.execute(() => document.querySelector('.csv-shield-modal .checkbox-container') !== null), { timeout: 10000 });
		await browser.execute((paths) => {
			for (const path of paths) {
				const setting = Array.from(document.querySelectorAll('.csv-shield-modal .setting-item')).find((s) => s.querySelector('.setting-item-name')?.textContent === path);
				(setting?.querySelector('.checkbox-container') as HTMLElement).click();
			}
		}, [SOURCE, 'Bad width.csv']);
		await button('Audit selected files');
		await browser.waitUntil(async () => browser.execute(() => document.querySelector('.csv-shield-modal')?.textContent?.includes('Row-width error') ?? false), { timeout: 10000 });
		expect(await exists('CSV Formula Shield audit.json')).toBe(false);
		await button('Write combined report');
		await browser.waitUntil(() => exists('CSV Formula Shield audit.json'), { timeout: 10000 });
		const report = JSON.parse(await obsidianPage.read('CSV Formula Shield audit.json')) as { files: { path: string; findings?: unknown[]; error?: string }[] };
		expect(report.files).toHaveLength(2);
		expect(report.files[0].findings).toHaveLength(3);
		expect(report.files[1].error).toContain('Row-width');
		await setPro(false);
	});
});
