import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI } from './pro';
import type CsvFormulaShieldPlugin from './main';
import type { Policy } from './csv';

export interface ShieldSettings extends Policy { policies: Record<string, Policy> }
export const DEFAULT_SETTINGS: ShieldSettings = { retainNegativeNumbers: false, policies: {} };

export function normalizeSettings(saved: unknown): ShieldSettings {
	const s = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
	const policies: Record<string, Policy> = Object.create(null) as Record<string, Policy>;
	if (s.policies && typeof s.policies === 'object') {
		for (const [path, policy] of Object.entries(s.policies as Record<string, unknown>).slice(0, 200)) {
			if (policy && typeof policy === 'object' && 'retainNegativeNumbers' in policy && typeof policy.retainNegativeNumbers === 'boolean') {
				policies[path] = { retainNegativeNumbers: policy.retainNegativeNumbers };
			}
		}
	}
	return { retainNegativeNumbers: s.retainNegativeNumbers === true, policies };
}

export class ShieldSettingTab extends PluginSettingTab {
	constructor(private owner: CsvFormulaShieldPlugin) { super(owner.app, owner); }

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: 'Retain strict negative numbers', desc: 'Default for a new preview. Off escapes -12. On retains decimal numbers such as -12, -0.5 and -2e3.', control: { type: 'toggle', key: 'retainNegativeNumbers', defaultValue: false } },
			...(this.owner.pro ? sponsorsSettingItems(this.owner.pro, PRO_UI) : []),
		];
	}
}
