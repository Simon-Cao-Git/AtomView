import * as vscode from 'vscode';

type Vec3 = [number, number, number];

type SourceFormat = 'POSCAR' | 'CONTCAR' | 'VASP' | 'XDATCAR';

interface Atom {
	element: string;
	position: Vec3; // Cartesian coordinates in Angstrom
	fractionalPosition?: Vec3;
	selectiveDynamics?: [boolean, boolean, boolean];
}

interface TrajectoryFrame {
	index: number;
	atoms: Atom[];
	coordinateMode: 'Direct' | 'Cartesian';
}

interface AtomicStructure {
	title: string;
	lattice: [Vec3, Vec3, Vec3];
	atoms: Atom[];
	coordinateMode: 'Direct' | 'Cartesian';
	sourceFormat: SourceFormat;
	frames?: TrajectoryFrame[];
}

interface ParsedPoscarBlock {
	structure: AtomicStructure;
	nextLineIndex: number;
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('atomview.openPreview', (resource?: vscode.Uri) => {
			AtomViewPanel.createOrShow(context.extensionUri, resource);
		})
	);
}

export function deactivate() {}

function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
	return {
		enableScripts: true,
		localResourceRoots: [
			vscode.Uri.joinPath(extensionUri, 'media'),
			vscode.Uri.joinPath(extensionUri, 'node_modules')
		]
	};
}

class AtomViewPanel {
	public static currentPanel: AtomViewPanel | undefined;
	public static readonly viewType = 'atomview.preview';

	private sourceDocumentUri: vscode.Uri | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private disposables: vscode.Disposable[] = [];

	public static createOrShow(extensionUri: vscode.Uri, sourceUri?: vscode.Uri) {
		const column = vscode.ViewColumn.Beside;

		if (AtomViewPanel.currentPanel) {
			AtomViewPanel.currentPanel.panel.reveal(column);
			AtomViewPanel.currentPanel.updateFromSourceDocument();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			AtomViewPanel.viewType,
			'AtomView',
			column,
			{
				...getWebviewOptions(extensionUri),
				retainContextWhenHidden: true
			}
		);

		AtomViewPanel.currentPanel = new AtomViewPanel(panel, extensionUri, sourceUri);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, sourceUri?: vscode.Uri) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.sourceDocumentUri =
			sourceUri ?? vscode.window.activeTextEditor?.document.uri;

		this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);
		this.updateFromSourceDocument();

		this.panel.onDidDispose(
			() => this.dispose(),
			null,
			this.disposables
		);

		vscode.workspace.onDidChangeTextDocument(
			(event) => {
				if (
					this.sourceDocumentUri &&
					event.document.uri.toString() === this.sourceDocumentUri.toString()
				) {
					this.updateFromDocument(event.document);
				}
			},
			null,
			this.disposables
		);

		this.panel.onDidChangeViewState(
			() => {
				if (this.panel.visible) {
					this.updateFromSourceDocument();
				}
			},
			null,
			this.disposables
		);
	}

	private async updateFromSourceDocument() {
		const document = this.sourceDocumentUri
			? await vscode.workspace.openTextDocument(this.sourceDocumentUri)
			: undefined;

		if (!document) {
			this.postStatus(
				'Open a POSCAR, CONTCAR, XDATCAR, or .vasp file to preview it.'
			);
			return;
		}

		this.updateFromDocument(document);
	}

	private updateFromDocument(document: vscode.TextDocument) {
		const fileName = document.fileName.split(/[\\/]/).pop() ?? '';
		const normalizedFileName = fileName.toUpperCase();

		const isSupportedFile =
			normalizedFileName === 'POSCAR' ||
			normalizedFileName === 'CONTCAR' ||
			normalizedFileName === 'XDATCAR' ||
			normalizedFileName.endsWith('.VASP');

		if (!isSupportedFile) {
			this.postStatus(
				`Source file is ${fileName}. Open POSCAR, CONTCAR, XDATCAR, or a .vasp file to preview a structure.`
			);
			return;
		}

		try {
			const sourceFormat: SourceFormat =
				normalizedFileName === 'POSCAR'
					? 'POSCAR'
					: normalizedFileName === 'CONTCAR'
						? 'CONTCAR'
						: normalizedFileName === 'XDATCAR'
							? 'XDATCAR'
							: 'VASP';

			const structure = parseStructureFile(
				document.getText(),
				sourceFormat
			);

			this.panel.title = `AtomView: ${fileName}`;

			this.panel.webview.postMessage({
				command: 'showStructure',
				structure
			});
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: String(error);

			this.postStatus(
				`Failed to parse ${fileName}: ${message}`
			);
		}
	}

	private postStatus(text: string) {
		this.panel.webview.postMessage({
			command: 'showStatus',
			text
		});
	}

	private dispose() {
		AtomViewPanel.currentPanel = undefined;

		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtmlForWebview(webview: vscode.Webview) {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(
				this.extensionUri,
				'media',
				'main.js'
			)
		);

		const threeUri = webview.asWebviewUri(
			vscode.Uri.joinPath(
				this.extensionUri,
				'node_modules',
				'three',
				'build',
				'three.module.js'
			)
		);

		const threeAddonsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(
				this.extensionUri,
				'node_modules',
				'three',
				'examples',
				'jsm'
			)
		);

		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">

	<meta
		http-equiv="Content-Security-Policy"
		content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline';"
	>

	<meta
		name="viewport"
		content="width=device-width, initial-scale=1.0"
	>

	<title>AtomView</title>

	<style>
		body {
			margin: 0;
			padding: 16px;
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
		}

		pre {
			white-space: pre-wrap;
		}
	</style>
</head>

<body>
	<h1>AtomView</h1>

	<pre id="output">
~AtomView: Open Preview~
	</pre>

	<script type="importmap" nonce="${nonce}">
	{
		"imports": {
			"three": "${threeUri}",
			"three/addons/": "${threeAddonsUri}/"
		}
	}
	</script>

	<script
		type="module"
		nonce="${nonce}"
		src="${scriptUri}"
	></script>
</body>
</html>`;
	}
}

function parseStructureFile(
	text: string,
	sourceFormat: SourceFormat
): AtomicStructure {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	if (looksLikeXdatcar(lines)) {
		return parseXdatcar(lines, sourceFormat);
	}

	const structures = parseStackedPoscars(lines, sourceFormat);

	if (structures.length === 0) {
		throw new Error('No valid POSCAR/CONTCAR structure block was found.');
	}

	if (structures.length === 1) {
		return structures[0];
	}

	const firstStructure = structures[0];

	const frames: TrajectoryFrame[] = structures.map((structure, index) => ({
		index: index + 1,
		atoms: structure.atoms,
		coordinateMode: structure.coordinateMode
	}));

	return {
		...firstStructure,
		sourceFormat,
		atoms: frames[0].atoms,
		coordinateMode: frames[0].coordinateMode,
		frames
	};
}

function looksLikeXdatcar(lines: string[]): boolean {
	return lines.some((line) => /^direct\s+configuration\s*=/i.test(line));
}

function parseXdatcar(
	lines: string[],
	sourceFormat: SourceFormat
): AtomicStructure {
	if (lines.length < 8) {
		throw new Error('File is too short to be a valid XDATCAR.');
	}

	const title = lines[0];
	const scale = parseFloat(lines[1]);

	if (!Number.isFinite(scale)) {
		throw new Error('Invalid XDATCAR scaling factor.');
	}

	const rawLattice = [
		parseVector(lines[2]),
		parseVector(lines[3]),
		parseVector(lines[4])
	] as [Vec3, Vec3, Vec3];

	const lattice = rawLattice.map((vector) =>
		scaleVector(vector, scale)
	) as [Vec3, Vec3, Vec3];

	const elementSymbols = lines[5].split(/\s+/);

	const elementCounts = lines[6]
		.split(/\s+/)
		.map((value) => parseInt(value, 10));

	validateElementList(elementSymbols, elementCounts);

	const totalAtoms = elementCounts.reduce((sum, count) => sum + count, 0);
	const expandedElements = expandElementSymbols(elementSymbols, elementCounts);

	const frames: TrajectoryFrame[] = [];
	let lineIndex = 7;

	while (lineIndex < lines.length) {
		const header = lines[lineIndex];
		const match = header.match(/^direct\s+configuration\s*=\s*(\d+)/i);

		if (!match) {
			lineIndex += 1;
			continue;
		}

		const frameIndex = parseInt(match[1], 10);
		const firstAtomLineIndex = lineIndex + 1;

		if (lines.length < firstAtomLineIndex + totalAtoms) {
			break;
		}

		const atoms: Atom[] = [];

		for (let i = 0; i < totalAtoms; i++) {
			const atomLine = lines[firstAtomLineIndex + i];
			const fractionalPosition = parseVector(atomLine);
			const element = expandedElements[i];

			atoms.push({
				element,
				fractionalPosition,
				position: fractionalToCartesian(fractionalPosition, lattice)
			});
		}

		frames.push({
			index: frameIndex,
			atoms,
			coordinateMode: 'Direct'
		});

		lineIndex = firstAtomLineIndex + totalAtoms;
	}

	if (frames.length === 0) {
		throw new Error('No XDATCAR configuration frames were found.');
	}

	return {
		title,
		lattice,
		atoms: frames[0].atoms,
		coordinateMode: 'Direct',
		sourceFormat: sourceFormat === 'VASP' ? 'VASP' : 'XDATCAR',
		frames
	};
}

function parseStackedPoscars(
	lines: string[],
	sourceFormat: SourceFormat
): AtomicStructure[] {
	const structures: AtomicStructure[] = [];
	let lineIndex = 0;

	while (lineIndex < lines.length) {
		const parsedBlock = tryParsePoscarBlock(lines, lineIndex, sourceFormat);

		if (parsedBlock) {
			structures.push(parsedBlock.structure);
			lineIndex = parsedBlock.nextLineIndex;
			continue;
		}

		lineIndex += 1;
	}

	return structures;
}

function tryParsePoscarBlock(
	lines: string[],
	startLineIndex: number,
	sourceFormat: SourceFormat
): ParsedPoscarBlock | undefined {
	if (lines.length - startLineIndex < 8) {
		return undefined;
	}

	const scale = parseFloat(lines[startLineIndex + 1]);

	if (!Number.isFinite(scale)) {
		return undefined;
	}

	try {
		parseVector(lines[startLineIndex + 2]);
		parseVector(lines[startLineIndex + 3]);
		parseVector(lines[startLineIndex + 4]);
	} catch {
		return undefined;
	}

	const elementSymbols = lines[startLineIndex + 5].split(/\s+/);

	const elementCounts = lines[startLineIndex + 6]
		.split(/\s+/)
		.map((value) => parseInt(value, 10));

	try {
		validateElementList(elementSymbols, elementCounts);
	} catch {
		return undefined;
	}

	let coordinateLineIndex = startLineIndex + 7;
	let coordinateModeLine = lines[coordinateLineIndex]?.toLowerCase() ?? '';

	if (coordinateModeLine.startsWith('s')) {
		coordinateLineIndex += 1;
		coordinateModeLine = lines[coordinateLineIndex]?.toLowerCase() ?? '';
	}

	if (
		!coordinateModeLine.startsWith('d') &&
		!coordinateModeLine.startsWith('c') &&
		!coordinateModeLine.startsWith('k')
	) {
		return undefined;
	}

	const totalAtoms = elementCounts.reduce((sum, count) => sum + count, 0);
	const firstAtomLineIndex = coordinateLineIndex + 1;

	if (lines.length < firstAtomLineIndex + totalAtoms) {
		return undefined;
	}

	for (let i = 0; i < totalAtoms; i++) {
		try {
			parseVector(lines[firstAtomLineIndex + i]);
		} catch {
			return undefined;
		}
	}

	const blockLines = lines.slice(startLineIndex, firstAtomLineIndex + totalAtoms);
	const structure = parseSinglePoscarBlock(blockLines, sourceFormat);

	return {
		structure,
		nextLineIndex: firstAtomLineIndex + totalAtoms
	};
}

function parseSinglePoscarBlock(
	lines: string[],
	sourceFormat: SourceFormat
): AtomicStructure {
	if (lines.length < 8) {
		throw new Error('File is too short to be a valid POSCAR/CONTCAR/.vasp file.');
	}

	const title = lines[0];
	const scale = parseFloat(lines[1]);

	if (!Number.isFinite(scale)) {
		throw new Error('Invalid scaling factor.');
	}

	const rawLattice = [
		parseVector(lines[2]),
		parseVector(lines[3]),
		parseVector(lines[4])
	] as [Vec3, Vec3, Vec3];

	const lattice = rawLattice.map((vector) =>
		scaleVector(vector, scale)
	) as [Vec3, Vec3, Vec3];

	const elementSymbols = lines[5].split(/\s+/);

	const elementCounts = lines[6]
		.split(/\s+/)
		.map((value) => parseInt(value, 10));

	validateElementList(elementSymbols, elementCounts);

	let coordinateLineIndex = 7;
	let hasSelectiveDynamics = false;

	let coordinateModeLine = lines[coordinateLineIndex].toLowerCase();

	if (coordinateModeLine.startsWith('s')) {
		hasSelectiveDynamics = true;
		coordinateLineIndex += 1;
		coordinateModeLine = lines[coordinateLineIndex].toLowerCase();
	}

	const coordinateMode: 'Direct' | 'Cartesian' =
		coordinateModeLine.startsWith('d') ? 'Direct' : 'Cartesian';

	const firstAtomLineIndex = coordinateLineIndex + 1;
	const totalAtoms = elementCounts.reduce((sum, count) => sum + count, 0);

	if (lines.length < firstAtomLineIndex + totalAtoms) {
		throw new Error(`Expected ${totalAtoms} atomic coordinate lines, but found fewer.`);
	}

	const expandedElements = expandElementSymbols(elementSymbols, elementCounts);
	const atoms: Atom[] = [];

	for (let i = 0; i < totalAtoms; i++) {
		const atomLine = lines[firstAtomLineIndex + i];
		const rawPosition = parseVector(atomLine);

		const selectiveDynamics = hasSelectiveDynamics
			? parseSelectiveDynamicsFlags(atomLine)
			: undefined;

		const element = expandedElements[i];

		if (coordinateMode === 'Direct') {
			atoms.push({
				element,
				fractionalPosition: rawPosition,
				selectiveDynamics,
				position: fractionalToCartesian(rawPosition, lattice)
			});
		} else {
			atoms.push({
				element,
				selectiveDynamics,
				position: scaleVector(rawPosition, scale)
			});
		}
	}

	return {
		title,
		lattice,
		atoms,
		coordinateMode,
		sourceFormat
	};
}

function validateElementList(elementSymbols: string[], elementCounts: number[]) {
	if (
		elementSymbols.length !== elementCounts.length ||
		elementCounts.some((count) => !Number.isInteger(count) || count < 0)
	) {
		throw new Error('Invalid element symbols or atom counts.');
	}
}

function expandElementSymbols(elementSymbols: string[], elementCounts: number[]): string[] {
	return elementSymbols.flatMap((symbol, index) =>
		Array(elementCounts[index]).fill(symbol)
	);
}

function parseVector(line: string): Vec3 {
	const values = line
		.split(/\s+/)
		.slice(0, 3)
		.map(Number);

	if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
		throw new Error(`Invalid vector line: ${line}`);
	}

	return [values[0], values[1], values[2]];
}

function parseSelectiveDynamicsFlags(
	line: string
): [boolean, boolean, boolean] | undefined {
	const tokens = line.split(/\s+/).slice(3, 6);

	if (tokens.length < 3) {
		return undefined;
	}

	return [
		tokens[0].toUpperCase().startsWith('T'),
		tokens[1].toUpperCase().startsWith('T'),
		tokens[2].toUpperCase().startsWith('T')
	];
}

function scaleVector(vector: Vec3, scale: number): Vec3 {
	return [
		vector[0] * scale,
		vector[1] * scale,
		vector[2] * scale
	];
}

function fractionalToCartesian(
	fractional: Vec3,
	lattice: [Vec3, Vec3, Vec3]
): Vec3 {
	return [
		fractional[0] * lattice[0][0] +
			fractional[1] * lattice[1][0] +
			fractional[2] * lattice[2][0],

		fractional[0] * lattice[0][1] +
			fractional[1] * lattice[1][1] +
			fractional[2] * lattice[2][1],

		fractional[0] * lattice[0][2] +
			fractional[1] * lattice[1][2] +
			fractional[2] * lattice[2][2]
	];
}

function getNonce() {
	let text = '';

	const possible =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}

	return text;
}