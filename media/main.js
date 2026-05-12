import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let scene;
let camera;
let renderer;
let controls;
let currentStructureGroup;
let statusElement;
let latestStructure;

const BALL_RADIUS_SCALE = 0.4;
const BOND_RADIUS = 0.06;
const BOND_THRESHOLD_SCALE = 1.1;

initViewer();

window.addEventListener('message', (event) => {
	const message = event.data;

	if (message.command === 'showStatus') {
		showStatus(message.text);
		return;
	}

	if (message.command === 'showStructure') {
		latestStructure = message.structure;
		showStatus('');
		renderStructure(latestStructure);
	}
});

function initViewer() {
	document.body.innerHTML = '';
	document.body.style.margin = '0';
	document.body.style.overflow = 'hidden';
	document.body.style.background = '#000000';

	const container = document.createElement('div');
	container.style.width = '100vw';
	container.style.height = '100vh';
	document.body.appendChild(container);

	statusElement = document.createElement('pre');
	statusElement.style.position = 'absolute';
	statusElement.style.left = '16px';
	statusElement.style.top = '16px';
	statusElement.style.color = 'var(--vscode-foreground)';
	statusElement.style.display = 'none';
	document.body.appendChild(statusElement);

	scene = new THREE.Scene();
	scene.background = new THREE.Color(0x000000);

	camera = new THREE.OrthographicCamera(-5, 5, 5, -5, -10000, 10000);

	renderer = new THREE.WebGLRenderer({ antialias: true });
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(window.innerWidth, window.innerHeight);
	container.appendChild(renderer.domElement);

	controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = false;
	controls.screenSpacePanning = true;

	scene.add(new THREE.AmbientLight(0xffffff, 0.85));

	const directionalLight = new THREE.DirectionalLight(0xffffff, 0.65);
	directionalLight.position.set(5, 5, 8);
	scene.add(directionalLight);

	window.addEventListener('resize', () => {
		renderer.setSize(window.innerWidth, window.innerHeight);
		if (latestStructure) {
			fitCameraToStructure(latestStructure);
		}
	});

	animate();
}

function animate() {
	requestAnimationFrame(animate);
	controls.update();
	renderer.render(scene, camera);
}

function showStatus(text) {
	statusElement.textContent = text;
	statusElement.style.display = text ? 'block' : 'none';
}

function renderStructure(structure) {
	if (currentStructureGroup) {
		scene.remove(currentStructureGroup);
	}

	currentStructureGroup = new THREE.Group();

	drawBonds(structure, currentStructureGroup);
	drawAtoms(structure, currentStructureGroup);
	drawUnitCell(structure.lattice, currentStructureGroup);

	scene.add(currentStructureGroup);
	fitCameraToStructure(structure);
}

function drawAtoms(structure, group) {
	for (const atom of structure.atoms) {
		const element = getElementData(atom.element);
		const radius = BALL_RADIUS_SCALE * element.covalentRadius;

		const geometry = new THREE.SphereGeometry(radius, 32, 16);
		const isConstrained = isAtomConstrained(atom);
		const atomColor = isConstrained
			? makePalerColor(element.color)
			: element.color;

		const material = new THREE.MeshStandardMaterial({
			color: atomColor,
			roughness: 0.55,
			metalness: 0.05,
			transparent: isConstrained,
			opacity: isConstrained ? 0.55 : 1.0
		});

		const sphere = new THREE.Mesh(geometry, material);
		sphere.position.set(atom.position[0], atom.position[1], atom.position[2]);

		group.add(sphere);
	}
}

function isAtomConstrained(atom) {
	return Array.isArray(atom.selectiveDynamics) &&
		atom.selectiveDynamics.some((canMove) => !canMove);
}

function makePalerColor(color) {
	return color.clone().lerp(new THREE.Color(0xffffff), 0.55);
}

function drawBonds(structure, group) {
	for (let i = 0; i < structure.atoms.length; i++) {
		for (let j = i + 1; j < structure.atoms.length; j++) {
			const atomA = structure.atoms[i];
			const atomB = structure.atoms[j];

			const elementA = getElementData(atomA.element);
			const elementB = getElementData(atomB.element);

			const positionA = new THREE.Vector3(...atomA.position);
			const positionB = new THREE.Vector3(...atomB.position);

			const distance = positionA.distanceTo(positionB);
			const threshold =
				BOND_THRESHOLD_SCALE *
				(elementA.covalentRadius + elementB.covalentRadius);

			if (distance > 1e-8 && distance < threshold) {
				group.add(createBondCylinder(positionA, positionB));
			}
		}
	}
}

function createBondCylinder(start, end) {
	const direction = new THREE.Vector3().subVectors(end, start);
	const length = direction.length();
	const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);

	const geometry = new THREE.CylinderGeometry(BOND_RADIUS, BOND_RADIUS, length, 16);
	const material = new THREE.MeshStandardMaterial({
		color: 0xd0d0d0,
		roughness: 0.6,
		metalness: 0.0
	});

	const cylinder = new THREE.Mesh(geometry, material);
	cylinder.position.copy(midpoint);

	const yAxis = new THREE.Vector3(0, 1, 0);
	cylinder.quaternion.setFromUnitVectors(yAxis, direction.clone().normalize());

	return cylinder;
}

function drawUnitCell(lattice, group) {
	const a = new THREE.Vector3(...lattice[0]);
	const b = new THREE.Vector3(...lattice[1]);
	const c = new THREE.Vector3(...lattice[2]);

	const corners = [
		new THREE.Vector3(0, 0, 0),
		a,
		b,
		c,
		a.clone().add(b),
		a.clone().add(c),
		b.clone().add(c),
		a.clone().add(b).add(c)
	];

	const edges = [
		[0, 1], [0, 2], [0, 3],
		[1, 4], [1, 5],
		[2, 4], [2, 6],
		[3, 5], [3, 6],
		[4, 7], [5, 7], [6, 7]
	];

	const points = [];
	for (const [i, j] of edges) {
		points.push(corners[i], corners[j]);
	}

	const geometry = new THREE.BufferGeometry().setFromPoints(points);
	const material = new THREE.LineBasicMaterial({ color: 0xffffff });
	group.add(new THREE.LineSegments(geometry, material));
}

function fitCameraToStructure(structure) {
	if (!currentStructureGroup) {
		return;
	}

	currentStructureGroup.position.set(0, 0, 0);

	const box = new THREE.Box3().setFromObject(currentStructureGroup);
	const center = box.getCenter(new THREE.Vector3());
	const size = box.getSize(new THREE.Vector3());

	currentStructureGroup.position.sub(center);

	const a = new THREE.Vector3(...structure.lattice[0]);
	const b = new THREE.Vector3(...structure.lattice[1]);

	let normal = new THREE.Vector3().crossVectors(a, b);
	if (normal.lengthSq() < 1e-12) {
		normal = new THREE.Vector3(0, 0, 1);
	} else {
		normal.normalize();
	}

	const maxDim = Math.max(size.x, size.y, size.z, 1);
	const distance = maxDim * 4;

	camera.position.copy(normal.multiplyScalar(distance));
	camera.up.copy(b.clone().normalize());
	camera.lookAt(0, 0, 0);

	const aspect = window.innerWidth / window.innerHeight;
	const viewSize = maxDim * 1.25;

	camera.left = (-viewSize * aspect) / 2;
	camera.right = (viewSize * aspect) / 2;
	camera.top = viewSize / 2;
	camera.bottom = -viewSize / 2;
	camera.near = -distance * 10;
	camera.far = distance * 10;
	camera.updateProjectionMatrix();

	controls.target.set(0, 0, 0);
	controls.update();
}

function getElementData(symbol) {
	return ELEMENT_DATA[symbol] ?? {
		covalentRadius: 0.75,
		color: new THREE.Color(0.7, 0.7, 0.7)
	};
}

const ELEMENT_DATA = {
	H: { covalentRadius: 0.46, color: new THREE.Color(1.00000, 0.80000, 0.80000) },
	He: { covalentRadius: 1.22, color: new THREE.Color(0.98907, 0.91312, 0.81091) },
	Li: { covalentRadius: 1.57, color: new THREE.Color(0.52731, 0.87953, 0.45670) },
	Be: { covalentRadius: 1.12, color: new THREE.Color(0.37147, 0.84590, 0.48292) },
	B: { covalentRadius: 0.81, color: new THREE.Color(0.12490, 0.63612, 0.05948) },
	C: { covalentRadius: 0.77, color: new THREE.Color(0.50430, 0.28659, 0.16236) },
	N: { covalentRadius: 0.74, color: new THREE.Color(0.69139, 0.72934, 0.90280) },
	O: { covalentRadius: 0.74, color: new THREE.Color(0.99997, 0.01328, 0.00000) },
	F: { covalentRadius: 0.72, color: new THREE.Color(0.69139, 0.72934, 0.90280) },
	Ne: { covalentRadius: 1.60, color: new THREE.Color(0.99954, 0.21788, 0.71035) },
	Na: { covalentRadius: 1.91, color: new THREE.Color(0.97955, 0.86618, 0.23787) },
	Mg: { covalentRadius: 1.60, color: new THREE.Color(0.98773, 0.48452, 0.08470) },
	Al: { covalentRadius: 1.43, color: new THREE.Color(0.50718, 0.70056, 0.84062) },
	Si: { covalentRadius: 1.18, color: new THREE.Color(0.10596, 0.23226, 0.98096) },
	P: { covalentRadius: 1.10, color: new THREE.Color(0.75557, 0.61256, 0.76425) },
	S: { covalentRadius: 1.04, color: new THREE.Color(1.00000, 0.98071, 0.00000) },
	Cl: { covalentRadius: 0.99, color: new THREE.Color(0.19583, 0.98828, 0.01167) },
	Ar: { covalentRadius: 1.92, color: new THREE.Color(0.81349, 0.99731, 0.77075) },
	K: { covalentRadius: 2.35, color: new THREE.Color(0.63255, 0.13281, 0.96858) },
	Ca: { covalentRadius: 1.97, color: new THREE.Color(0.35642, 0.58863, 0.74498) },
	Sc: { covalentRadius: 1.64, color: new THREE.Color(0.71209, 0.38930, 0.67279) },
	Ti: { covalentRadius: 1.47, color: new THREE.Color(0.47237, 0.79393, 1.00000) },
	V: { covalentRadius: 1.35, color: new THREE.Color(0.90000, 0.10000, 0.00000) },
	Cr: { covalentRadius: 1.29, color: new THREE.Color(0.00000, 0.00000, 0.62000) },
	Mn: { covalentRadius: 1.37, color: new THREE.Color(0.66148, 0.03412, 0.62036) },
	Fe: { covalentRadius: 1.26, color: new THREE.Color(0.71051, 0.44662, 0.00136) },
	Co: { covalentRadius: 1.25, color: new THREE.Color(0.00000, 0.00000, 0.68666) },
	Ni: { covalentRadius: 1.25, color: new THREE.Color(0.72032, 0.73631, 0.74339) },
	Cu: { covalentRadius: 1.28, color: new THREE.Color(0.13390, 0.28022, 0.86606) },
	Zn: { covalentRadius: 1.37, color: new THREE.Color(0.56123, 0.56445, 0.50799) },
	Ga: { covalentRadius: 1.53, color: new THREE.Color(0.62292, 0.89293, 0.45486) },
	Ge: { covalentRadius: 1.22, color: new THREE.Color(0.49557, 0.43499, 0.65193) },
	As: { covalentRadius: 1.21, color: new THREE.Color(0.45814, 0.81694, 0.34249) },
	Se: { covalentRadius: 1.04, color: new THREE.Color(0.60420, 0.93874, 0.06122) },
	Br: { covalentRadius: 1.14, color: new THREE.Color(0.49645, 0.19333, 0.01076) },
	Kr: { covalentRadius: 1.98, color: new THREE.Color(0.98102, 0.75805, 0.95413) },
	Rb: { covalentRadius: 2.50, color: new THREE.Color(1.00000, 0.00000, 0.60000) },
	Sr: { covalentRadius: 2.15, color: new THREE.Color(0.00000, 1.00000, 0.15259) },
	Y: { covalentRadius: 1.82, color: new THREE.Color(0.40259, 0.59739, 0.55813) },
	Zr: { covalentRadius: 1.60, color: new THREE.Color(0.00000, 1.00000, 0.00000) },
	Nb: { covalentRadius: 1.47, color: new THREE.Color(0.29992, 0.70007, 0.46459) },
	Mo: { covalentRadius: 1.40, color: new THREE.Color(0.70584, 0.52602, 0.68925) },
	Tc: { covalentRadius: 1.35, color: new THREE.Color(0.80574, 0.68699, 0.79478) },
	Ru: { covalentRadius: 1.34, color: new THREE.Color(0.81184, 0.72113, 0.68089) },
	Rh: { covalentRadius: 1.34, color: new THREE.Color(0.80748, 0.82205, 0.67068) },
	Pd: { covalentRadius: 1.37, color: new THREE.Color(0.75978, 0.76818, 0.72454) },
	Ag: { covalentRadius: 1.44, color: new THREE.Color(0.72032, 0.73631, 0.74339) },
	Cd: { covalentRadius: 1.52, color: new THREE.Color(0.95145, 0.12102, 0.86354) },
	In: { covalentRadius: 1.67, color: new THREE.Color(0.84378, 0.50401, 0.73483) },
	Sn: { covalentRadius: 1.58, color: new THREE.Color(0.60764, 0.56052, 0.72926) },
	Sb: { covalentRadius: 1.41, color: new THREE.Color(0.84627, 0.51498, 0.31315) },
	Te: { covalentRadius: 1.37, color: new THREE.Color(0.67958, 0.63586, 0.32038) },
	I: { covalentRadius: 1.33, color: new THREE.Color(0.55914, 0.12200, 0.54453) },
	Xe: { covalentRadius: 2.18, color: new THREE.Color(0.60662, 0.63218, 0.97305) },
	Cs: { covalentRadius: 2.72, color: new THREE.Color(0.05872, 0.99922, 0.72578) },
	Ba: { covalentRadius: 2.24, color: new THREE.Color(0.11835, 0.93959, 0.17565) },
	La: { covalentRadius: 1.88, color: new THREE.Color(0.35340, 0.77057, 0.28737) },
	Ce: { covalentRadius: 1.82, color: new THREE.Color(0.82055, 0.99071, 0.02374) },
	Pr: { covalentRadius: 1.82, color: new THREE.Color(0.99130, 0.88559, 0.02315) },
	Nd: { covalentRadius: 1.82, color: new THREE.Color(0.98701, 0.55560, 0.02744) },
	Pm: { covalentRadius: 1.81, color: new THREE.Color(0.00000, 0.00000, 0.96000) },
	Sm: { covalentRadius: 1.81, color: new THREE.Color(0.99042, 0.02403, 0.49195) },
	Eu: { covalentRadius: 2.06, color: new THREE.Color(0.98367, 0.03078, 0.83615) },
	Gd: { covalentRadius: 1.79, color: new THREE.Color(0.75325, 0.01445, 1.00000) },
	Tb: { covalentRadius: 1.77, color: new THREE.Color(0.44315, 0.01663, 0.99782) },
	Dy: { covalentRadius: 1.77, color: new THREE.Color(0.19390, 0.02374, 0.99071) },
	Ho: { covalentRadius: 1.76, color: new THREE.Color(0.02837, 0.25876, 0.98608) },
	Er: { covalentRadius: 1.75, color: new THREE.Color(0.28688, 0.45071, 0.23043) },
	Tm: { covalentRadius: 1.00, color: new THREE.Color(0.00000, 0.00000, 0.88000) },
	Yb: { covalentRadius: 1.94, color: new THREE.Color(0.15323, 0.99165, 0.95836) },
	Lu: { covalentRadius: 1.72, color: new THREE.Color(0.15097, 0.99391, 0.71032) },
	Hf: { covalentRadius: 1.59, color: new THREE.Color(0.70704, 0.70552, 0.35090) },
	Ta: { covalentRadius: 1.47, color: new THREE.Color(0.71952, 0.60694, 0.33841) },
	W: { covalentRadius: 1.41, color: new THREE.Color(0.55616, 0.54257, 0.50178) },
	Re: { covalentRadius: 1.37, color: new THREE.Color(0.70294, 0.69401, 0.55789) },
	Os: { covalentRadius: 1.35, color: new THREE.Color(0.78703, 0.69512, 0.47379) },
	Ir: { covalentRadius: 1.36, color: new THREE.Color(0.78975, 0.81033, 0.45049) },
	Pt: { covalentRadius: 1.39, color: new THREE.Color(0.79997, 0.77511, 0.75068) },
	Au: { covalentRadius: 1.44, color: new THREE.Color(0.99628, 0.70149, 0.22106) },
	Hg: { covalentRadius: 1.55, color: new THREE.Color(0.82940, 0.72125, 0.79823) },
	Tl: { covalentRadius: 1.71, color: new THREE.Color(0.58798, 0.53854, 0.42649) },
	Pb: { covalentRadius: 1.75, color: new THREE.Color(0.32386, 0.32592, 0.35729) },
	Bi: { covalentRadius: 1.82, color: new THREE.Color(0.82428, 0.18732, 0.97211) },
	Po: { covalentRadius: 1.77, color: new THREE.Color(0.00000, 0.00000, 1.00000) },
	At: { covalentRadius: 0.62, color: new THREE.Color(0.00000, 0.00000, 1.00000) },
	Rn: { covalentRadius: 0.80, color: new THREE.Color(1.00000, 1.00000, 0.00000) },
	Fr: { covalentRadius: 1.00, color: new THREE.Color(0.00000, 0.00000, 0.00000) },
	Ra: { covalentRadius: 2.35, color: new THREE.Color(0.42959, 0.66659, 0.34786) },
	Ac: { covalentRadius: 2.03, color: new THREE.Color(0.39344, 0.62101, 0.45034) },
	Th: { covalentRadius: 1.80, color: new THREE.Color(0.14893, 0.99596, 0.47106) },
	Pa: { covalentRadius: 1.63, color: new THREE.Color(0.16101, 0.98387, 0.20855) },
	U: { covalentRadius: 1.56, color: new THREE.Color(0.47774, 0.63362, 0.66714) },
	Np: { covalentRadius: 1.56, color: new THREE.Color(0.30000, 0.30000, 0.30000) },
	Pu: { covalentRadius: 1.64, color: new THREE.Color(0.30000, 0.30000, 0.30000) },
	Am: { covalentRadius: 1.73, color: new THREE.Color(0.30000, 0.30000, 0.30000) }
};