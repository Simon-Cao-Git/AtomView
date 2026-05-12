const root = document.createElement('div');
root.style.padding = '16px';
root.style.fontFamily = 'monospace';
root.style.whiteSpace = 'pre-wrap';
root.style.color = 'var(--vscode-foreground)';
root.style.background = 'var(--vscode-editor-background)';
root.style.minHeight = '100vh';

document.body.innerHTML = '';
document.body.appendChild(root);

setDebugText('main.js loaded. Waiting for message from extension.ts...');

window.addEventListener('message', (event) => {
	const message = event.data;

	if (message.command === 'showStatus') {
		setDebugText(`Received showStatus:\n\n${message.text}`);
		return;
	}

	if (message.command === 'showStructure') {
		const structure = message.structure;
		setDebugText(formatStructureDebug(structure));
		renderSimpleTestBox();
		return;
	}

	setDebugText(`Received unknown message:\n\n${JSON.stringify(message, null, 2)}`);
});

function setDebugText(text) {
	root.textContent = text;
}

function formatStructureDebug(structure) {
	return [
		'main.js loaded.',
		'Received showStructure message from extension.ts.',
		'',
		`Title: ${structure.title}`,
		`Format: ${structure.sourceFormat}`,
		`Coordinate mode: ${structure.coordinateMode}`,
		`Number of atoms: ${structure.atoms.length}`,
		'',
		'Lattice:',
		JSON.stringify(structure.lattice, null, 2),
		'',
		'Atoms:',
		JSON.stringify(structure.atoms, null, 2)
	].join('\n');
}

function renderSimpleTestBox() {
	const box = document.createElement('div');
	box.textContent = 'DOM render test: if you see this box, webview JS and message passing work.';
	box.style.marginTop = '16px';
	box.style.padding = '16px';
	box.style.border = '2px solid var(--vscode-focusBorder)';
	box.style.background = 'var(--vscode-editor-selectionBackground)';
	box.style.color = 'var(--vscode-editor-foreground)';
	document.body.appendChild(box);
}