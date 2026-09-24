const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const THREE = require('three');

const root = path.join(__dirname, '..');
const parser = vm.createContext({ exports: {}, require: () => ({}) });
vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8'), {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText, parser);
const plain = (value) => JSON.parse(JSON.stringify(value));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const poscar = (scale = '1', mode = 'Direct', lattice = '1 0 0\n0 1 0\n0 0 1') =>
	`Test\n${scale}\n${lattice}\nH\n1\n${mode}\n0.5 0.5 0.5\n`;
const qe = (system = 'ibrav=0', cellUnit = 'angstrom', positionUnit = 'alat') =>
	`&SYSTEM ${system} /\nCELL_PARAMETERS ${cellUnit}\n2 0 0\n0 3 0\n0 0 4\nATOMIC_POSITIONS ${positionUnit}\nH 1 0 0\n`;
const fdf = (constraints = '', species = '1 6 C', extra = '') => `
LatticeConstant 2 Ang
AtomicCoordinatesFormat Ang
%block LatticeVectors
1 0 0
0 1 0
0 0 1
%endblock LatticeVectors
%block ChemicalSpeciesLabel
${species}
%endblock ChemicalSpeciesLabel
%block AtomicCoordinatesAndAtomicSpecies
1 0 0 1
0 1 0 1
0 0 1 1
%endblock AtomicCoordinatesAndAtomicSpecies
%block Geometry.Constraints
${constraints}
%endblock Geometry.Constraints
${extra}`;
const gaussian = (body) => `# hf/sto-3g\n\nTest\n\n0 1\n${body}\n\n`;
const parseFdf = (constraints) => plain(parser.parseSiestaFdf(fdf(constraints)));
const flags = (structure) => structure.atoms.map((atom) => atom.selectiveDynamics ?? [true, true, true]);
const free = [true, true, true], fixed = [false, false, false];

test('VASP scales Cartesian components, including off-diagonal lattice entries', () => {
	for (const mode of ['Direct', 'Cartesian']) {
		const s = parser.parseVaspStructureFile(poscar('2 3 4', mode, '1 1 0\n0 1 1\n1 0 1'), 'VASP');
		assert.deepEqual(plain(s.lattice), [[2, 3, 0], [0, 3, 4], [2, 0, 4]]);
		assert.deepEqual(plain(s.atoms[0].position), mode === 'Direct' ? [2, 3, 4] : [1, 1.5, 2]);
	}
	const scalar = parser.parseVaspStructureFile(poscar('2', 'Cartesian'), 'VASP');
	assert.deepEqual(plain(scalar.atoms[0].position), [1, 1, 1]);
});

test('VASP negative scale specifies volume, including a left-handed cell', () => {
	for (const mode of ['Direct', 'Cartesian']) {
		const s = parser.parseVaspStructureFile(poscar('-64', mode, '-2 0 0\n0 2 0\n0 0 2'), 'VASP');
		assert.deepEqual(plain(s.lattice), [[-4, 0, 0], [0, 4, 0], [0, 0, 4]]);
		assert.deepEqual(plain(s.atoms[0].position), mode === 'Direct' ? [-2, 2, 2] : [1, 1, 1]);
	}
	assert.throws(() => parser.parseVaspStructureFile(poscar('-8', 'Direct', '0 0 0\n0 1 0\n0 0 1'), 'VASP'), /target volume/);
});

test('VASP rejects unsupported scaling syntax instead of taking its first value', () => {
	for (const scale of ['2 3', '1 2 3 4', '1 -2 3', '1 0 3']) {
		assert.throws(() => parser.parseVaspStructureFile(poscar(scale), 'VASP'), /scaling/);
	}
});

test('stacked VASP preserves every frame lattice and XDATCAR uses scaling', () => {
	const s = parser.parseVaspStructureFile(poscar('1') + poscar('2'), 'VASP');
	assert.deepEqual(plain(s.frames.map((frame) => frame.lattice[0])), [[1, 0, 0], [2, 0, 0]]);
	assert.deepEqual(plain(s.frames.map((frame) => frame.atoms[0].position)), [[0.5, 0.5, 0.5], [1, 1, 1]]);
	const x = parser.parseVaspStructureFile(poscar('-8').replace('Direct\n', 'Direct configuration= 1\n'), 'XDATCAR');
	assert.deepEqual(plain(x.atoms[0].position), [1, 1, 1]);
});

test('QE derives alat from Angstrom and Bohr cells and preserves explicit scales', () => {
	near(parser.parseQuantumEspressoInput(qe()).atoms[0].position[0], 2);
	near(parser.parseQuantumEspressoInput(qe('ibrav=0', 'bohr')).atoms[0].position[0], 2 * 0.529177210903);
	near(parser.parseQuantumEspressoInput(qe('ibrav=0, A=3.0d0', 'alat')).atoms[0].position[0], 3);
	near(parser.parseQuantumEspressoInput(qe('ibrav=0, celldm(1)=4.0d0', 'alat')).atoms[0].position[0], 4 * 0.529177210903);
	const skew = qe().replace('2 0 0', '3 4 0');
	near(parser.parseQuantumEspressoInput(skew).atoms[0].position[0], 5);
});

test('QE handles omitted cell units and rejects explicit alat without a scale', () => {
	near(parser.parseQuantumEspressoInput(qe('ibrav=0', '')).lattice[0][0], 2 * 0.529177210903);
	near(parser.parseQuantumEspressoInput(qe('ibrav=0, A=3', '')).lattice[0][0], 6);
	assert.throws(() => parser.parseQuantumEspressoInput(qe('ibrav=0', 'alat')), /requires A or celldm/);
	assert.throws(() => parser.parseQuantumEspressoInput(qe('ibrav=0, A=bad', 'alat')), /Invalid QE lattice parameter/);
});

test('QE inline namelists enforce ibrav and respect quoted punctuation', () => {
	assert.throws(() => parser.parseQuantumEspressoInput(qe('ibrav=2, A=3', 'alat')), /ibrav = 2/);
	const input = `&CONTROL prefix='a/!b,c', outdir='./out/' / ! comment\n${qe()}`;
	assert.equal(parser.parseQuantumEspressoInput(input).title, 'a/!b,c');
	const multiline = qe('ibrav=0, A=3', 'alat').replace('&SYSTEM ibrav=0, A=3 /', '&SYSTEM\nibrav=0\nA=3 /');
	near(parser.parseQuantumEspressoInput(multiline).atoms[0].position[0], 3);
});

test('FDF normalizes labels and block whitespace without changing values', () => {
	const input = fdf('atom 1').replace('LatticeConstant', 'lattice_constant')
		.replace('AtomicCoordinatesFormat', 'ATOMIC-COORDINATES-FORMAT')
		.replaceAll('Geometry.Constraints', 'GeometryConstraints')
		.replaceAll('LatticeVectors', 'Lattice.Vectors')
		.replaceAll('%block ', '%BLOCK\t');
	const s = plain(parser.parseSiestaFdf(input));
	assert.deepEqual(s.lattice[0], [2, 0, 0]);
	assert.deepEqual(s.atoms[0].position, [1, 0, 0]);
	assert.deepEqual(s.atoms[0].selectiveDynamics, fixed);
	const duplicate = fdf().replace('LatticeConstant 2 Ang', 'Lattice_Constant 3 Ang\nLatticeConstant 2 Ang');
	assert.equal(parser.parseSiestaFdf(duplicate).lattice[0][0], 3);
	assert.throws(() => parser.parseSiestaFdf(fdf('', '1 6 C', '%block Z_matrix\nunsupported\n%endblock Z_matrix')), /Z-matrix/);
});

test('FDF maps ordinary atomic numbers independently of species labels', () => {
	for (const label of ['Si_surface', 'Carbon', 'custom']) {
		assert.equal(parser.parseSiestaFdf(fdf('', `1 14 ${label}`)).atoms[0].element, 'Si');
	}
	assert.deepEqual(flags(plain(parser.parseSiestaFdf(fdf('Z 14', '1 14 arbitrary')))), [fixed, fixed, fixed]);
});

test('FDF accepts plain and compact comma/range index lists', () => {
	for (const selector of ['1 2', '[1,2]', '[1, 2]', '[1--2]', 'from 1 to 2']) {
		assert.deepEqual(flags(parseFdf(`atom ${selector}`)), [fixed, fixed, free], selector);
	}
	assert.deepEqual(flags(parseFdf('atom [1--3 step 2]')), [fixed, free, fixed]);
	assert.deepEqual(flags(parseFdf('atom 1 2 1.0 0.0 0.0')), [[false, true, true], [false, true, true], free]);
	assert.throws(() => parseFdf('atom [1.5,2]'), /Invalid/);
});

test('FDF keeps projected vectors separate from axis constraints', () => {
	const s = parseFdf('atom 1 1.0 1.0 0.0\natom 2 0.0 0.0 -1.0');
	assert.equal(s.atoms[0].selectiveDynamics, undefined);
	assert.deepEqual(s.atoms[0].projectedForceConstraints, [[1, 1, 0]]);
	assert.deepEqual(s.atoms[1].selectiveDynamics, [true, true, false]);
});

test('FDF clear and clear-prev remove the intended effects only', () => {
	assert.deepEqual(flags(parseFdf('atom all\natom 1 1.0 0.0 0.0\nclear-prev 1')), [fixed, fixed, fixed]);
	assert.deepEqual(flags(parseFdf('atom all\natom 1 1.0 0.0 0.0\nclear 1 2')), [free, free, fixed]);
	assert.deepEqual(flags(parseFdf('atom all\nstress 1 2\nclear-prev 1\nclear-prev 2')), [free, free, fixed]);
	assert.deepEqual(flags(parseFdf('atom all clear-prev [1,2]')), [free, free, fixed]);
	assert.deepEqual(flags(parseFdf('atom 1\nZ 8\nclear-prev 1')), [fixed, free, free]);
	const s = parseFdf('atom 1 1.0 1.0 0.0\natom 2\nclear 1');
	assert.equal(s.atoms[0].projectedForceConstraints, undefined);
	assert.deepEqual(flags(s), [free, fixed, free]);
});

test('Gaussian returns partial atoms with a line-specific warning', () => {
	for (const row of ['C 1 1.0', 'O invalid 0 0']) {
		const s = parser.parseGaussianGjf(gaussian(`H 0.0 0.0 0.0\n${row}\nH 1.0 0.0 0.0`));
		assert.equal(s.atoms.length, 1);
		assert.match(s.warning, /Partial structure: only the first 1 atom\(s\)/);
		assert.match(s.warning, /line 7/);
	}
	assert.equal(parser.parseGaussianGjf(gaussian('H 0.0 0.0 0.0')).warning, undefined);
	assert.throws(() => parser.parseGaussianGjf(gaussian('H')), /does not appear/);
});

// Exercise real Three.js objects without creating a WebGL context or launching VS Code.
function viewerContext() {
	let receive;
	const context = vm.createContext({ THREE,
		window: { innerWidth: 1000, innerHeight: 800, addEventListener: (_, fn) => { receive = fn; } },
		document: { createElement: () => ({ getContext: () => ({ clearRect() {}, fillText() {} }) }) }
	});
	const source = fs.readFileSync(path.join(root, 'media/main.js'), 'utf8')
		.replace(/^import .*;\r?\n/gm, '').replace(/^initViewer\(\);$/m, '');
	vm.runInContext(source, context);
	vm.runInContext(`
		scene = new THREE.Scene(); axisScene = new THREE.Scene();
		camera = new THREE.OrthographicCamera(); controls = { target: new THREE.Vector3(), update() {} };
		statusElement = { style: {}, textContent: '' }; hoverElement = { style: {} };
		frameSliderContainer = { style: {} }; frameSlider = {}; frameLabel = {}; playPauseButton = {};
		globalThis.state = () => ({ meshes: atomMeshes.slice(), bonds: currentBondGroup, axes: latticeAxisGroup, status: statusElement.textContent, frame: getCurrentFrameStructure() });
		globalThis.selectFrame = (index) => { currentFrameIndex = index; renderCurrentFrame({ preserveCamera: true }); };
	`, context);
	return { context, show: (structure) => receive({ data: { command: 'showStructure', structure } }), state: () => context.state() };
}

test('viewer reuses compatible meshes and redraws when a frame lattice changes', () => {
	const viewer = viewerContext();
	const s = plain(parser.parseVaspStructureFile(poscar('1') + poscar('2'), 'VASP'));
	viewer.show(s);
	const first = viewer.state().meshes[0];
	let disposed = false;
	first.geometry.addEventListener('dispose', () => { disposed = true; });
	viewer.context.selectFrame(1);
	assert.notEqual(viewer.state().meshes[0], first);
	assert.equal(disposed, true);
	assert.deepEqual(plain(viewer.state().frame.lattice[0]), [2, 0, 0]);
	const second = viewer.state().meshes[0];
	s.frames[1].atoms[0].position = [1.5, 1, 1];
	s.frames[1].atoms[0].selectiveDynamics = [false, true, true];
	viewer.context.selectFrame(1);
	assert.equal(viewer.state().meshes[0], second);
	assert.deepEqual(second.position.toArray(), [1.5, 1, 1]);
	assert.equal(second.material.opacity, 0.55);
	viewer.show(s);
	assert.equal(viewer.state().meshes[0], second, 'live refresh must compare the selected frame lattice');
});

test('viewer disposes removed axis resources on replacement and lattice removal', () => {
	const viewer = viewerContext();
	const s = plain(parser.parseVaspStructureFile(poscar(), 'VASP'));
	viewer.show(s);
	for (const lattice of [[[2, 0, 0], [0, 2, 0], [0, 0, 2]], undefined]) {
		const group = viewer.state().axes;
		const resources = new Set();
		group.traverse((object) => [object.geometry, object.material, object.material?.map].filter(Boolean).forEach((r) => resources.add(r)));
		const disposed = new Set();
		for (const resource of resources) resource.addEventListener('dispose', () => disposed.add(resource));
		viewer.show({ ...s, lattice });
		assert.equal(group.parent, null);
		assert.equal(disposed.size, resources.size);
	}
	assert.equal(viewer.state().axes, undefined);
});

test('viewer displays Gaussian warning persistently and clears it on valid input', () => {
	const viewer = viewerContext();
	const partial = plain(parser.parseGaussianGjf(gaussian('H 0.0 0.0 0.0\nC 1 1.0')));
	viewer.show(partial);
	assert.equal(viewer.state().meshes.length, 1);
	assert.equal(viewer.state().status, partial.warning);
	viewer.context.selectFrame(0);
	assert.equal(viewer.state().status, partial.warning);
	viewer.show(plain(parser.parseGaussianGjf(gaussian('H 0.0 0.0 0.0'))));
	assert.equal(viewer.state().status, '');
});
