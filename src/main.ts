import { FuzzySuggestModal, Modal, Notice, Plugin, Setting, TFile, normalizePath } from 'obsidian';
import { createGitHubSponsors } from './license/github-obsidian';
import type { SponsorsManager } from './license/index';
import { auditCsv, copyName, MAX_BYTES, PREVIEW_LIMIT, previewText, type Audit, type Policy } from './csv';
import { bindPro, isPro, proNotice, resetPro, SPONSORS } from './pro';
import { DEFAULT_SETTINGS, normalizeSettings, ShieldSettingTab, type ShieldSettings } from './settings';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

// Keep the paid tier name in the same form on commands and dialogs.
function proLabel(text: string): string { return text + ' (Pro)'; }

interface Source { file: TFile; text: string; policy: Policy; audit: Audit }
interface ReportFile { path: string; policy: Policy; findings?: Audit['findings']; error?: string }

/** Bound the report before joining it. A long header can repeat in many findings. */
function reportJson(report: ReportFile[]): string {
	const chunks: string[] = [];
	const encoder = new TextEncoder();
	let bytes = 0;
	const append = (chunk: string): void => {
		bytes += encoder.encode(chunk).byteLength;
		if (bytes > 20 * MAX_BYTES) throw new Error('The report is over 20 MiB. Choose fewer files or shorter headers. No report was written.');
		chunks.push(chunk);
	};
	append('{"format":"CSV Formula Shield audit v1","files":[');
	for (const [index, item] of report.entries()) {
		if (index) append(',');
		append(JSON.stringify({ path: item.path, policy: item.policy, error: item.error }).slice(0, -1));
		if (item.findings) {
			append(',"findings":[');
			for (const [n, finding] of item.findings.entries()) {
				if (n) append(',');
				append(JSON.stringify(finding));
			}
			append(']');
		}
		append('}');
	}
	append(']}');
	return chunks.join('');
}

export default class CsvFormulaShieldPlugin extends Plugin {
	settings: ShieldSettings = normalizeSettings(DEFAULT_SETTINGS);
	pro: SponsorsManager | null = null;
	private dialogs = new Set<Modal>();
	private stopped = false;

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		await this.loadSettings();
		this.pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		this.pro.init();
		bindPro(this.pro);
		const tab = new ShieldSettingTab(this);
		this.addSettingTab(tab);
		this.register(this.pro.onChange(() => tab.update()));
		this.addCommand({ id: 'audit-csv', name: 'Check a CSV and preview an escaped copy', callback: () => this.chooseCsv() });
		this.addCommand({ id: 'audit-several', name: proLabel('Audit chosen CSV files'), callback: () => this.chooseBatch() });
		this.app.workspace.onLayoutReady(() => {
			if (this.stopped) return;
			void this.pro?.refresh();
			this.registerInterval(window.setInterval(() => void this.pro?.refresh(), 6 * 60 * 60 * 1000));
		});
	}

	onunload(): void {
		this.stopped = true;
		for (const dialog of this.dialogs) dialog.close();
		this.dialogs.clear();
		resetPro();
	}

	async loadSettings(): Promise<void> { this.settings = normalizeSettings(await this.loadData()); }
	async saveSettings(): Promise<void> { await this.saveData(this.settings); }
	files(): TFile[] { return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'csv').sort((a, b) => a.path.localeCompare(b.path)); }
	policy(path: string): Policy {
		return { retainNegativeNumbers: (isPro() ? this.settings.policies[path]?.retainNegativeNumbers : undefined) ?? this.settings.retainNegativeNumbers };
	}
	show(dialog: Modal): void { this.dialogs.add(dialog); dialog.open(); }
	forget(dialog: Modal): void { this.dialogs.delete(dialog); }
	needsPro(): boolean {
		if (isPro()) return true;
		proNotice('Combined audit reports and saved export policies are Pro features.');
		return false;
	}
	chooseCsv(): void {
		if (!this.files().length) { new Notice('Add a comma-separated UTF-8 CSV to this vault first.'); return; }
		this.show(new CsvPicker(this));
	}
	async readSource(file: TFile): Promise<string> {
		if (file.extension.toLowerCase() !== 'csv') throw new Error('Choose a CSV file.');
		if (file.stat.size > MAX_BYTES) throw new Error('The source is over 1 MiB. No copy was written.');
		return this.app.vault.read(file);
	}
	async preview(file: TFile): Promise<void> {
		try {
			const text = await this.readSource(file);
			const policy = this.policy(file.path);
			const source = { file, text, policy, audit: auditCsv(text, policy) };
			if (!this.stopped) this.show(new PreviewModal(this, source));
		} catch (e) { this.error(e); }
	}
	async savePolicy(path: string, policy: Policy): Promise<boolean> {
		if (!this.needsPro()) return false;
		if (!(path in this.settings.policies) && Object.keys(this.settings.policies).length >= 200) throw new Error('The saved policy limit is 200 source files.');
		this.settings.policies[path] = { ...policy };
		await this.saveSettings();
		return true;
	}
	/** The preview calls this only from its approval button. Re-read before the new write. */
	async writeCopy(source: Source, signal?: AbortSignal): Promise<TFile> {
		if (this.stopped) throw new Error('The plugin is closed.');
		if (signal?.aborted) throw new Error('The copy was cancelled.');
		const policy = { ...source.policy };
		const current = await this.readSource(source.file);
		if (this.stopped) throw new Error('The plugin is closed.');
		if (signal?.aborted) throw new Error('The copy was cancelled.');
		if (current !== source.text) throw new Error('The source changed. Cancel and check the CSV again.');
		const output = auditCsv(source.text, policy).output;
		const path = copyName(normalizePath(source.file.path), (p) => this.app.vault.getAbstractFileByPath(normalizePath(p)) !== null);
		return this.app.vault.create(normalizePath(path), output);
	}
	chooseBatch(): void {
		if (this.needsPro()) this.show(new BatchModal(this));
	}
	async auditBatch(files: TFile[]): Promise<ReportFile[]> {
		if (!this.needsPro()) return [];
		if (!files.length || files.length > 20) throw new Error('Choose 1 to 20 CSV files.');
		const report: ReportFile[] = [];
		for (const file of files) {
			const policy = this.policy(file.path);
			try { report.push({ path: file.path, policy, findings: auditCsv(await this.readSource(file), policy).findings }); }
			catch (e) { report.push({ path: file.path, policy, error: e instanceof Error ? e.message : String(e) }); }
		}
		return report;
	}
	async writeReport(report: ReportFile[]): Promise<TFile | null> {
		if (!this.needsPro() || this.stopped) return null;
		let n = 1;
		let path = 'CSV Formula Shield audit.json';
		while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`CSV Formula Shield audit ${++n}.json`);
		return this.app.vault.create(path, reportJson(report));
	}
	error(e: unknown): void { new Notice(e instanceof Error ? e.message : String(e), 10000); }
}

class CsvPicker extends FuzzySuggestModal<TFile> {
	constructor(private owner: CsvFormulaShieldPlugin) { super(owner.app); this.setPlaceholder('Choose a CSV in this vault'); }
	getItems(): TFile[] { return this.owner.files(); }
	getItemText(file: TFile): string { return file.path; }
	onChooseItem(file: TFile): void { void this.owner.preview(file); }
	onClose(): void { this.owner.forget(this); }
}

class PreviewModal extends Modal {
	private busy = false;
	private writeController = new AbortController();
	constructor(private owner: CsvFormulaShieldPlugin, private source: Source) { super(owner.app); }
	onOpen(): void { this.modalEl.classList.add('csv-shield-modal'); this.draw(); }
	private draw(): void {
		const { contentEl: el } = this;
		el.empty();
		this.setTitle('CSV formula preview');
		el.createEl('p', { text: this.source.file.path, cls: 'csv-shield-source' });
		if (isPro() && this.owner.settings.policies[this.source.file.path]) el.createEl('p', { text: 'Saved source policy loaded. You can change the choice for this copy.', cls: 'csv-shield-source' });
		el.createEl('p', { text: 'Escaping changes cell text. Spreadsheet behavior differs. Check the copy before you share it.', cls: 'csv-shield-warning' });
		new Setting(el).setName('Retain strict negative numbers').setDesc('On keeps -12, -0.5 and -2e3. Off escapes them. Expressions such as -1+2 stay selected.').addToggle((t) => t.setValue(this.source.policy.retainNegativeNumbers).setDisabled(this.busy).onChange((value) => {
			if (this.busy) return;
			this.source.policy = { retainNegativeNumbers: value };
			this.source.audit = auditCsv(this.source.text, this.source.policy);
			this.draw();
		}));
		const { audit } = this.source;
		el.createEl('p', { text: `${audit.rows.length} logical rows · ${audit.rows[0]?.length ?? 0} columns · ${audit.findings.length} selected cells`, cls: 'csv-shield-count' });
		el.createEl('p', { text: `New file: ${copyName(this.source.file.path, (p) => this.app.vault.getAbstractFileByPath(normalizePath(p)) !== null)}` });
		const wrap = el.createDiv({ cls: 'csv-shield-table-wrap' });
		const table = wrap.createEl('table', { cls: 'csv-shield-table' });
		const head = table.createEl('thead').createEl('tr');
		for (const name of ['Row', 'Column / header', 'Before', 'After']) head.createEl('th', { text: name });
		const body = table.createEl('tbody');
		for (const entry of audit.findings.slice(0, PREVIEW_LIMIT)) {
			const row = body.createEl('tr');
			row.createEl('td', { text: String(entry.row) });
			row.createEl('td', { text: `${entry.column} / ${previewText(entry.header)}` });
			row.createEl('td').createEl('code', { text: previewText(entry.before) });
			row.createEl('td').createEl('code', { text: previewText(entry.after) });
		}
		if (!audit.findings.length) el.createEl('p', { text: 'No selected formula prefixes. You can still write a quoted copy.' });
		if (audit.findings.length > PREVIEW_LIMIT) el.createEl('p', { text: 'Only the first 200 entries are shown. The copy applies the rule to the full file.' });
		new Setting(el).setName(proLabel('Saved export policy')).setDesc('Save this choice for this source path. The saved policy applies while paid features are active.').addButton((b) => b.setButtonText('Save policy').onClick(async () => {
			try { if (await this.owner.savePolicy(this.source.file.path, this.source.policy)) new Notice('Export policy saved.'); } catch (e) { this.owner.error(e); }
		}));
		new Setting(el).addButton((b) => b.setButtonText('Cancel').onClick(() => this.close())).addButton((b) => b.setButtonText('Approve and write copy').setCta().setDisabled(this.busy).onClick(async () => {
			if (this.busy) return;
			this.busy = true;
			this.draw();
			try { const file = await this.owner.writeCopy(this.source, this.writeController.signal); new Notice(`Created ${file.path}. Source kept.`); this.close(); }
			catch (e) { if (!this.writeController.signal.aborted) { this.owner.error(e); this.busy = false; this.draw(); } }
		}));
	}
	onClose(): void { this.writeController.abort(); this.owner.forget(this); this.contentEl.empty(); }
}

class BatchModal extends Modal {
	private selected = new Set<TFile>();
	constructor(private owner: CsvFormulaShieldPlugin) { super(owner.app); }
	onOpen(): void {
		this.modalEl.classList.add('csv-shield-modal');
		this.setTitle(proLabel('Combined CSV audit'));
		const el = this.contentEl;
		el.createEl('p', { text: 'Choose up to 20 vault CSV files. This makes a local JSON report, with no CSV export.' });
		const list = el.createDiv({ cls: 'csv-shield-table-wrap' });
		const files = this.owner.files();
		if (!files.length) list.createEl('p', { text: 'No CSV files found in this vault.' });
		for (const file of files) new Setting(list).setName(file.path).addToggle((t) => t.onChange((on) => { if (on) this.selected.add(file); else this.selected.delete(file); }));
		new Setting(el).addButton((b) => b.setButtonText('Cancel').onClick(() => this.close())).addButton((b) => b.setButtonText('Audit selected files').setCta().onClick(async () => {
			b.setDisabled(true);
			try {
				const report = await this.owner.auditBatch([...this.selected]);
				if (!report.length || !this.containerEl.isConnected) return;
				el.empty();
				this.setTitle(proLabel('Audit report preview'));
				for (const item of report) el.createEl('p', { text: `${item.path}: ${item.error ?? `${item.findings?.length ?? 0} affected cells`}` });
				new Setting(el).addButton((button) => button.setButtonText('Cancel').onClick(() => this.close())).addButton((button) => button.setButtonText('Write combined report').setCta().onClick(async () => {
					button.setDisabled(true);
					try { const file = await this.owner.writeReport(report); if (file) { new Notice(`Created ${file.path}.`); this.close(); } else button.setDisabled(false); }
					catch (e) { this.owner.error(e); button.setDisabled(false); }
				}));
			} catch (e) { this.owner.error(e); b.setDisabled(false); }
		}));
	}
	onClose(): void { this.owner.forget(this); this.contentEl.empty(); }
}
