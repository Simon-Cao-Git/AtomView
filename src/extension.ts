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
	element: string;
	position: Vec3; // Cartesian coordinates in Angstrom
	fractionalPosition?: Vec3;
	selectiveDynamics?: [boolean, boolean, boolean];
	fdfSpeciesIndex?: number;
	projectedForceConstraints?: Vec3[];
}

interface TrajectoryFrame {
	index: number;
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
				'Open a POSCAR, CONTCAR, XDATCAR, .vasp, .fdf, .gjf, or .in file to preview it.'
			);
			return;
		}

		this.updateFromDocument(document);
	}

	private updateFromDocument(document: vscode.TextDocument) {
		const fileName = document.fileName.split(/[\\/]/).pop() ?? '';
		const text = document.getText();
		const detectedFormat = detectFormat(fileName, text);

		if (!detectedFormat) {
			this.postStatus(
				`Source file is ${fileName}. Open a supported atomistic structure/input file to preview it.`
			);
			return;
		}

		try {
			const structure = parseStructureFile(text, detectedFormat);
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

			this.postStatus(`Failed to parse ${fileName}: ${message}`);
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

/* -------------------------------------------------------------------------- */
/* SIESTA FDF                                                                 */
/* -------------------------------------------------------------------------- */

function parseSiestaFdf(text: string): AtomicStructure {
	const lines = preprocessFdfLines(text);

	if (hasFdfBlock(lines, 'ZMATRIX')) {
		throw new Error('SIESTA Z-matrix input is not supported yet. AtomView currently supports only explicit x y z coordinates via %block AtomicCoordinatesAndAtomicSpecies.');
	}

	const title =
		getFdfStringValue(lines, 'SystemName') ??
		getFdfStringValue(lines, 'SystemLabel') ??
		'SIESTA FDF';

	const latticeConstant = parseFdfLatticeConstant(lines);
	const lattice = parseFdfLattice(lines, latticeConstant);
	const speciesMap = parseFdfSpeciesMap(lines);
	const speciesAtomicNumbers = parseFdfSpeciesAtomicNumberMap(lines);
	const coordinateFormat = parseFdfCoordinateFormat(lines);
	const atoms = parseFdfAtoms(
		lines,
		speciesMap,
		lattice,
		latticeConstant,
		coordinateFormat
	);

	applyFdfGeometryConstraints(lines, atoms, speciesAtomicNumbers);

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
	const lowerKey = key.toLowerCase();
	const line = lines.find((entry) => {
		const tokens = entry.lower.split(/\s+/);
		return tokens[0] === lowerKey;
	});

	if (!line) {
		return undefined;
	}

	return line.clean.split(/\s+/).slice(1).join(' ') || undefined;
}

function getFdfBlock(lines: FdfLine[], blockName: string): string[] | undefined {
	const lowerBlockName = blockName.toLowerCase();

	const startIndex = lines.findIndex((line) =>
		line.lower === `%block ${lowerBlockName}`
	);

	if (startIndex < 0) {
		return undefined;
	}

	const blockLines: string[] = [];

	for (let index = startIndex + 1; index < lines.length; index++) {
		if (lines[index].lower === `%endblock ${lowerBlockName}`) {
			return blockLines;
		}

		blockLines.push(lines[index].clean);
	}

	throw new Error(`Missing %endblock ${blockName}.`);
}

function hasFdfBlock(lines: FdfLine[], blockName: string): boolean {
	const lowerBlockName = blockName.toLowerCase();
	return lines.some((line) => line.lower === `%block ${lowerBlockName}`);
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
		const label = tokens[2];

		if (Number.isInteger(speciesIndex) && label) {
			speciesMap.set(speciesIndex, normalizeElementSymbol(label));
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
		throw new Error('Missing %block AtomicCoordinatesAndAtomicSpecies. AtomView currently supports only explicit SIESTA x y z coordinate blocks, not Z-matrix-style structure definitions.');
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

	if (['center', 'rigid', 'molecule', 'rigid-max', 'molecule-max', 'stress', 'cell-vector', 'cell-angle', 'routine'].includes(selector)) {
		return {
			atomIndices: [],
			nextIndex: tokens.length
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
		const first = parseInt(tokens[startIndex + 1], 10);
		const rangeMode = tokens[startIndex + 2]?.toLowerCase();
		const rangeValue = parseInt(tokens[startIndex + 3], 10);
		let step = 1;
		let nextIndex = startIndex + 4;

		if (!Number.isInteger(first) || !Number.isInteger(rangeValue)) {
			throw new Error('Invalid Geometry.Constraints "from ..." selector.');
		}

		if (tokens[nextIndex]?.toLowerCase() === 'step') {
			step = parseInt(tokens[nextIndex + 1], 10);
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
			const first = parseInt(tokens[index], 10);

			if (!Number.isInteger(first)) {
				throw new Error('Invalid Geometry.Constraints bracketed index selector.');
			}

			if (tokens[index + 1] === '--') {
				const last = parseInt(tokens[index + 2], 10);
				let step = 1;
				index += 3;

				if (tokens[index]?.toLowerCase() === 'step') {
					step = parseInt(tokens[index + 1], 10);
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
		return {
			indices: [oneBasedIndexToZeroBased(parseInt(tokens[startIndex], 10), maxIndex)],
			nextIndex: startIndex + 1
		};
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

function findFdfLine(lines: FdfLine[], key: string): FdfLine | undefined {
	const lowerKey = key.toLowerCase();

	return lines.find((entry) => {
		const tokens = entry.lower.split(/\s+/);
		return tokens[0] === lowerKey;
	});
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
		throw new Error('No Cartesian atoms found in Gaussian molecule specification.');
	}

	const lattice = gaussianTranslationVectorsToLattice(moleculeSpecification.translationVectors);

	return {
		title: parseGaussianTitle(rawLines) ?? 'Gaussian input',
		...(lattice ? { lattice } : {}),
		atoms: moleculeSpecification.atoms,
		coordinateMode: 'Cartesian',
		sourceFormat: 'GJF'
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
	const tokens = line.trim().split(/\s+/);

	if (tokens.length < 2 || tokens.length % 2 !== 0) {
		return false;
	}

	return tokens.every((token) => /^[-+]?\d+$/.test(token));
}

function parseGaussianMoleculeSpecification(
	rawLines: string[],
	startIndex: number
): GaussianMoleculeSpecification {
	const atoms: Atom[] = [];
	const translationVectors: Vec3[] = [];

	for (let index = startIndex; index < rawLines.length; index++) {
		const line = stripGaussianComment(rawLines[index]).trim();

		if (line.length === 0) {
			break;
		}

		const translationVector = parseGaussianTranslationVectorLine(line);

		if (translationVector) {
			translationVectors.push(translationVector);
			continue;
		}

		const atom = parseGaussianCartesianAtomLine(line);

		if (!atom) {
			if (atoms.length === 0) {
				throw new Error(
					'Gaussian molecule specification does not appear to be supported Cartesian x y z format. AtomView does not currently support Gaussian Z-matrix or mixed internal-coordinate molecule specifications.'
				);
			}

			break;
		}

		atoms.push(atom);
	}

	return { atoms, translationVectors };
}

function stripGaussianComment(line: string): string {
	const commentIndex = line.indexOf('!');
	return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function parseGaussianTranslationVectorLine(line: string): Vec3 | undefined {
	const tokens = line.trim().split(/\s+/);

	if (tokens.length < 4 || tokens[0].toUpperCase() !== 'TV') {
		return undefined;
	}

	const vector: Vec3 = [
		Number(tokens[1]),
		Number(tokens[2]),
		Number(tokens[3])
	];

	if (vector.some((value) => !Number.isFinite(value))) {
		throw new Error(`Invalid Gaussian TV line: ${line}`);
	}

	return vector;
}

function parseGaussianCartesianAtomLine(line: string): Atom | undefined {
	const tokens = line.trim().split(/\s+/);

	if (tokens.length < 4) {
		return undefined;
	}

	const atomSpec = parseGaussianAtomSpec(tokens[0]);

	if (!atomSpec) {
		return undefined;
	}

	let coordinateStartIndex = 1;
	let freezeCode: number | undefined;

	if (tokens.length >= 5) {
		freezeCode = parseGaussianFreezeCode(tokens[coordinateStartIndex]);

		if (freezeCode !== undefined) {
			coordinateStartIndex += 1;
		}
	}

	const coordinateTokens = tokens.slice(coordinateStartIndex, coordinateStartIndex + 3);

	if (coordinateTokens.length < 3 || !coordinateTokens.every(isPlainNumberToken)) {
		return undefined;
	}

	const position: Vec3 = [
		gaussianNumberToNumber(coordinateTokens[0]),
		gaussianNumberToNumber(coordinateTokens[1]),
		gaussianNumberToNumber(coordinateTokens[2])
	];

	if (position.some((value) => !Number.isFinite(value))) {
		return undefined;
	}

	return {
		element: atomSpec.element,
		selectiveDynamics: gaussianFreezeCodeToSelectiveDynamics(freezeCode),
		position
	};
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

function parseGaussianFreezeCode(token: string | undefined): number | undefined {
	if (!token || !/^[-+]?\d+$/.test(token)) {
		return undefined;
	}

	return Number(token);
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

	const alat = parseQeAlatAngstrom(systemValues);
	const lattice = parseQeLattice(lines, alat);
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
			const commentIndex = line.indexOf('!');
			return commentIndex >= 0 ? line.slice(0, commentIndex).trim() : line.trim();
		})
		.filter((line) => line.length > 0);
}

function parseQeNamelist(lines: string[], name: string): Map<string, string> {
	const values = new Map<string, string>();
	const lowerName = `&${name.toLowerCase()}`;
	const startIndex = lines.findIndex((line) => line.toLowerCase().startsWith(lowerName));

	if (startIndex < 0) {
		return values;
	}

	for (let index = startIndex + 1; index < lines.length; index++) {
		const line = lines[index];

		if (line.trim() === '/') {
			break;
		}

		for (const assignment of line.split(',')) {
			const match = assignment.match(/^\s*([a-zA-Z0-9_().]+)\s*=\s*(.+?)\s*$/);

			if (!match) {
				continue;
			}

			values.set(
				match[1].toLowerCase(),
				match[2].replace(/^['"]|['"]$/g, '').trim()
			);
		}
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

function parseQeAlatAngstrom(systemValues: Map<string, string>): number {
	const aValue = systemValues.get('a');

	if (aValue !== undefined) {
		const a = Number(aValue);
		if (Number.isFinite(a)) {
			return a;
		}
	}

	const celldm1Value = systemValues.get('celldm(1)');

	if (celldm1Value !== undefined) {
		const celldm1 = Number(celldm1Value);
		if (Number.isFinite(celldm1)) {
			return celldm1 * lengthUnitToAngstrom('Bohr');
		}
	}

	return 1.0;
}

function parseQeLattice(lines: string[], alat: number): [Vec3, Vec3, Vec3] {
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
	const unit = parseQeHeaderUnit(header) ?? 'alat';
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

function qeLengthScaleToAngstrom(unit: string, alat: number): number {
	const normalized = unit.toLowerCase();

	if (normalized.startsWith('ang')) {
		return 1.0;
	}

	if (normalized.startsWith('bohr')) {
		return lengthUnitToAngstrom('Bohr');
	}

	if (normalized.startsWith('alat')) {
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