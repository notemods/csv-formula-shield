import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Papa Parse 5.5.3 exposes remote, file, jQuery and worker adapters in its CommonJS
// entry point. This product takes only strings from Vault.read. Remove those
// adapters at build time; keep StringStreamer, ParserHandle, Parser and unparse.
// Fail closed if an upgrade changes a source boundary. The MIT notice is retained.
export function localPapa(source) {
	function cut(start, end, replacement = '') {
		const a = source.indexOf(start);
		const b = source.indexOf(end, a + start.length);
		if (a < 0 || b < 0 || source.indexOf(start, a + start.length) >= 0) throw new Error(`Papa Parse 5.5.3 boundary changed: ${start}`);
		source = source.slice(0, a) + replacement + source.slice(b);
	}
	cut('\tfunction getWorkerBlob()', '\tvar Papa = {};');
	for (const name of ['NetworkStreamer', 'FileStreamer', 'ReadableStreamStreamer']) source = source.replace(`\tPapa.${name} = ${name};`, '');
	source = source.replace('\tPapa.WORKERS_SUPPORTED = !IS_WORKER && !!global.Worker;', '\tPapa.WORKERS_SUPPORTED = false;');
	cut("\tif (typeof PAPA_BROWSER_CONTEXT === 'undefined') {\n\t\tPapa.DuplexStreamStreamer", '\tif (global.jQuery)');
	cut('\tif (global.jQuery)', '\tfunction CsvToJson(_input, _config)');
	cut('\tfunction CsvToJson(_input, _config)', '\tfunction JsonToCsv(_input, _config)', `
	function CsvToJson(_input, _config) {
		if (typeof _input !== 'string') throw new Error('This build accepts CSV text only.');
		_config = _config || {};
		if (_config.download || _config.worker) throw new Error('Remote and worker parsing are disabled.');
		_config.dynamicTyping = false;
		_config.transform = isFunction(_config.transform) ? _config.transform : false;
		return new StringStreamer(_config).stream(_input.replace(/^\\uFEFF/, ''));
	}

`);
	cut('\tfunction NetworkStreamer(config)', '\tfunction StringStreamer(config)');
	cut('\tfunction ReadableStreamStreamer(config)', '\tfunction ParserHandle(_config)');
	cut('\tfunction newWorker()', '\tfunction copy(obj)');
	// ChunkStreamer retains worker-specific branches upstream. Disable them here.
	source = source.replace(/\bIS_PAPA_WORKER\b/g, 'false');
	if (/XMLHttpRequest|require\(['"]stream['"]\)|newWorker|createObjectURL/.test(source)) throw new Error('An unused Papa Parse adapter remains.');
	return source;
}

export const localPapaPlugin = {
	name: 'local-papa-parse',
	setup(build) {
		// Resolve the unminified pinned entry, including browser-platform builds.
		build.onResolve({ filter: /^papaparse$/ }, () => ({ path: require.resolve('papaparse') }));
		build.onLoad({ filter: /[/\\]papaparse[/\\]papaparse\.js$/ }, async ({ path }) => ({ contents: localPapa(await readFile(path, 'utf8')), loader: 'js' }));
	},
};
