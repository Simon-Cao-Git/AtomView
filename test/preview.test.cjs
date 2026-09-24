const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const extensionCode = ts.transpileModule(
	fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8'),
	{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText;

function previewHost() {
	const panels = [], documents = new Map(), changes = new Set();
	const uri = (value) => ({ toString: () => value });
	const subscribe = (listeners) => (listener, _, disposables) => {
		listeners.add(listener);
		const disposable = { dispose: () => listeners.delete(listener) };
		disposables?.push(disposable);
		return disposable;
	};
	let openPreview;
	const vscode = {
		Uri: { joinPath: (base, ...parts) => uri(`${base}/${parts.join('/')}`) },
		ViewColumn: { Beside: -2 },
		commands: { registerCommand: (_, callback) => { openPreview = callback; return { dispose() {} }; } },
		workspace: {
			openTextDocument: async (source) => documents.get(source.toString()),
			onDidChangeTextDocument: subscribe(changes)
		},
		window: {
			createWebviewPanel: () => {
				const closed = new Set();
				const panel = {
					visible: true, reveals: [],
					webview: { messages: [], cspSource: 'test', asWebviewUri: (u) => u,
						postMessage(message) { this.messages.push(message); return Promise.resolve(true); } },
					reveal(...args) { this.reveals.push(args); },
					onDidDispose: subscribe(closed),
					onDidChangeViewState: subscribe(new Set()),
					dispose() { for (const listener of closed) listener(); }
				};
				panels.push(panel);
				vscode.window.activeTextEditor = undefined;
				return panel;
			}
		}
	};
	const context = vm.createContext({ exports: {}, require: () => vscode });
	vm.runInContext(extensionCode, context);
	context.exports.activate({ extensionUri: uri('file:///extension'), subscriptions: [] });
	const document = (fileName, scale) => {
		const doc = { fileName, uri: uri(`file://${fileName}`),
			getText: () => `Test\n${scale}\n1 0 0\n0 1 0\n0 0 1\nH\n1\nDirect\n0.5 0.5 0.5\n` };
		documents.set(doc.uri.toString(), doc);
		return doc;
	};
	return { panels, changes, document, uri, vscode,
		open: async (source) => { openPreview(source); await new Promise(setImmediate); } };
}

test('previews stay bound to distinct file URIs and reuse their own panel', async () => {
	const host = previewHost();
	const a = host.document('/a/POSCAR', 1), b = host.document('/b/POSCAR', 2);
	host.vscode.window.activeTextEditor = { document: a };
	await host.open(); // Creating the webview clears activeTextEditor in this mock.
	await host.open(b.uri);
	const [panelA, panelB] = host.panels;
	assert.equal(panelA.webview.messages.at(-1).structure.lattice[0][0], 1);
	assert.equal(panelB.webview.messages.at(-1).structure.lattice[0][0], 2);
	await host.open(host.uri(a.uri.toString()));
	assert.equal(host.panels.length, 2);
	assert.deepEqual(panelA.reveals, [[]]); // Reveal in place, preserving the user's layout.
	assert.equal(panelB.reveals.length, 0);
	const bMessageCount = panelB.webview.messages.length;
	const editedA = host.document('/a/POSCAR', 3);
	for (const listener of host.changes) listener({ document: editedA });
	assert.equal(panelA.webview.messages.at(-1).structure.lattice[0][0], 3);
	assert.equal(panelB.webview.messages.length, bMessageCount);
	panelA.dispose();
	assert.equal(host.changes.size, 1);
	await host.open(b.uri);
	assert.equal(host.panels.length, 2);
	await host.open(a.uri);
	assert.equal(host.panels.length, 3);
	assert.equal(host.panels[2].webview.messages.at(-1).structure.lattice[0][0], 3);
});
