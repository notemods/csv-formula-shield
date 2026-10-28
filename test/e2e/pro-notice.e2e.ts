import { browser, expect } from '@wdio/globals';
import { pluginId } from './load';

// A free user runs the Pro command "Audit chosen CSV files (Pro)". The shared Pro notice must show, with a
// Sponsor on GitHub button that opens the Sponsors page with metadata_source=<plugin id>. No audit dialog opens.
const LEAD = 'Combined audit reports and saved export policies are Pro features.';
const PITCH = 'Sponsor on GitHub, then sign in from the plugin settings.';

interface Shown { text: string; buttons: number }
async function notices(): Promise<Shown[]> {
	return browser.execute(() => [...(window as unknown as { activeWindow: Window }).activeWindow.document.querySelectorAll('.notice')].map((n) => ({ text: n.textContent ?? '', buttons: n.querySelectorAll('.pf-pro-notice-sponsor').length })));
}

describe(`${pluginId} Pro notice`, function () {
	it('shows the Sponsor on GitHub button when a free user runs the Pro audit command', async function () {
		await browser.executeObsidian(({ app }, id) => {
			(app as unknown as { plugins: { plugins: Record<string, { pro: { signOut(): void } }> } }).plugins.plugins[id]!.pro.signOut();
			for (const doc of new Set([document, (window as unknown as { activeWindow: Window }).activeWindow.document])) doc.querySelectorAll('.notice').forEach((n) => n.remove());
		}, pluginId);
		await browser.executeObsidianCommand(`${pluginId}:audit-several`);
		await browser.waitUntil(async () => (await notices()).some((n) => n.text.includes(LEAD)), { timeout: 5000 }).catch(async () => {
			throw new Error(`No Pro notice after the audit command: ${JSON.stringify(await notices())}`);
		});
		const shown = (await notices()).filter((n) => n.text.includes(LEAD));
		expect(shown).toHaveLength(1);
		expect(shown[0]!.text).toContain(`${LEAD} ${PITCH}`);
		expect(shown[0]!.buttons).toBe(1);
		const url = await browser.execute(() => {
			const w = window as unknown as { open: (u?: string) => unknown; activeWindow: Window };
			const original = w.open;
			let opened = '';
			w.open = (u?: string) => { opened = u ?? ''; return null; };
			try { (w.activeWindow.document.querySelector('.notice .pf-pro-notice-sponsor') as HTMLElement).click(); } finally { w.open = original; }
			return opened;
		});
		expect(url).toBe(`https://github.com/sponsors/theluckystrike?metadata_source=${pluginId}`);
		// The free user gets no audit dialog.
		expect(await browser.execute(() => document.querySelector('.csv-shield-modal'))).toBeNull();
	});
});
