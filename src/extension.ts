import * as vscode from 'vscode';

type Vec3 = [number, number, number];

type SourceFormat =
	| 'POSCAR'
	| 'CONTCAR'
	| 'VASP'
	| 'XDATCAR'
	| 'FDF'
	| 'GJF'
	| 'QE';

type ParserFamily = 'vasp' | 'siesta' | 'gaussian' | 'qe';

interface Atom {
	sourceIndex?: number;
	sourceLabel?: string;
	ghost?: boolean;
	zmatrix?: ZMatrixInfo;
	element: string;
	position: Vec3; // Cartesian coordinates in Angstrom
	fractionalPosition?: Vec3;
	selectiveDynamics?: [boolean, boolean, boolean];
	fdfSpeciesIndex?: number;
	projectedForceConstraints?: Vec3[];
}

interface TrajectoryFrame {
	index: number;
	lattice?: [Vec3, Vec3, Vec3];
	atoms: Atom[];
	coordinateMode: 'Direct' | 'Cartesian';
}

interface AtomicStructure {
	title: string;
	lattice?: [Vec3, Vec3, Vec3];
	atoms: Atom[];
	coordinateMode: 'Direct' | 'Cartesian';
	sourceFormat: SourceFormat;
	frames?: TrajectoryFrame[];
	warning?: string;
}

interface ParsedPoscarBlock {
	structure: AtomicStructure;
	nextLineIndex: number;
}

interface DetectedFormat {
	sourceFormat: SourceFormat;
	parserFamily: ParserFamily;
}

interface FdfLine {
	raw: string;
	clean: string;
	lower: string;
}

type FdfCoordinateFormat =
	| 'Fractional'
	| 'CartesianAngstrom'
	| 'CartesianBohr'
	| 'ScaledCartesian';

type QeCoordinateFormat =
	| 'Crystal'
	| 'CartesianAngstrom'
	| 'CartesianBohr'
	| 'Alat';

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
	private static readonly panels = new Map<string | undefined, AtomViewPanel>();
	public static readonly viewType = 'atomview.preview';

	private readonly sourceDocumentUri: vscode.Uri | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private disposables: vscode.Disposable[] = [];
	private structure: AtomicStructure | undefined;
	private trajectoryId = 0;
	private frameIndex = 0;
	private loadId = 0;
	private ready = false;
	private disposed = false;

	public static createOrShow(extensionUri: vscode.Uri, sourceUri?: vscode.Uri) {
		// Capture the source before creating a webview changes the active editor.
		const documentUri = sourceUri ?? vscode.window.activeTextEditor?.document.uri;
		const sourceKey = documentUri?.toString();
		const existingPanel = AtomViewPanel.panels.get(sourceKey);

		if (existingPanel) {
			existingPanel.panel.reveal();
			existingPanel.updateFromSourceDocument();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			AtomViewPanel.viewType,
			'AtomView',
			vscode.ViewColumn.Beside,
			{
				...getWebviewOptions(extensionUri),
				retainContextWhenHidden: true
			}
		);

		AtomViewPanel.panels.set(sourceKey, new AtomViewPanel(panel, extensionUri, documentUri));
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, sourceUri?: vscode.Uri) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.sourceDocumentUri = sourceUri;

		this.panel.webview.onDidReceiveMessage((message) => {
			if (message.command === 'ready') {
				this.ready = true;
				this.updateFromSourceDocument();
			} else if (
				message.command === 'requestFrame' &&
				message.trajectoryId === this.trajectoryId &&
				Number.isInteger(message.frameIndex) &&
				message.frameIndex >= 0 &&
				message.frameIndex < (this.structure?.frames?.length ?? 0) &&
				Number.isInteger(message.requestId)
			) {
				this.frameIndex = message.frameIndex;
				this.sendFrame('showFrame', message.requestId);
			}
		}, null, this.disposables);
		this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

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
		if (!this.ready || this.disposed) {
			return;
		}
		const uri = this.sourceDocumentUri;
		if (!uri) {
			this.postStatus('Open a POSCAR, CONTCAR, XDATCAR, .vasp, .fdf, .gjf, or .in file to preview it.');
			return;
		}

		const loadId = ++this.loadId;
		try {
			let text: string;
			try {
				// Prefer the document so ordinary files include unsaved edits.
				const document = await vscode.workspace.openTextDocument(uri);
				text = document.getText();
			} catch (error) {
				// VS Code can display large files without exposing them to extensions
				// as TextDocuments. Read their saved contents through the URI provider.
				const stat = await vscode.workspace.fs.stat(uri);
				if (stat.size <= 50 * 1024 * 1024) {
					throw error;
				}
				const bytes = await vscode.workspace.fs.readFile(uri);
				text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
			}
			if (!this.disposed && loadId === this.loadId) {
				this.updateFromText(uri.path, text);
			}
		} catch (error) {
			if (!this.disposed && loadId === this.loadId) {
				this.postStatus(`Failed to load structure: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private updateFromDocument(document: vscode.TextDocument) {
		++this.loadId;
		if (this.ready && !this.disposed) {
			this.updateFromText(document.fileName, document.getText());
		}
	}

	private updateFromText(sourceName: string, text: string) {
		const fileName = sourceName.split(/[\\/]/).pop() ?? '';
		const detectedFormat = detectFormat(fileName, text);
		if (!detectedFormat) {
			this.postStatus(`Source file is ${fileName}. Open a supported atomistic structure/input file to preview it.`);
			return;
		}

		try {
			this.structure = parseStructureFile(text, detectedFormat);
			++this.trajectoryId;
			this.frameIndex = Math.min(this.frameIndex, (this.structure.frames?.length ?? 1) - 1);
			this.panel.title = `AtomView: ${fileName}`;
			this.sendFrame('showStructure');
		} catch (error) {
			this.postStatus(`Failed to parse ${fileName}: ${error instanceof Error ? error.message : String(error)}${this.structure ? "\nShowing the last successfully parsed structure." : ""}`);
		}
	}

	private sendFrame(command: 'showStructure' | 'showFrame', requestId?: number) {
		if (!this.structure || this.disposed) {
			return;
		}
		// Never include the full trajectory in a webview message.
		const { frames, ...base } = this.structure;
		const frame = frames?.[this.frameIndex];
		this.panel.webview.postMessage({
			command,
			trajectoryId: this.trajectoryId,
			requestId,
			frameCount: frames?.length ?? 1,
			frameIndex: this.frameIndex,
			frameNumber: frame?.index ?? 1,
			structure: frame ? {
				...base,
				lattice: frame.lattice ?? base.lattice,
				atoms: frame.atoms,
				coordinateMode: frame.coordinateMode
			} : base
		});
	}

	private postStatus(text: string) {
		this.panel.webview.postMessage({
			command: 'showStatus',
			text
		});
	}

	private dispose() {
		this.disposed = true;
		++this.loadId;
		this.structure = undefined;
		AtomViewPanel.panels.delete(this.sourceDocumentUri?.toString());

		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtmlForWebview(webview: vscode.Webview) {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js')
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

function detectFormat(fileName: string, text: string): DetectedFormat | undefined {
	const lowerFileName = fileName.toLowerCase();
	const baseName = lowerFileName.split(/[\\/]/).pop() ?? lowerFileName;
	const firstChunk = text.slice(0, 12000).toLowerCase();

	if (baseName.includes('xdatcar')) {
		return { sourceFormat: 'XDATCAR', parserFamily: 'vasp' };
	}

	if (baseName.includes('poscar')) {
		return { sourceFormat: 'POSCAR', parserFamily: 'vasp' };
	}

	if (baseName.includes('contcar')) {
		return { sourceFormat: 'CONTCAR', parserFamily: 'vasp' };
	}

	if (lowerFileName.endsWith('.vasp')) {
		return { sourceFormat: 'VASP', parserFamily: 'vasp' };
	}

	if (lowerFileName.endsWith('.fdf')) {
		return { sourceFormat: 'FDF', parserFamily: 'siesta' };
	}

	if (lowerFileName.endsWith('.gjf')) {
		return { sourceFormat: 'GJF', parserFamily: 'gaussian' };
	}

	if (lowerFileName.endsWith('.in')) {
		if (
			firstChunk.includes('atomic_positions') ||
			firstChunk.includes('&control') ||
			firstChunk.includes('&system')
		) {
			return { sourceFormat: 'QE', parserFamily: 'qe' };
		}
	}

	return undefined;
}

function parseStructureFile(
	text: string,
	detectedFormat: DetectedFormat
): AtomicStructure {
	switch (detectedFormat.parserFamily) {
		case 'vasp':
			return parseVaspStructureFile(text, detectedFormat.sourceFormat);

		case 'siesta':
			return parseSiestaFdf(text);

		case 'gaussian':
			return parseGaussianGjf(text);

		case 'qe':
			return parseQuantumEspressoInput(text);
	}
}

/* -------------------------------------------------------------------------- */
/* VASP / POSCAR / CONTCAR / XDATCAR                                          */
/* -------------------------------------------------------------------------- */

function parseVaspStructureFile(
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
		lattice: structure.lattice,
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

// VASP scaling is either one multiplier, a negative target volume, or three
// positive Cartesian component multipliers (not one multiplier per lattice vector).
function parseVaspScale(line: string, lattice: [Vec3, Vec3, Vec3]): Vec3 {
	const values = line.split(/[!#]/)[0].trim().split(/\s+/).map(Number);
	if (
		(values.length !== 1 && values.length !== 3) ||
		values.some((value) => !Number.isFinite(value))
	) {
		throw new Error('VASP scaling line must contain one or three numbers.');
	}

	if (values.length === 3) {
		if (values.some((value) => value <= 0)) {
			throw new Error('The three VASP scaling factors must be positive.');
		}
		return values as Vec3;
	}

	let scale = values[0];
	if (scale < 0) {
		const [a, b, c] = lattice;
		const volume = Math.abs(
			a[0] * (b[1] * c[2] - b[2] * c[1]) -
			a[1] * (b[0] * c[2] - b[2] * c[0]) +
			a[2] * (b[0] * c[1] - b[1] * c[0])
		);
		scale = Math.cbrt(-scale / volume);
		if (!Number.isFinite(scale)) {
			throw new Error('Cannot apply a VASP target volume to this lattice.');
		}
	}

	return [scale, scale, scale];
}

function scaleVaspVector(vector: Vec3, scale: Vec3): Vec3 {
	return [vector[0] * scale[0], vector[1] * scale[1], vector[2] * scale[2]];
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
	const rawLattice = [
		parseVector(lines[2]),
		parseVector(lines[3]),
		parseVector(lines[4])
	] as [Vec3, Vec3, Vec3];

	const scale = parseVaspScale(lines[1], rawLattice);
	const lattice = rawLattice.map((vector) =>
		scaleVaspVector(vector, scale)
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
	const rawLattice = [
		parseVector(lines[2]),
		parseVector(lines[3]),
		parseVector(lines[4])
	] as [Vec3, Vec3, Vec3];

	const scale = parseVaspScale(lines[1], rawLattice);
	const lattice = rawLattice.map((vector) =>
		scaleVaspVector(vector, scale)
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
				position: scaleVaspVector(rawPosition, scale)
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

/* -------------------------------------------------------------------------- */
/* SIESTA FDF                                                                 */
/* -------------------------------------------------------------------------- */

function parseSiestaFdf(text: string): AtomicStructure {
	const lines = preprocessFdfLines(text);

	const hasZmatrix = hasFdfBlock(lines, 'ZMATRIX');

	const title =
		getFdfStringValue(lines, 'SystemName') ??
		getFdfStringValue(lines, 'SystemLabel') ??
		'SIESTA FDF';

	const latticeConstant = parseFdfLatticeConstant(lines);
	const lattice = parseFdfLattice(lines, latticeConstant);
	const speciesMap = parseFdfSpeciesMap(lines);
	const speciesAtomicNumbers = parseFdfSpeciesAtomicNumberMap(lines);
	const coordinateFormat = hasZmatrix ? 'CartesianAngstrom' : parseFdfCoordinateFormat(lines);
	const atoms = hasZmatrix
		? parseSiestaZmatrix(text, lines, lattice, latticeConstant, speciesMap, speciesAtomicNumbers)
		: parseFdfAtoms(
		lines,
		speciesMap,
		lattice,
		latticeConstant,
		coordinateFormat
	);

	if (!hasZmatrix) { applyFdfGeometryConstraints(lines, atoms, speciesAtomicNumbers); }

	if (atoms.length === 0) {
		throw new Error('No atoms found in %block AtomicCoordinatesAndAtomicSpecies.');
	}

	return {
		title,
		lattice,
		atoms,
		coordinateMode: coordinateFormat === 'Fractional' ? 'Direct' : 'Cartesian',
		sourceFormat: 'FDF'
	};
}

function preprocessFdfLines(text: string): FdfLine[] {
	return text
		.split(/\r?\n/)
		.map((raw) => {
			const clean = stripFdfComment(raw).trim();

			return {
				raw,
				clean,
				lower: clean.toLowerCase()
			};
		})
		.filter((line) => line.clean.length > 0);
}

function stripFdfComment(line: string): string {
	const commentIndex = line.indexOf('#');
	return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function getFdfStringValue(lines: FdfLine[], key: string): string | undefined {
	const line = findFdfLine(lines, key);

	if (!line) {
		return undefined;
	}

	return line.clean.split(/\s+/).slice(1).join(' ') || undefined;
}

function getFdfBlock(lines: FdfLine[], blockName: string): string[] | undefined {
	const startIndex = lines.findIndex((line) => isFdfBlockBoundary(line, '%block', blockName));

	if (startIndex < 0) {
		return undefined;
	}

	const blockLines: string[] = [];

	for (let index = startIndex + 1; index < lines.length; index++) {
		if (isFdfBlockBoundary(lines[index], '%endblock', blockName)) {
			return blockLines;
		}

		blockLines.push(lines[index].clean);
	}

	throw new Error(`Missing %endblock ${blockName}.`);
}

function hasFdfBlock(lines: FdfLine[], blockName: string): boolean {
	return lines.some((line) => isFdfBlockBoundary(line, '%block', blockName));
}

function parseFdfLatticeConstant(lines: FdfLine[]): number {
	const line = findFdfLine(lines, 'LatticeConstant');

	if (!line) {
		return 1.0;
	}

	const tokens = line.clean.split(/\s+/);
	const value = Number(tokens[1]);
	const unit = tokens[2] ?? 'Ang';

	if (!Number.isFinite(value)) {
		throw new Error(`Invalid LatticeConstant line: ${line.raw}`);
	}

	return value * lengthUnitToAngstrom(unit);
}

function parseFdfLattice(
	lines: FdfLine[],
	latticeConstant: number
): [Vec3, Vec3, Vec3] {
	const latticeVectorBlock = getFdfBlock(lines, 'LatticeVectors');

	if (latticeVectorBlock) {
		if (latticeVectorBlock.length < 3) {
			throw new Error('%block LatticeVectors must contain three vectors.');
		}

		return [
			scaleVector(parseVector(latticeVectorBlock[0]), latticeConstant),
			scaleVector(parseVector(latticeVectorBlock[1]), latticeConstant),
			scaleVector(parseVector(latticeVectorBlock[2]), latticeConstant)
		];
	}

	const latticeParametersBlock = getFdfBlock(lines, 'LatticeParameters');

	if (latticeParametersBlock) {
		const values = latticeParametersBlock
			.join(' ')
			.split(/\s+/)
			.slice(0, 6)
			.map(Number);

		if (values.length < 6 || values.some((value) => !Number.isFinite(value))) {
			throw new Error('%block LatticeParameters must contain a b c alpha beta gamma.');
		}

		return latticeParametersToVectors(values, latticeConstant);
	}

	throw new Error(
		'SIESTA FDF parser currently requires %block LatticeVectors or %block LatticeParameters.'
	);
}

function latticeParametersToVectors(
	values: number[],
	latticeConstant: number
): [Vec3, Vec3, Vec3] {
	const [aRaw, bRaw, cRaw, alphaDeg, betaDeg, gammaDeg] = values;

	const a = aRaw * latticeConstant;
	const b = bRaw * latticeConstant;
	const c = cRaw * latticeConstant;

	const alpha = degreesToRadians(alphaDeg);
	const beta = degreesToRadians(betaDeg);
	const gamma = degreesToRadians(gammaDeg);

	const vectorA: Vec3 = [a, 0, 0];
	const vectorB: Vec3 = [b * Math.cos(gamma), b * Math.sin(gamma), 0];

	const cx = c * Math.cos(beta);
	const cy =
		c *
		(Math.cos(alpha) - Math.cos(beta) * Math.cos(gamma)) /
		Math.sin(gamma);

	const czSquared = Math.max(c * c - cx * cx - cy * cy, 0);
	const cz = Math.sqrt(czSquared);

	return [vectorA, vectorB, [cx, cy, cz]];
}

function degreesToRadians(degrees: number): number {
	return degrees * Math.PI / 180;
}

function parseFdfSpeciesMap(lines: FdfLine[]): Map<number, string> {
	const speciesBlock = getFdfBlock(lines, 'ChemicalSpeciesLabel');
	const speciesMap = new Map<number, string>();

	if (!speciesBlock) {
		return speciesMap;
	}

	for (const line of speciesBlock) {
		const tokens = line.split(/\s+/);
		const speciesIndex = parseInt(tokens[0], 10);
		const atomicNumber = Number(tokens[1]);
		const label = tokens[2];

		if (Number.isInteger(speciesIndex) && label) {
			// Only ordinary positive atomic numbers identify elements here. Preserve
			// the existing label fallback for ghost and synthetic species.
			const element = atomicNumberToSymbol(atomicNumber);
			speciesMap.set(speciesIndex, element || normalizeElementSymbol(label));
		}
	}

	return speciesMap;
}

function parseFdfSpeciesAtomicNumberMap(lines: FdfLine[]): Map<number, number> {
	const speciesBlock = getFdfBlock(lines, 'ChemicalSpeciesLabel');
	const speciesAtomicNumbers = new Map<number, number>();

	if (!speciesBlock) {
		return speciesAtomicNumbers;
	}

	for (const line of speciesBlock) {
		const tokens = line.split(/\s+/);
		const speciesIndex = parseInt(tokens[0], 10);
		const atomicNumber = parseInt(tokens[1], 10);

		if (Number.isInteger(speciesIndex) && Number.isInteger(atomicNumber)) {
			speciesAtomicNumbers.set(speciesIndex, atomicNumber);
		}
	}

	return speciesAtomicNumbers;
}

function parseFdfCoordinateFormat(lines: FdfLine[]): FdfCoordinateFormat {
	const line = findFdfLine(lines, 'AtomicCoordinatesFormat');
	const value = line?.clean.split(/\s+/)[1]?.toLowerCase() ?? 'bohr';

	switch (value) {
		case 'bohr':
		case 'notscaledcartesianbohr':
			return 'CartesianBohr';

		case 'ang':
		case 'notscaledcartesianang':
			return 'CartesianAngstrom';

		case 'latticeconstant':
		case 'scaledcartesian':
			return 'ScaledCartesian';

		case 'fractional':
		case 'scaledbylatticevectors':
			return 'Fractional';

		default:
			throw new Error(`Unsupported AtomicCoordinatesFormat: ${value}`);
	}
}

function parseFdfAtoms(
	lines: FdfLine[],
	speciesMap: Map<number, string>,
	lattice: [Vec3, Vec3, Vec3],
	latticeConstant: number,
	coordinateFormat: FdfCoordinateFormat
): Atom[] {
	const atomBlock = getFdfBlock(lines, 'AtomicCoordinatesAndAtomicSpecies');

	if (!atomBlock) {
		throw new Error('Missing %block AtomicCoordinatesAndAtomicSpecies or %block Zmatrix.');
	}

	return atomBlock.map((line) => {
		const tokens = line.split(/\s+/);

		if (tokens.length < 4) {
			throw new Error(`Invalid AtomicCoordinatesAndAtomicSpecies line: ${line}`);
		}

		const rawPosition: Vec3 = [
			Number(tokens[0]),
			Number(tokens[1]),
			Number(tokens[2])
		];

		if (rawPosition.some((value) => !Number.isFinite(value))) {
			throw new Error(`Invalid atomic coordinate line: ${line}`);
		}

		const speciesIndex = parseInt(tokens[3], 10);
		const element = speciesMap.get(speciesIndex) ?? `X${speciesIndex}`;
		const selectiveDynamics = undefined;

		if (coordinateFormat === 'Fractional') {
			return {
				element,
				fdfSpeciesIndex: speciesIndex,
				fractionalPosition: rawPosition,
				selectiveDynamics,
				position: fractionalToCartesian(rawPosition, lattice)
			};
		}

		if (coordinateFormat === 'CartesianAngstrom') {
			return {
				element,
				fdfSpeciesIndex: speciesIndex,
				selectiveDynamics,
				position: rawPosition
			};
		}

		if (coordinateFormat === 'CartesianBohr') {
			return {
				element,
				fdfSpeciesIndex: speciesIndex,
				selectiveDynamics,
				position: scaleVector(rawPosition, lengthUnitToAngstrom('Bohr'))
			};
		}

		return {
			element,
			fdfSpeciesIndex: speciesIndex,
			selectiveDynamics,
			position: scaleVector(rawPosition, latticeConstant)
		};
	});
}

interface FdfConstraintEffect {
	atomIndices: number[];
	kind: 'full' | 'axis' | 'projected';
	motionFlags?: [boolean, boolean, boolean];
	vector?: Vec3;
}

interface FdfConstraintOperation {
	type: 'constraint' | 'clear' | 'clear-prev';
	effects?: FdfConstraintEffect[];
	atomIndices?: number[];
	targetConstraintOperationIndex?: number;
}

function applyFdfGeometryConstraints(
	lines: FdfLine[],
	atoms: Atom[],
	speciesAtomicNumbers: Map<number, number>
) {
	const constraintBlock = getFdfBlock(lines, 'Geometry.Constraints');

	if (!constraintBlock) {
		return;
	}

	const operations: FdfConstraintOperation[] = [];
	let previousConstraintOperationIndex: number | undefined;

	for (const line of constraintBlock) {
		parseFdfGeometryConstraintLineOperations(
			line,
			atoms,
			speciesAtomicNumbers,
			operations,
			previousConstraintOperationIndex
		);

		for (let index = operations.length - 1; index >= 0; index--) {
			if (operations[index].type === 'constraint') {
				previousConstraintOperationIndex = index;
				break;
			}
		}
	}

	const activeEffects = replayFdfConstraintOperations(operations);
	const motionFlags = atoms.map(() => [true, true, true] as [boolean, boolean, boolean]);
	const projectedForceConstraints = atoms.map(() => [] as Vec3[]);

	for (const effects of activeEffects) {
		for (const effect of effects) {
			for (const atomIndex of effect.atomIndices) {
				if (effect.kind === 'axis' && effect.motionFlags) {
					motionFlags[atomIndex] = [
						motionFlags[atomIndex][0] && effect.motionFlags[0],
						motionFlags[atomIndex][1] && effect.motionFlags[1],
						motionFlags[atomIndex][2] && effect.motionFlags[2]
					];
				} else if (effect.kind === 'projected' && effect.vector) {
					projectedForceConstraints[atomIndex].push(effect.vector);
				} else if (effect.kind === 'full') {
					motionFlags[atomIndex] = [false, false, false];
				}
			}
		}
	}

	for (let index = 0; index < atoms.length; index++) {
		const flags = motionFlags[index];

		if (flags.some((canMove) => !canMove)) {
			atoms[index].selectiveDynamics = flags;
		} else {
			delete atoms[index].selectiveDynamics;
		}

		if (projectedForceConstraints[index].length > 0) {
			atoms[index].projectedForceConstraints = projectedForceConstraints[index];
		} else {
			delete atoms[index].projectedForceConstraints;
		}
	}
}

function parseFdfGeometryConstraintLineOperations(
	line: string,
	atoms: Atom[],
	speciesAtomicNumbers: Map<number, number>,
	operations: FdfConstraintOperation[],
	previousConstraintOperationIndex: number | undefined
) {
	const tokens = tokenizeFdfConstraintLine(line);
	let index = 0;

	while (index < tokens.length) {
		const keyword = tokens[index].toLowerCase();

		if (keyword === 'clear' || keyword === 'clear-prev') {
			const parsed = parseFdfConstraintIndexSet(tokens, index + 1, atoms.length, false);
			index = parsed.nextIndex;

			operations.push({
				type: keyword,
				atomIndices: parsed.indices,
				...(previousConstraintOperationIndex !== undefined
					? { targetConstraintOperationIndex: previousConstraintOperationIndex }
					: {})
			});

			continue;
		}

		if (['center', 'rigid', 'molecule', 'rigid-max', 'molecule-max', 'stress', 'cell-vector', 'cell-angle', 'routine'].includes(keyword)) {
			return;
		}

		const parsed = parseFdfConstraintSelector(tokens, index, atoms, speciesAtomicNumbers);
		index = parsed.nextIndex;

		const direction = parseFdfConstraintDirection(tokens, index);
		index = direction.nextIndex;

		const effects: FdfConstraintEffect[] = [];

		for (const atomIndex of parsed.atomIndices) {
			if (atomIndex < 0 || atomIndex >= atoms.length) {
				throw new Error(`Geometry.Constraints atom index ${atomIndex + 1} is out of range.`);
			}
		}

		if (parsed.atomIndices.length > 0) {
			if (direction.kind === 'axis') {
				effects.push({
					atomIndices: [...parsed.atomIndices],
					kind: 'axis',
					motionFlags: direction.motionFlags
				});
			} else if (direction.kind === 'projected') {
				effects.push({
					atomIndices: [...parsed.atomIndices],
					kind: 'projected',
					vector: direction.vector
				});
			} else {
				effects.push({
					atomIndices: [...parsed.atomIndices],
					kind: 'full'
				});
			}
		}

		previousConstraintOperationIndex = operations.length;
		operations.push({
			type: 'constraint',
			effects
		});
	}
}

function replayFdfConstraintOperations(operations: FdfConstraintOperation[]): FdfConstraintEffect[][] {
	const activeEffects = operations.map(() => [] as FdfConstraintEffect[]);

	for (let operationIndex = 0; operationIndex < operations.length; operationIndex++) {
		const operation = operations[operationIndex];

		if (operation.type === 'constraint') {
			activeEffects[operationIndex] = cloneFdfConstraintEffects(operation.effects ?? []);
			continue;
		}

		if (!operation.atomIndices || operation.atomIndices.length === 0) {
			continue;
		}

		if (operation.type === 'clear') {
			for (const effects of activeEffects) {
				removeAtomsFromFdfConstraintEffects(effects, operation.atomIndices);
			}
			continue;
		}

		if (
			operation.type === 'clear-prev' &&
			operation.targetConstraintOperationIndex !== undefined
		) {
			removeAtomsFromFdfConstraintEffects(
				activeEffects[operation.targetConstraintOperationIndex],
				operation.atomIndices
			);
		}
	}

	return activeEffects;
}

function cloneFdfConstraintEffects(effects: FdfConstraintEffect[]): FdfConstraintEffect[] {
	return effects.map((effect) => ({
		...effect,
		atomIndices: [...effect.atomIndices],
		...(effect.vector ? { vector: [...effect.vector] as Vec3 } : {})
	}));
}

function removeAtomsFromFdfConstraintEffects(
	effects: FdfConstraintEffect[],
	atomIndices: number[]
) {
	const atomsToRemove = new Set(atomIndices);

	for (const effect of effects) {
		effect.atomIndices = effect.atomIndices.filter((atomIndex) => !atomsToRemove.has(atomIndex));
	}
}

function tokenizeFdfConstraintLine(line: string): string[] {
	return line
		.replace(/\[/g, ' [ ')
		.replace(/\]/g, ' ] ')
		.replace(/,/g, ' ')
		.replace(/--/g, ' -- ')
		.split(/\s+/)
		.filter((token) => token.length > 0);
}

function parseFdfConstraintSelector(
	tokens: string[],
	startIndex: number,
	atoms: Atom[],
	speciesAtomicNumbers: Map<number, number>
): { atomIndices: number[]; nextIndex: number } {
	const selector = tokens[startIndex].toLowerCase();

	if (selector === 'atom' || selector === 'position') {
		const parsed = parseFdfConstraintIndexSet(tokens, startIndex + 1, atoms.length, true);
		return {
			atomIndices: parsed.indices,
			nextIndex: parsed.nextIndex
		};
	}

	if (selector === 'species-i') {
		const maxSpeciesIndex = getMaxFdfSpeciesIndex(atoms);
		const parsed = parseFdfConstraintIndexSet(tokens, startIndex + 1, maxSpeciesIndex, false);
		const speciesSet = new Set(parsed.indices.map((speciesIndex) => speciesIndex + 1));

		return {
			atomIndices: atoms
				.map((atom, atomIndex) => speciesSet.has(atom.fdfSpeciesIndex ?? Number.NaN) ? atomIndex : -1)
				.filter((atomIndex) => atomIndex >= 0),
			nextIndex: parsed.nextIndex
		};
	}

	if (selector === 'z') {
		const atomicNumberToken = tokens[startIndex + 1];

		if (!atomicNumberToken || !isIntegerToken(atomicNumberToken)) {
			throw new Error('Geometry.Constraints Z selector must be followed by an atomic number.');
		}

		const atomicNumber = parseInt(atomicNumberToken, 10);

		return {
			atomIndices: atoms
				.map((atom, atomIndex) => getFdfAtomAtomicNumber(atom, speciesAtomicNumbers) === atomicNumber ? atomIndex : -1)
				.filter((atomIndex) => atomIndex >= 0),
			nextIndex: startIndex + 2
		};
	}

	throw new Error(`Unsupported Geometry.Constraints selector: ${tokens[startIndex]}`);
}

function parseFdfConstraintIndexSet(
	tokens: string[],
	startIndex: number,
	maxIndex: number,
	allowAll: boolean
): { indices: number[]; nextIndex: number } {
	if (startIndex >= tokens.length) {
		throw new Error('Missing Geometry.Constraints atom/species index selector.');
	}

	if (tokens[startIndex].toLowerCase() === 'all') {
		if (!allowAll) {
			throw new Error('Geometry.Constraints selector "all" is only supported for atom/position constraints, not clear, clear-prev, species-i, or Z constraints.');
		}

		return {
			indices: Array.from({ length: maxIndex }, (_, index) => index),
			nextIndex: startIndex + 1
		};
	}

	if (tokens[startIndex].toLowerCase() === 'from') {
		const first = Number(tokens[startIndex + 1]);
		const rangeMode = tokens[startIndex + 2]?.toLowerCase();
		const rangeValue = Number(tokens[startIndex + 3]);
		let step = 1;
		let nextIndex = startIndex + 4;

		if (!Number.isInteger(first) || !Number.isInteger(rangeValue)) {
			throw new Error('Invalid Geometry.Constraints "from ..." selector.');
		}

		if (tokens[nextIndex]?.toLowerCase() === 'step') {
			step = Number(tokens[nextIndex + 1]);
			nextIndex += 2;
		}

		if (rangeMode === 'to') {
			return {
				indices: makeOneBasedIndexRange(first, rangeValue, step, maxIndex),
				nextIndex
			};
		}

		if (rangeMode === 'plus') {
			return {
				indices: makeOneBasedIndexRange(first, first + rangeValue - 1, step, maxIndex),
				nextIndex
			};
		}

		if (rangeMode === 'minus') {
			if (first <= rangeValue) {
				throw new Error('Invalid Geometry.Constraints "from A minus B" selector: A must be greater than B.');
			}
			return {
				indices: makeOneBasedIndexRange(first, first - rangeValue + 1, step, maxIndex),
				nextIndex
			};
		}

		throw new Error('Invalid Geometry.Constraints range selector. Expected "to", "plus", or "minus" after "from A".');
	}

	if (tokens[startIndex] === '[') {
		const indices: number[] = [];
		let index = startIndex + 1;

		while (index < tokens.length && tokens[index] !== ']') {
			const first = Number(tokens[index]);

			if (!Number.isInteger(first)) {
				throw new Error('Invalid Geometry.Constraints bracketed index selector.');
			}

			if (tokens[index + 1] === '--') {
				const last = Number(tokens[index + 2]);
				let step = 1;
				index += 3;

				if (tokens[index]?.toLowerCase() === 'step') {
					step = Number(tokens[index + 1]);
					index += 2;
				}

				indices.push(...makeOneBasedIndexRange(first, last, step, maxIndex));
			} else {
				indices.push(oneBasedIndexToZeroBased(first, maxIndex));
				index += 1;
			}
		}

		if (tokens[index] !== ']') {
			throw new Error('Unclosed Geometry.Constraints bracketed index selector.');
		}

		return {
			indices,
			nextIndex: index + 1
		};
	}

	if (isIntegerToken(tokens[startIndex])) {
		const indices: number[] = [];
		let nextIndex = startIndex;
		// Integers select atoms; decimal real tokens start a directional vector.
		while (nextIndex < tokens.length && isIntegerToken(tokens[nextIndex])) {
			indices.push(oneBasedIndexToZeroBased(Number(tokens[nextIndex]), maxIndex));
			nextIndex += 1;
		}
		return { indices, nextIndex };
	}

	throw new Error(`Invalid Geometry.Constraints index selector: ${tokens[startIndex]}`);
}

function parseFdfConstraintDirection(
	tokens: string[],
	startIndex: number
):
	| { kind: 'full'; nextIndex: number }
	| { kind: 'axis'; motionFlags: [boolean, boolean, boolean]; nextIndex: number }
	| { kind: 'projected'; vector: Vec3; nextIndex: number } {
	if (
		startIndex + 2 < tokens.length &&
		isRealToken(tokens[startIndex]) &&
		isRealToken(tokens[startIndex + 1]) &&
		isRealToken(tokens[startIndex + 2])
	) {
		const direction: Vec3 = [
			fdfRealTokenToNumber(tokens[startIndex]),
			fdfRealTokenToNumber(tokens[startIndex + 1]),
			fdfRealTokenToNumber(tokens[startIndex + 2])
		];

		return directionVectorToConstraint(direction, startIndex + 3);
	}

	return {
		kind: 'full',
		nextIndex: startIndex
	};
}

function directionVectorToConstraint(
	direction: Vec3,
	nextIndex: number
):
	| { kind: 'axis'; motionFlags: [boolean, boolean, boolean]; nextIndex: number }
	| { kind: 'projected'; vector: Vec3; nextIndex: number } {
	if (direction.every((value) => Math.abs(value) < 1e-12)) {
		throw new Error('Geometry.Constraints directional vector cannot be zero.');
	}

	const nonzeroComponents = direction.map((value) => Math.abs(value) >= 1e-12);
	const nonzeroCount = nonzeroComponents.filter(Boolean).length;

	if (nonzeroCount === 1) {
		return {
			kind: 'axis',
			motionFlags: [
				!nonzeroComponents[0],
				!nonzeroComponents[1],
				!nonzeroComponents[2]
			],
			nextIndex
		};
	}

	return {
		kind: 'projected',
		vector: direction,
		nextIndex
	};
}

function makeOneBasedIndexRange(first: number, last: number, step: number, maxIndex: number): number[] {
	oneBasedIndexToZeroBased(first, maxIndex);
	oneBasedIndexToZeroBased(last, maxIndex);

	if (!Number.isInteger(step) || step <= 0) {
		throw new Error('Geometry.Constraints step must be a positive integer.');
	}

	const indices: number[] = [];
	const direction = first <= last ? 1 : -1;
	const signedStep = direction * step;

	for (
		let value = first;
		direction > 0 ? value <= last : value >= last;
		value += signedStep
	) {
		indices.push(oneBasedIndexToZeroBased(value, maxIndex));
	}

	return indices;
}

function oneBasedIndexToZeroBased(index: number, maxIndex: number): number {
	if (!Number.isInteger(index) || index < 1 || index > maxIndex) {
		throw new Error(`Geometry.Constraints index ${index} is out of range.`);
	}

	return index - 1;
}

function getMaxFdfSpeciesIndex(atoms: Atom[]): number {
	return atoms.reduce((maxSpeciesIndex, atom) => {
		return atom.fdfSpeciesIndex !== undefined
			? Math.max(maxSpeciesIndex, atom.fdfSpeciesIndex)
			: maxSpeciesIndex;
	}, 0);
}

function getFdfAtomAtomicNumber(atom: Atom, speciesAtomicNumbers: Map<number, number>): number | undefined {
	if (atom.fdfSpeciesIndex !== undefined) {
		const atomicNumber = speciesAtomicNumbers.get(atom.fdfSpeciesIndex);

		if (atomicNumber !== undefined) {
			return atomicNumber;
		}
	}

	return elementSymbolToAtomicNumber(atom.element);
}

function elementSymbolToAtomicNumber(element: string): number | undefined {
	const normalized = normalizeElementSymbol(element);
	const atomicNumber = ELEMENT_SYMBOLS_BY_ATOMIC_NUMBER.indexOf(normalized);
	return atomicNumber > 0 ? atomicNumber : undefined;
}

function fdfRealTokenToNumber(token: string): number {
	return Number(token.replace(/[Dd]/, 'E'));
}

function isIntegerToken(token: string): boolean {
	return /^[-+]?\d+$/.test(token);
}

function isRealToken(token: string): boolean {
	return /^[-+]?(?:\d+\.\d*|\.\d+)(?:[EeDd][-+]?\d+)?$/.test(token);
}

function normalizeFdfLabel(label: string): string {
	return label.toLowerCase().replace(/[-_.]/g, '');
}

function isFdfBlockBoundary(line: FdfLine, marker: string, blockName: string): boolean {
	const tokens = line.clean.split(/\s+/);
	return tokens[0].toLowerCase() === marker &&
		(tokens[1] !== undefined
			? normalizeFdfLabel(tokens[1]) === normalizeFdfLabel(blockName)
			: marker === '%endblock');
}

function findFdfLine(lines: FdfLine[], key: string): FdfLine | undefined {
	const normalizedKey = normalizeFdfLabel(key);
	return lines.find((entry) => normalizeFdfLabel(entry.clean.split(/\s+/)[0]) === normalizedKey);
}

function lengthUnitToAngstrom(unit: string): number {
	const normalized = unit.toLowerCase();

	if (normalized.startsWith('ang')) {
		return 1.0;
	}

	if (normalized.startsWith('bohr')) {
		return 0.529177210903;
	}

	if (normalized === 'nm') {
		return 10.0;
	}

	throw new Error(`Unsupported length unit: ${unit}`);
}

function normalizeElementSymbol(label: string): string {
	const cleaned = label.replace(/[^a-zA-Z]/g, '');

	if (!cleaned) {
		return label;
	}

	return cleaned[0].toUpperCase() + cleaned.slice(1).toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Gaussian GJF / COM                                                         */
/* -------------------------------------------------------------------------- */

interface GaussianMoleculeSpecification {
	atoms: Atom[];
	translationVectors: Vec3[];
	warning?: string;
}

interface GaussianAtomSpec {
	element: string;
	parameters?: string;
}

function parseGaussianGjf(text: string): AtomicStructure {
	const rawLines = text.split(/\r?\n/);
	const moleculeStartIndex = findGaussianMoleculeSpecificationStart(rawLines);
	const moleculeSpecification = parseGaussianMoleculeSpecification(rawLines, moleculeStartIndex);

	if (moleculeSpecification.atoms.length === 0) {
		throw new Error('No renderable atoms found in Gaussian molecule specification.');
	}

	const lattice = gaussianTranslationVectorsToLattice(moleculeSpecification.translationVectors);

	return {
		title: parseGaussianTitle(rawLines) ?? 'Gaussian input',
		...(lattice ? { lattice } : {}),
		atoms: moleculeSpecification.atoms,
		coordinateMode: 'Cartesian',
		sourceFormat: 'GJF',
		warning: moleculeSpecification.warning
	};
}

function findGaussianMoleculeSpecificationStart(rawLines: string[]): number {
	let index = 0;

	while (index < rawLines.length && rawLines[index].trim().startsWith('%')) {
		index += 1;
	}

	while (index < rawLines.length && rawLines[index].trim().length === 0) {
		index += 1;
	}

	if (index >= rawLines.length || !rawLines[index].trim().startsWith('#')) {
		throw new Error('Could not find Gaussian route section starting with #.');
	}

	while (index < rawLines.length && rawLines[index].trim().length > 0) {
		index += 1;
	}

	while (index < rawLines.length && rawLines[index].trim().length === 0) {
		index += 1;
	}

	while (index < rawLines.length && rawLines[index].trim().length > 0) {
		index += 1;
	}

	while (index < rawLines.length && rawLines[index].trim().length === 0) {
		index += 1;
	}

	if (index >= rawLines.length || !isGaussianChargeMultiplicityLine(rawLines[index])) {
		throw new Error('Could not find Gaussian charge/multiplicity line.');
	}

	return index + 1;
}

function parseGaussianTitle(rawLines: string[]): string | undefined {
	let index = 0;

	while (index < rawLines.length && rawLines[index].trim().startsWith('%')) {
		index += 1;
	}

	while (index < rawLines.length && rawLines[index].trim().length === 0) {
		index += 1;
	}

	if (index >= rawLines.length || !rawLines[index].trim().startsWith('#')) {
		return undefined;
	}

	while (index < rawLines.length && rawLines[index].trim().length > 0) {
		index += 1;
	}

	while (index < rawLines.length && rawLines[index].trim().length === 0) {
		index += 1;
	}

	const titleLines: string[] = [];

	while (index < rawLines.length && rawLines[index].trim().length > 0) {
		titleLines.push(rawLines[index].trim());
		index += 1;
	}

	return titleLines.join(' ').trim() || undefined;
}

function isGaussianChargeMultiplicityLine(line: string): boolean {
	const tokens = line.trim().split(/[\s,]+/);

	if (tokens.length < 2 || tokens.length % 2 !== 0) {
		return false;
	}

	return tokens.every((token) => /^[-+]?\d+$/.test(token));
}

function parseGaussianMoleculeSpecification(
	rawLines: string[],
	startIndex: number
): GaussianMoleculeSpecification {
	const units = gaussianUnits(rawLines);
	let end = startIndex;
	while (end < rawLines.length) {
		const line = stripGaussianComment(rawLines[end]).trim();
		if ((!line && !rawLines[end].trim().startsWith('!')) || /^(variables|constants)\s*:?$/i.test(line) || /^--link1--$/i.test(line)) { break; }
		end++;
	}
	const symbols = gaussianSymbols(rawLines, end);
	const centers: GaussianCenter[] = [];
	const atoms: Atom[] = [];
	const translationVectors: Vec3[] = [];
	let warning: string | undefined;
	let cartesianCenters = 0;
	let shortInternal: { sourceIndex: number; line: number } | undefined;
	for (let index = startIndex; index < end; index++) {
		const line = stripGaussianComment(rawLines[index]).trim();
		if (!line) { continue; }
		// Lattice failures affect the entire structure, not just a suffix of atoms.
		if (/^tv(?:[\s,]|$)/i.test(line)) {
			const fields = gaussianFields(line);
			if (fields.length !== 4) { throw new Error(`Invalid Gaussian TV line ${index + 1}.`); }
			translationVectors.push(fields.slice(1).map(t => zmValue(t, symbols) * units.length) as Vec3);
			continue;
		}
		try {
			const center = gaussianCenter(gaussianFields(line), centers, symbols, units);
			if (!center.position.every(Number.isFinite)) { throw new Error('Non-finite converted coordinates.'); }
			// Numeric Cartesian rows have no Z-matrix details; symbolic ones
			// carry the Cartesian-input context. Count dummy/ghost references too.
			if (!center.zmatrix || center.zmatrix.context === 'Cartesian input') {
				cartesianCenters++;
			} else if (center.zmatrix.entries.length === 1 || center.zmatrix.entries.length === 2) {
				shortInternal ??= { sourceIndex: centers.length + 1, line: index + 1 };
			}
			centers.push(center);
			if (!center.dummy) { atoms.push(center); }
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (!atoms.length) { throw new Error(`Gaussian geometry at line ${index + 1}: ${reason}`); }
			warning = `Partial structure: only the first ${atoms.length} atom(s) are shown. Gaussian geometry at line ${index + 1}, source atom ${centers.length + 1}: ${reason} This atom and the remaining atoms were not read.`;
			break;
		}
	}
	if (cartesianCenters > 1 && shortInternal) {
		throw new Error(`Unsupported mixed Gaussian geometry: source atom ${shortInternal.sourceIndex} (line ${shortInternal.line}) uses only a bond length or a bond length and angle alongside multiple Cartesian centers. Define three noncollinear Cartesian reference centers before using full internal-coordinate definitions.`);
	}
	return { atoms, translationVectors, warning };
}

function stripGaussianComment(line: string): string {
	const commentIndex = line.indexOf('!');
	return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function parseGaussianAtomSpec(token: string): GaussianAtomSpec | undefined {
	let atomToken = token.trim();
	let parameters: string | undefined;

	const parameterMatch = atomToken.match(/^(.*?)\((.*)\)$/);

	if (parameterMatch) {
		atomToken = parameterMatch[1];
		parameters = parameterMatch[2];
	}

	if (/^\d+$/.test(atomToken)) {
		const element = atomicNumberToSymbol(Number(atomToken));
		return element ? { element, parameters } : undefined;
	}

	const elementPart = atomToken.split('-')[0];
	const element = parseElementFromGaussianLabel(elementPart);

	return element ? { element, parameters } : undefined;
}

function parseElementFromGaussianLabel(label: string): string | undefined {
	const trimmed = label.trim();

	if (!trimmed) {
		return undefined;
	}

	const twoLetterCandidate = trimmed.slice(0, 2);

	if (twoLetterCandidate.length === 2 && isValidElementSymbol(normalizeElementSymbol(twoLetterCandidate))) {
		return normalizeElementSymbol(twoLetterCandidate);
	}

	const oneLetterCandidate = trimmed.slice(0, 1);

	if (isValidElementSymbol(normalizeElementSymbol(oneLetterCandidate))) {
		return normalizeElementSymbol(oneLetterCandidate);
	}

	return undefined;
}

function gaussianFreezeCodeToSelectiveDynamics(
	freezeCode: number | undefined
): [boolean, boolean, boolean] | undefined {
	if (freezeCode === undefined) {
		return undefined;
	}

	return freezeCode < 0
		? [false, false, false]
		: [true, true, true];
}

function gaussianTranslationVectorsToLattice(
	translationVectors: Vec3[]
): [Vec3, Vec3, Vec3] | undefined {
	if (translationVectors.length === 0) {
		return undefined;
	}

	if (translationVectors.length > 3) {
		throw new Error('Gaussian molecule specification contains more than three TV lines.');
	}

	const lattice: [Vec3, Vec3, Vec3] = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0]
	];

	for (let index = 0; index < translationVectors.length; index++) {
		lattice[index] = translationVectors[index];
	}

	return lattice;
}

function isPlainNumberToken(token: string): boolean {
	return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?$/.test(token);
}

function gaussianNumberToNumber(token: string): number {
	return Number(token.replace(/[Dd]/, 'E'));
}

function isValidElementSymbol(symbol: string): boolean {
	return ELEMENT_SYMBOLS.has(symbol);
}

function atomicNumberToSymbol(atomicNumber: number): string | undefined {
	return ELEMENT_SYMBOLS_BY_ATOMIC_NUMBER[atomicNumber];
}

/* -------------------------------------------------------------------------- */
/* Quantum ESPRESSO                                                           */
/* -------------------------------------------------------------------------- */

function parseQuantumEspressoInput(text: string): AtomicStructure {
	const lines = preprocessQeLines(text);
	const systemValues = parseQeNamelist(lines, 'system');
	
	const ibrav = parseQeIbrav(systemValues);

	if (ibrav !== undefined && ibrav !== 0) {
		throw new Error(`Quantum ESPRESSO ibrav = ${ibrav} is not supported yet. AtomView currently supports QE inputs with ibrav = 0 and explicit CELL_PARAMETERS.`);
	}

	const title =
		parseQeNamelist(lines, 'control').get('prefix') ??
		'Quantum ESPRESSO input';

	const explicitAlat = parseQeAlatAngstrom(systemValues);
	const lattice = parseQeLattice(lines, explicitAlat);
	// QE derives alat from the first cell vector when A/celldm(1) is absent.
	const alat = explicitAlat ?? Math.hypot(...lattice[0]);
	const speciesMap = parseQeSpeciesMap(lines);
	const { atoms, coordinateMode } = parseQeAtoms(lines, speciesMap, lattice, alat);

	if (atoms.length === 0) {
		throw new Error('No atoms found in ATOMIC_POSITIONS.');
	}

	return {
		title,
		lattice,
		atoms,
		coordinateMode,
		sourceFormat: 'QE'
	};
}

function preprocessQeLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => {
			// A quoted prefix or path may contain ! without starting a comment.
			return line.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|!.*$/g,
				(token) => token.startsWith('!') ? '' : token).trim();
		})
		.filter((line) => line.length > 0);
}

function parseQeNamelist(lines: string[], name: string): Map<string, string> {
	const values = new Map<string, string>();
	const lowerName = `&${name.toLowerCase()}`;
	const startIndex = lines.findIndex((line) =>
		line.split(/\s+/)[0].toLowerCase() === lowerName
	);

	if (startIndex < 0) {
		return values;
	}

	// Include assignments on the opening line and stop at an unquoted slash.
	// Slashes and commas inside quoted strings are part of the value.
	const text = lines.slice(startIndex).join('\n').slice(lowerName.length);
	let body = '';
	for (const token of text.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\/|[^'"/]+/g) ?? []) {
		if (token === '/') {
			break;
		}
		body += token;
	}

	const assignment = /([a-zA-Z][a-zA-Z0-9_]*(?:\(\s*\d+\s*\))?)\s*=\s*('(?:[^']|'')*'|"(?:[^"]|"")*"|[^,\s]+)/g;
	for (const match of body.matchAll(assignment)) {
		values.set(
			match[1].toLowerCase().replace(/\s/g, ''),
			match[2].replace(/^['"]|['"]$/g, '').trim()
		);
	}

	return values;
}

function parseQeIbrav(systemValues: Map<string, string>): number | undefined {
	const value = systemValues.get('ibrav');

	if (value === undefined) {
		return undefined;
	}

	const parsed = Number(value);

	if (!Number.isInteger(parsed)) {
		throw new Error(`Invalid QE ibrav value: ${value}`);
	}

	return parsed;
}

function parseQeAlatAngstrom(systemValues: Map<string, string>): number | undefined {
	const aValue = systemValues.get('a');
	const celldm1Value = systemValues.get('celldm(1)');
	const value = aValue ?? celldm1Value;

	if (value === undefined) {
		return undefined;
	}

	const parsed = Number(value.replace(/[Dd]/, 'E'));
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid QE lattice parameter: ${value}`);
	}

	return aValue !== undefined ? parsed : parsed * lengthUnitToAngstrom('Bohr');
}

function parseQeLattice(lines: string[], alat: number | undefined): [Vec3, Vec3, Vec3] {
	const headerIndex = lines.findIndex((line) =>
		line.toLowerCase().startsWith('cell_parameters')
	);

	if (headerIndex < 0) {
		throw new Error('QE parser currently requires explicit CELL_PARAMETERS. AtomView supports QE inputs with ibrav = 0; Bravais-lattice construction from ibrav/a/b/c/celldm is not implemented yet.');
	}

	if (lines.length < headerIndex + 4) {
		throw new Error('CELL_PARAMETERS must be followed by three lattice vectors.');
	}

	const header = lines[headerIndex];
	const unit = parseQeHeaderUnit(header) ?? (alat === undefined ? 'bohr' : 'alat');
	const scale = qeLengthScaleToAngstrom(unit, alat);

	return [
		scaleVector(parseVector(lines[headerIndex + 1]), scale),
		scaleVector(parseVector(lines[headerIndex + 2]), scale),
		scaleVector(parseVector(lines[headerIndex + 3]), scale)
	];
}

function parseQeSpeciesMap(lines: string[]): Map<string, string> {
	const speciesMap = new Map<string, string>();
	const headerIndex = lines.findIndex((line) =>
		line.toLowerCase().startsWith('atomic_species')
	);

	if (headerIndex < 0) {
		return speciesMap;
	}

	for (let index = headerIndex + 1; index < lines.length; index++) {
		const line = lines[index];

		if (isQeSectionHeader(line)) {
			break;
		}

		const tokens = line.split(/\s+/);

		if (tokens.length >= 1) {
			speciesMap.set(tokens[0], normalizeElementSymbol(tokens[0]));
		}
	}

	return speciesMap;
}

function parseQeAtoms(
	lines: string[],
	speciesMap: Map<string, string>,
	lattice: [Vec3, Vec3, Vec3],
	alat: number
): { atoms: Atom[]; coordinateMode: 'Direct' | 'Cartesian' } {
	const headerIndex = lines.findIndex((line) =>
		line.toLowerCase().startsWith('atomic_positions')
	);

	if (headerIndex < 0) {
		throw new Error('Missing ATOMIC_POSITIONS.');
	}

	const unit = parseQeHeaderUnit(lines[headerIndex]) ?? 'alat';
	const coordinateFormat = parseQeCoordinateFormat(unit);
	const atoms: Atom[] = [];

	for (let index = headerIndex + 1; index < lines.length; index++) {
		const line = lines[index];

		if (isQeSectionHeader(line)) {
			break;
		}

		const tokens = line.split(/\s+/);

		if (tokens.length < 4) {
			continue;
		}

		const label = tokens[0];
		const rawPosition: Vec3 = [
			Number(tokens[1]),
			Number(tokens[2]),
			Number(tokens[3])
		];

		if (rawPosition.some((value) => !Number.isFinite(value))) {
			throw new Error(`Invalid ATOMIC_POSITIONS line: ${line}`);
		}

		const selectiveDynamics = parseQeIfPosFlags(tokens.slice(4, 7));
		const element = speciesMap.get(label) ?? normalizeElementSymbol(label);

		if (coordinateFormat === 'Crystal') {
			atoms.push({
				element,
				fractionalPosition: rawPosition,
				selectiveDynamics,
				position: fractionalToCartesian(rawPosition, lattice)
			});
		} else if (coordinateFormat === 'CartesianAngstrom') {
			atoms.push({
				element,
				selectiveDynamics,
				position: rawPosition
			});
		} else if (coordinateFormat === 'CartesianBohr') {
			atoms.push({
				element,
				selectiveDynamics,
				position: scaleVector(rawPosition, lengthUnitToAngstrom('Bohr'))
			});
		} else {
			atoms.push({
				element,
				selectiveDynamics,
				position: scaleVector(rawPosition, alat)
			});
		}
	}

	return {
		atoms,
		coordinateMode: coordinateFormat === 'Crystal' ? 'Direct' : 'Cartesian'
	};
}

function parseQeHeaderUnit(header: string): string | undefined {
	const braceMatch = header.match(/\{\s*([^}]+)\s*\}/);

	if (braceMatch) {
		return braceMatch[1].trim().toLowerCase();
	}

	const parenMatch = header.match(/\(\s*([^)]+)\s*\)/);

	if (parenMatch) {
		return parenMatch[1].trim().toLowerCase();
	}

	const tokens = header.split(/\s+/);

	return tokens[1]?.toLowerCase();
}

function parseQeCoordinateFormat(unit: string): QeCoordinateFormat {
	const normalized = unit.toLowerCase();

	if (normalized.startsWith('crystal_sg')) {
		throw new Error('ATOMIC_POSITIONS crystal_sg is not supported. AtomView requires all atoms to be explicitly listed.');
	}

	if (normalized.startsWith('crystal')) {
		return 'Crystal';
	}

	if (normalized.startsWith('ang')) {
		return 'CartesianAngstrom';
	}

	if (normalized.startsWith('bohr')) {
		return 'CartesianBohr';
	}

	if (normalized.startsWith('alat')) {
		return 'Alat';
	}

	throw new Error(`Unsupported ATOMIC_POSITIONS unit: ${unit}`);
}

function qeLengthScaleToAngstrom(unit: string, alat: number | undefined): number {
	const normalized = unit.toLowerCase();

	if (normalized.startsWith('ang')) {
		return 1.0;
	}

	if (normalized.startsWith('bohr')) {
		return lengthUnitToAngstrom('Bohr');
	}

	if (normalized === 'alat') {
		if (alat === undefined) {
			throw new Error('CELL_PARAMETERS alat requires A or celldm(1) in &SYSTEM.');
		}
		return alat;
	}

	throw new Error(`Unsupported CELL_PARAMETERS unit: ${unit}`);
}

function parseQeIfPosFlags(tokens: string[]): [boolean, boolean, boolean] | undefined {
	if (tokens.length < 3) {
		return undefined;
	}

	const parsed = tokens.map((token) => {
		if (token === '1') {
			return true;
		}

		if (token === '0') {
			return false;
		}

		return undefined;
	});

	if (parsed.some((value) => value === undefined)) {
		return undefined;
	}

	return parsed as [boolean, boolean, boolean];
}

function isQeSectionHeader(line: string): boolean {
	const lower = line.toLowerCase();

	return (
		lower.startsWith('&') ||
		lower === '/' ||
		lower.startsWith('atomic_species') ||
		lower.startsWith('atomic_positions') ||
		lower.startsWith('cell_parameters') ||
		lower.startsWith('k_points') ||
		lower.startsWith('occupations') ||
		lower.startsWith('constraints')
	);
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

const ELEMENT_SYMBOLS_BY_ATOMIC_NUMBER = [
	'',
	'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
	'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca',
	'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
	'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr',
	'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn',
	'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd',
	'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb',
	'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg',
	'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th',
	'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm',
	'Md', 'No', 'Lr', 'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds',
	'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og'
];

const ELEMENT_SYMBOLS = new Set(ELEMENT_SYMBOLS_BY_ATOMIC_NUMBER.filter(Boolean));

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
/* Z-matrix geometry and source metadata                                      */

interface ZMatrixFreedom {
	state: 'free' | 'fixed' | 'linked';
	root?: string;
	relation?: string;
}

interface ZMatrixSymbols extends Map<string, number> {
	freedoms: Map<string, ZMatrixFreedom>;
}

interface ZMatrixPoint {
	position: Vec3;
	label: string;
	auxiliary?: boolean;
}

interface ZMatrixGeometry {
	kind: 'distance' | 'angle' | 'dihedral';
	points: ZMatrixPoint[];
	axis?: Vec3;
}

interface ZMatrixEntry {
	label: string;
	source: string;
	value: number;
	unit: string;
	freedom?: ZMatrixFreedom;
	geometry?: ZMatrixGeometry;
}

interface ZMatrixInfo {
	indexLabel?: string;
	context?: string;
	entries: ZMatrixEntry[];
}

const ZM_BOHR = 0.529177210903;
const ZM_DEG = Math.PI / 180;

function zmAdd(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function zmSub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function zmDot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function zmCross(a: Vec3, b: Vec3): Vec3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function zmUnit(a: Vec3): Vec3 {
	const length = Math.hypot(...a);
	if (length < 1e-12) { throw new Error('Degenerate Z-matrix reference geometry (coincident or collinear centers).'); }
	return scaleVector(a, 1 / length);
}
function zmNumber(token: string): number {
	if (!isPlainNumberToken(token)) { throw new Error(`Invalid numeric value "${token}".`); }
	const value = gaussianNumberToNumber(token);
	if (!Number.isFinite(value)) { throw new Error(`Non-finite value "${token}".`); }
	return value;
}
function zmValue(token: string, symbols: Map<string, number>, signed = true): number {
	if (isPlainNumberToken(token)) { return zmNumber(token); }
	const negative = signed && token.startsWith('-');
	const key = (signed ? token.replace(/^[+-]/, '') : token).toLowerCase();
	const value = symbols.get(key);
	if (value === undefined) { throw new Error(`Undefined Z-matrix variable "${token}".`); }
	return negative ? -value : value;
}
function zmEntry(label: string, source: string, value: number, unit: string): ZMatrixEntry {
	return { label, source, value, unit };
}
function zmSymbols(): ZMatrixSymbols {
	return Object.assign(new Map<string, number>(), { freedoms: new Map<string, ZMatrixFreedom>() });
}
function zmFreedom(source: string, symbols: ZMatrixSymbols, literal: 'free' | 'fixed'): ZMatrixFreedom {
	return isPlainNumberToken(source) ? { state: literal } :
		{ ...symbols.freedoms.get(source.replace(/^[+-]/, '').toLowerCase())! };
}
function zmPoint(atom: Atom, label = String(atom.sourceIndex)): ZMatrixPoint {
	return { position: [...atom.position], label };
}
function zmGeometry(points: ZMatrixPoint[], kind?: ZMatrixGeometry['kind']): ZMatrixGeometry {
	return { kind: kind ?? (points.length === 2 ? 'distance' : points.length === 3 ? 'angle' : 'dihedral'), points };
}

function zmCheckInternal(r: number, angle?: number) {
	if (!(r > 0)) { throw new Error('Z-matrix distance must be positive.'); }
	if (angle !== undefined && !(angle > 0 && angle < Math.PI)) {
		throw new Error('Z-matrix bond angle must be between 0 and 180 degrees.');
	}
}

// Signed torsion P-i-j-k, matching SIESTA's Z2C: normal = (i-j) x (k-j).
function zmInternal(i: Vec3, j: Vec3, k: Vec3, r: number, angle: number, torsion: number): Vec3 {
	zmCheckInternal(r, angle);
	const axis = zmUnit(zmSub(i, j));
	const normal = zmUnit(zmCross(axis, zmUnit(zmSub(k, j))));
	const plane = zmCross(normal, axis);
	return zmAdd(i, zmAdd(scaleVector(axis, -r * Math.cos(angle)),
		zmAdd(scaleVector(plane, r * Math.sin(angle) * Math.cos(torsion)),
			scaleVector(normal, r * Math.sin(angle) * Math.sin(torsion)))));
}

function zmThirdGaussian(i: Vec3, j: Vec3, r: number, angle: number): Vec3 {
	zmCheckInternal(r, angle);
	const axis = zmUnit(zmSub(j, i));
	// The usual input orientation has atom 2 on +z and atom 3 in the +x/z plane.
	const seed: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
	const perpendicular = zmUnit(zmSub(seed, scaleVector(axis, zmDot(seed, axis))));
	return zmAdd(i, scaleVector(zmAdd(scaleVector(axis, Math.cos(angle)),
		scaleVector(perpendicular, Math.sin(angle))), r));
}

// SIESTA 5.4.2 Z2CGen uses a rotated local frame for atom 3, including the
// input azimuth when the first bond lies along a coordinate axis.
function zmThirdSiesta(i: Vec3, j: Vec3, r: number, angle: number, torsion: number, phiRef: number): Vec3 {
	const bond = zmSub(i, j);
	const length = Math.hypot(...bond);
	zmUnit(bond);
	const theta = Math.acos(Math.max(-1, Math.min(1, bond[2] / length)));
	const phi = Math.abs(bond[0]) > 1e-8 && Math.abs(bond[1]) > 1e-8 ? Math.atan2(bond[1], bond[0]) : phiRef;
	const p = zmInternal([length, 0, 0], [0, 0, 0], [length, 0, 1], r, angle, torsion);
	const rotated: Vec3 = [p[0] * Math.cos(phi) - p[1] * Math.sin(phi), p[0] * Math.sin(phi) + p[1] * Math.cos(phi), p[2]];
	const axis: Vec3 = [Math.sin(phi), -Math.cos(phi), 0];
	const t = Math.PI / 2 - theta;
	return zmAdd(j, zmAdd(scaleVector(rotated, Math.cos(t)),
		zmAdd(scaleVector(zmCross(axis, rotated), Math.sin(t)), scaleVector(axis, zmDot(axis, rotated) * (1 - Math.cos(t))))));
}

// Commas delimit fields, except inside Gaussian's parenthesized atom metadata.
function gaussianFields(line: string): string[] {
	const fields: string[] = [];
	let field = '', depth = 0;
	for (const c of line.trim()) {
		if (c === '(') { depth++; }
		if (c === ')') { depth--; }
		if (depth < 0) { throw new Error('Unbalanced Gaussian atom metadata.'); }
		if (depth === 0 && /[\s,]/.test(c)) {
			if (field) { fields.push(field); field = ''; }
		} else { field += c; }
	}
	if (depth !== 0) { throw new Error('Unbalanced Gaussian atom metadata.'); }
	if (field) { fields.push(field); }
	return fields;
}

function gaussianUnits(rawLines: string[]): { length: number; angle: number } {
	const start = rawLines.findIndex(line => line.trim().startsWith('#'));
	let route = '';
	for (let i = start; i >= 0 && i < rawLines.length && rawLines[i].trim(); i++) { route += ' ' + rawLines[i]; }
	const result = { length: 1, angle: ZM_DEG };
	const match = route.match(/\bunits\s*(?:=\s*)?(\([^)]*\)|[a-z]+)/i);
	if (!match) { return result; }
	for (const unit of match[1].replace(/[()]/g, '').toLowerCase().split(/[\s,]+/).filter(Boolean)) {
		if (unit === 'au') { result.length = ZM_BOHR; }
		else if (unit === 'ang') { result.length = 1; }
		else if (unit === 'rad') { result.angle = 1; }
		else if (unit === 'deg') { result.angle = ZM_DEG; }
		else { throw new Error(`Unsupported Gaussian Units option "${unit}".`); }
	}
	return result;
}

function gaussianSymbols(rawLines: string[], start: number): ZMatrixSymbols {
	const symbols = zmSymbols();
	const separator = stripGaussianComment(rawLines[start] ?? '').trim();
	if (separator && !/^(variables|constants)\s*:?$/i.test(separator)) { return symbols; }
	// A blank line or Variables: ends geometry and starts variables. A second
	// separator starts constants; the next ends the symbol definitions. Both
	// sections supply starting coordinates, irrespective of optimization status.
	let constants = /^constants\s*:?$/i.test(separator);
	for (let i = start + 1; i < rawLines.length; i++) {
		if (rawLines[i].trim().startsWith('!')) { continue; }
		const line = stripGaussianComment(rawLines[i]).trim();
		if (!line || /^constants\s*:?$/i.test(line)) {
			if (constants) { break; }
			constants = true;
			continue;
		}
		const match = line.match(/^([a-z][\w]*)\s*(?:=\s*|\s+)([-+\d.][\w.+-]*)(?:\s+.*)?$/i);
		if (!match || !isPlainNumberToken(match[2])) { break; } // Connectivity/basis/next job begins.
		const key = match[1].toLowerCase();
		if (symbols.has(key)) { throw new Error(`Duplicate Z-matrix variable "${match[1]}" at line ${i + 1}.`); }
		symbols.set(key, zmNumber(match[2]));
		symbols.freedoms.set(key, { state: constants ? 'fixed' : 'free' });
	}
	return symbols;
}

interface GaussianCenter extends Atom { dummy?: boolean; label: string; }

function gaussianCenter(fields: string[], centers: GaussianCenter[], symbols: ZMatrixSymbols, units: { length: number; angle: number }): GaussianCenter {
	const label = fields[0] === '-1' ? '-1' : fields[0].split('(')[0].split('-')[0];
	const dummy = /^x\d*$/i.test(label) || label === '-1';
	const ghost = /-bq(?:\(|$)/i.test(fields[0]) || /^bq\d*$/i.test(label);
	const spec = parseGaussianAtomSpec(fields[0]);
	if (!spec && !dummy && !ghost) { throw new Error(`Invalid Gaussian atom "${fields[0]}".`); }
	const sourceIndex = centers.length + 1;
	const atom: GaussianCenter = { element: dummy ? 'X' : /^bq\d*$/i.test(label) ? 'Bq' : spec?.element ?? 'Bq', label, sourceIndex, sourceLabel: fields[0], ghost, dummy, position: [0, 0, 0] };
	const finish = (references: GaussianCenter[]): GaussianCenter => {
		const points = [atom, ...references].map(c => zmPoint(c, `${c.sourceIndex}${c.dummy ? ' (dummy)' : ''}`));
		atom.zmatrix!.indexLabel = String(sourceIndex);
		atom.zmatrix!.entries.forEach((entry, n) => {
			entry.freedom = zmFreedom(entry.source, symbols, 'fixed');
			entry.geometry = zmGeometry(points.slice(0, n + 2));
		});
		return atom;
	};
	const val = (token: string) => zmValue(token, symbols);
	const reference = (token: string): GaussianCenter => {
		if (/^\d+$/.test(token)) {
			const center = centers[Number(token) - 1];
			if (center) { return center; }
		} else {
			const matches = centers.filter(c => c.label.toLowerCase() === token.toLowerCase());
			if (matches.length === 1) { return matches[0]; }
		}
		throw new Error(`Unavailable or ambiguous reference atom "${token}".`);
	};
	let data = fields.slice(1);
	// A zero after the element denotes symbolic Cartesian coordinates. Negative
	// freeze codes are unambiguous; an extra Cartesian freeze field is retained.
	let freeze: number | undefined;
	const explicitCartesian = data.length >= 4 && (data[0] === '0' ||
		(data.length === 4 && /^[+-]?\d+$/.test(data[0]) && (Number(data[0]) < 0 || centers.length === 0)));
	if (explicitCartesian) { freeze = Number(data.shift()); }
	else if (data.length >= 5 && /^-\d+$/.test(data[0])) { freeze = Number(data.shift()); }
	const cartesian = explicitCartesian || data.length === 3 || (data.length > 3 && isPlainNumberToken(data[0]) && !/^\d+$/.test(data[0]));
	if (cartesian) {
		if (data.length < 3) { throw new Error('Incomplete Cartesian coordinate record.'); }
		atom.position = data.slice(0, 3).map(t => val(t) * units.length) as Vec3;
		atom.selectiveDynamics = gaussianFreezeCodeToSelectiveDynamics(freeze);
		if (data.slice(0, 3).some(t => !isPlainNumberToken(t))) {
			atom.zmatrix = { indexLabel: String(sourceIndex), context: 'Cartesian input', entries: data.slice(0, 3).map((t, n) => ({ ...zmEntry(['x', 'y', 'z'][n], t, atom.position[n], 'Å'), freedom: zmFreedom(t, symbols, freeze !== undefined && freeze < 0 ? 'fixed' : 'free') })) };
		}
		return atom;
	}
	const count = Math.min(centers.length, 3);
	if (data.length < 2 * count || (count < 3 && data.length !== 2 * count)) { throw new Error('Incomplete or unsupported Z-matrix atom record.'); }
	if (data.length > 6) {
		if (!/^[+-]?\d+$/.test(data[6])) { throw new Error('Expected Z-matrix format code before trailing atom metadata.'); }
		const format = Number(data[6]);
		if (format === 1 || format === -1) { throw new Error('Gaussian alternate two-angle Z-matrix format is not supported.'); }
		if (format !== 0) { throw new Error(`Unsupported Z-matrix format code ${format}.`); }
	}
	atom.zmatrix = { entries: [] }; // Internal-coordinate freeze flags are not x/y/z locks.
	if (count === 0) { return finish([]); }
	const i = reference(data[0]);
	const r = val(data[1]) * units.length;
	zmCheckInternal(r);
	atom.zmatrix.entries.push(zmEntry(`Distance ${sourceIndex}–${data[0]}`, data[1], r, 'Å'));
	if (count === 1) { atom.position = zmAdd(i.position, [0, 0, r]); return finish([i]); }
	const j = reference(data[2]);
	if (i === j) { throw new Error('Z-matrix references must be distinct.'); }
	const a = val(data[3]) * units.angle;
	atom.zmatrix.entries.push(zmEntry(`Angle ${sourceIndex}–${data[0]}–${data[2]}`, data[3], a / ZM_DEG, '°'));
	if (count === 2) { atom.position = zmThirdGaussian(i.position, j.position, r, a); return finish([i, j]); }
	const k = reference(data[4]);
	if (k === i || k === j) { throw new Error('Z-matrix references must be distinct.'); }
	const b = val(data[5]) * units.angle;
	atom.position = zmInternal(i.position, j.position, k.position, r, a, b);
	atom.zmatrix.entries.push(zmEntry(`Dihedral ${sourceIndex}–${data[0]}–${data[2]}–${data[4]}`, data[5], b / ZM_DEG, '°'));
	return finish([i, j, k]);
}

interface SiestaZRow {
	fields: string[];
	line: number;
	mode: 'cartesian' | 'scaled' | 'fractional';
	molecule?: number;
	local: number;
}

function parseSiestaZmatrix(text: string, lines: FdfLine[], lattice: [Vec3, Vec3, Vec3], latticeConstant: number, species: Map<number, string>, atomicNumbers: Map<number, number>): Atom[] {
	const lengthName = (getFdfStringValue(lines, 'ZM.UnitsLength') ?? 'Bohr').toLowerCase();
	const angleName = (getFdfStringValue(lines, 'ZM.UnitsAngle') ?? 'rad').toLowerCase();
	if (!['bohr', 'ang', 'angstrom'].includes(lengthName)) { throw new Error(`Invalid Z-matrix length units "${lengthName}".`); }
	if (!['rad', 'radians', 'deg', 'degrees'].includes(angleName)) { throw new Error(`Invalid Z-matrix angle units "${angleName}".`); }
	const lengthUnit = lengthName === 'bohr' ? ZM_BOHR : 1;
	const angleUnit = angleName.startsWith('rad') ? 1 : ZM_DEG;
	// Use original lines for diagnostics rather than the comment/blank-stripped FDF list.
	const raw = text.split(/\r?\n/);
	const start = raw.findIndex(line => /^%block\s+/i.test(line.trim()) && normalizeFdfLabel(line.trim().split(/\s+/)[1]) === 'zmatrix');
	const rows: SiestaZRow[] = [];
	const definitions: { fields: string[]; line: number; constraint: boolean; constant: boolean }[] = [];
	let mode: SiestaZRow['mode'] = 'cartesian';
	let section = '', molecule = 0, local = 0, ended = false;
	for (let n = start + 1; n < raw.length; n++) {
		const line = stripFdfComment(raw[n]).trim();
		if (!line) { continue; }
		if (/^%endblock(?:\s|$)/i.test(line)) {
			const name = line.split(/\s+/)[1];
			if (name && normalizeFdfLabel(name) !== 'zmatrix') { throw new Error(`Z-matrix: mismatched endblock at line ${n + 1}.`); }
			ended = true; break;
		}
		const header = line.toLowerCase();
		if (/^molecule(?:[\s_.-]+(?:cartesian|scaled|fractional))?$/.test(header)) {
			section = 'molecule'; molecule++; local = 0;
			mode = header.includes('frac') ? 'fractional' : header.includes('scal') ? 'scaled' : 'cartesian';
			continue;
		}
		if (/^(cartesian|scaled|fractional)$/i.test(line)) {
			section = 'coordinates'; mode = header as SiestaZRow['mode']; local = 0; continue;
		}
		if (/^(variables?|constants?|constraints?)$/i.test(line)) { section = header; continue; }
		const fields = line.split(/[\s,=]+/);
		if (section.startsWith('variable') || section.startsWith('constant') || section.startsWith('constraint')) {
			definitions.push({ fields, line: n + 1, constraint: section.startsWith('constraint'), constant: section.startsWith('constant') });
		} else if (section === 'coordinates' || section === 'molecule') {
			rows.push({ fields, line: n + 1, mode, molecule: section === 'molecule' ? molecule : undefined, local: ++local });
		} else { throw new Error(`Z-matrix: unsupported subsection or missing heading at line ${n + 1}.`); }
	}
	if (!ended) { throw new Error('Missing %endblock Zmatrix.'); }
	if (!rows.length) { throw new Error('No atoms found in Z-matrix.'); }
	const symbols = zmSymbols();
	for (const definition of definitions) {
		try {
			const f = definition.fields;
			if (f.length !== (definition.constraint ? 4 : 2)) { throw new Error('Invalid symbol definition.'); }
			const key = f[0].toLowerCase();
			if (symbols.has(key)) { throw new Error(`Duplicate Z-matrix variable "${f[0]}".`); }
			let value: number;
			if (definition.constraint) {
				const base = symbols.get(f[1].toLowerCase());
				if (base === undefined) { throw new Error(`Constraint dependency "${f[1]}" must already be defined.`); }
				const a = zmNumber(f[2]);
				if (a === 0) { throw new Error('A zero constraint multiplier must be specified as a constant instead.'); }
				value = a * base + zmNumber(f[3]);
				const parent = symbols.freedoms.get(f[1].toLowerCase())!;
				symbols.freedoms.set(key, {
					state: parent.state === 'fixed' ? 'fixed' : 'linked',
					root: parent.root ?? f[1],
					relation: `${f[0]} = ${f[2]} × ${f[1]} + ${f[3]}${parent.relation ? '; ' + parent.relation : ''}`
				});
			} else {
				value = zmNumber(f[1]);
				symbols.freedoms.set(key, { state: definition.constant ? 'fixed' : 'free' });
			}
			if (!Number.isFinite(value)) { throw new Error('Non-finite Z-matrix symbol value.'); }
			symbols.set(key, value);
		} catch (error) { throw new Error(`Z-matrix line ${definition.line}: ${error instanceof Error ? error.message : error}`); }
	}
	const atoms: Atom[] = [];
	const symbolKinds = new Map<string, 'angle' | 'length'>();
	const molecules = new Map<number, Atom[]>();
	const azimuths = new Map<number, number>();
	for (const row of rows) {
		try {
			const f = row.fields;
			const molecular = row.molecule !== undefined;
			const offset = molecular ? 4 : 1;
			if (f.length < offset + 3) { throw new Error('Incomplete coordinate record.'); }
			if (!/^\d+$/.test(f[0]) || !species.has(Number(f[0]))) { throw new Error(`Unknown species index "${f[0]}".`); }
			const speciesIndex = Number(f[0]);
			const atomicNumber = atomicNumbers.get(speciesIndex);
			const ghost = atomicNumber !== undefined && atomicNumber < 0 && atomicNumber > -201;
			const values = f.slice(offset, offset + 3).map((t, k) => {
				if (!isPlainNumberToken(t)) {
					const kind = molecular && row.local > 1 && k > 0 ? 'angle' : 'length';
					const key = t.toLowerCase();
					if (symbolKinds.has(key) && symbolKinds.get(key) !== kind) { throw new Error(`Symbol "${t}" is used as both a length and an angle.`); }
					symbolKinds.set(key, kind);
				}
				return zmValue(t, symbols, false);
			}) as Vec3;
			const atom: Atom = {
				element: (ghost && atomicNumberToSymbol(-atomicNumber!)) || species.get(speciesIndex)!,
				position: [0, 0, 0], fdfSpeciesIndex: speciesIndex, sourceIndex: atoms.length + 1, ghost,
				zmatrix: { indexLabel: molecular ? `${row.local} (local)` : String(atoms.length + 1), context: molecular ? `Molecule ${row.molecule} · local atom ${row.local}` : `${row.mode} input`, entries: [] }
			};
			const entries = atom.zmatrix!.entries;
			// Flags describe optimization in these coordinates, never Cartesian-axis constraints.
			const flags = f.slice(offset + 3, offset + 6);
			if (flags.length && (flags.length !== 3 || flags.some(t => !/^[01]$/.test(t)))) { throw new Error('Expected three Z-matrix variation flags (0 or 1).'); }
			if (!molecular || row.local === 1) {
				if (molecular && f.slice(1, 4).some(t => t !== '0')) { throw new Error('The first molecule atom must use references 0 0 0.'); }
				atom.position = row.mode === 'fractional' ? fractionalToCartesian(values, lattice) : scaleVector(values, row.mode === 'scaled' ? latticeConstant : lengthUnit);
				if (row.mode === 'fractional') { atom.fractionalPosition = values; }
				for (let k = 0; k < 3; k++) {
					entries.push(zmEntry(`${row.mode === 'cartesian' ? '' : row.mode + ' '}${['x', 'y', 'z'][k]}`, f[offset + k], row.mode === 'cartesian' ? atom.position[k] : values[k], row.mode === 'cartesian' ? 'Å' : ''));
				}
			} else {
				const refs = f.slice(1, 4).map(t => /^\d+$/.test(t) ? Number(t) : NaN);
				const previous = molecules.get(row.molecule!) ?? [];
				const needed = Math.min(row.local - 1, 3);
				if (refs.slice(0, needed).some(i => !Number.isInteger(i) || i < 1 || i >= row.local) || new Set(refs.slice(0, needed)).size !== needed || refs.slice(needed).some(i => i !== 0)) {
					throw new Error('Invalid molecule-local reference indices.');
				}
				const [r, a, t] = [values[0] * lengthUnit, values[1] * angleUnit, values[2] * angleUnit];
				zmCheckInternal(r);
				const i = previous[refs[0] - 1].position;
				entries.push(zmEntry(`Distance ${row.local}–${refs[0]}`, f[4], r, 'Å'));
				if (row.local === 2) {
					if (a < 0 || a > Math.PI) { throw new Error('Polar angle must be between 0 and 180 degrees.'); }
					atom.position = zmAdd(i, [r * Math.sin(a) * Math.cos(t), r * Math.sin(a) * Math.sin(t), r * Math.cos(a)]);
					azimuths.set(row.molecule!, t);
					entries.push(zmEntry('Polar angle', f[5], a / ZM_DEG, '°'), zmEntry('Azimuthal angle', f[6], t / ZM_DEG, '°'));
				} else {
					const j = previous[refs[1] - 1].position;
					atom.position = row.local === 3 ? zmThirdSiesta(i, j, r, a, t, azimuths.get(row.molecule!)! - (refs[0] === 1 ? Math.PI : 0)) : zmInternal(i, j, previous[refs[2] - 1].position, r, a, t);
					entries.push(zmEntry(`Angle ${row.local}–${refs[0]}–${refs[1]}`, f[5], a / ZM_DEG, '°'));
					entries.push(zmEntry(`Dihedral ${row.local}–${refs.slice(0, row.local === 3 ? 2 : 3).join('–')}${row.local === 3 ? '–z' : ''}`, f[6], t / ZM_DEG, '°'));
				}
			}
			entries.forEach((entry, k) => {
				// SIESTA variation flags control literals; named symbols are
				// controlled by their definitions, including dependency chains.
				entry.freedom = zmFreedom(entry.source, symbols, flags[k] === '0' ? 'fixed' : 'free');
			});
			if (molecular && row.local > 1) {
				const previous = molecules.get(row.molecule!)!;
				const refs = f.slice(1, 4).map(Number);
				const points = [zmPoint(atom, `${row.local} (local)`), ...refs.filter(n => n > 0).map(n => zmPoint(previous[n - 1], `${n} (local)`))];
				entries[0].geometry = zmGeometry(points.slice(0, 2));
				if (row.local === 2) {
					const origin = points[1].position;
					const r = entries[0].value;
					const auxiliary = (offset: Vec3, label: string): ZMatrixPoint => ({ position: zmAdd(origin, offset), label, auxiliary: true });
					const delta = zmSub(atom.position, origin);
					entries[1].geometry = zmGeometry([auxiliary([0, 0, r], 'z'), points[1], points[0]], 'angle');
					// At the pole, use the input azimuth to draw its reference ray.
					const azimuth = values[2] * angleUnit;
					const projected = Math.hypot(delta[0], delta[1]) > 1e-10 ? [delta[0], delta[1], 0] as Vec3 : [r * Math.cos(azimuth), r * Math.sin(azimuth), 0] as Vec3;
					entries[2].geometry = { ...zmGeometry([auxiliary([r, 0, 0], 'x'), points[1], auxiliary(projected, 'xy projection')], 'angle'), axis: [0, 0, 1] };
				} else {
					entries[1].geometry = zmGeometry(points.slice(0, 3));
					if (row.local === 3) {
						const auxiliary = zmThirdSiesta(points[1].position, points[2].position, 1, Math.PI / 2, 0, azimuths.get(row.molecule!)! - (refs[0] === 1 ? Math.PI : 0));
						points.push({ position: auxiliary, label: 'auxiliary reference', auxiliary: true });
					}
					entries[2].geometry = zmGeometry(points, 'dihedral');
				}
			}
			if (!atom.position.every(Number.isFinite)) { throw new Error('Non-finite converted coordinates.'); }
			atoms.push(atom);
			if (molecular) { const group = molecules.get(row.molecule!) ?? []; group.push(atom); molecules.set(row.molecule!, group); }
		} catch (error) { throw new Error(`Z-matrix line ${row.line}: ${error instanceof Error ? error.message : error}`); }
	}
	const count = getFdfStringValue(lines, 'NumberOfAtoms');
	if (count && Number(count) !== atoms.length) { throw new Error(`Z-matrix: NumberOfAtoms is ${count}, but found ${atoms.length} atoms.`); }
	return atoms;
}
