# AtomView

[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.20149818-blue.png)](https://doi.org/10.5281/zenodo.20149818)

AtomView is a lightweight atomic structure viewer for VASP files inside Visual Studio Code.

Designed for computational materials and atomistic simulation workflows, AtomView provides fast in-editor visualization with automatic live updates as structures are modified.

The goal is not to replace full-featured visualization tools such as VESTA, but to provide a lightweight utility for rapid inspection, debugging, and sanity checking directly inside VS Code.

## Installation

Install directly from the VS Code Marketplace:
[AtomView on VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=PurunSimonCao.atomview)

## Features

- Live preview for `POSCAR`, `CONTCAR`, `XDATCAR`, and `.vasp` files
- Trajectory visualization with frame slider and playback controls
- Automatic live refresh on file changes
- Atom hover inspection with coordinate display
- Selective dynamics highlighting for constrained atoms
- Bond rendering based on element-specific bonding data
- Orthographic and perspective viewing modes
- Lightweight workflow-oriented design

![AtomView Demo](https://raw.githubusercontent.com/Simon-Cao-Git/AtomView/main/media/DEMO.gif)

## Planned Features

- Additional structure format support (`.cif`, `.xyz`, `.pdb`, `.cube`, etc.)
- Supercell generation

## Release Notes

### 0.2.1
- Added trajectory (`XDATCAR`) support with playback and frame controls
- Added lattice-axis viewer and camera alignment tools
- Improved rendering and trajectory performance
- Added atom hover inspection and additional UI improvements

### 0.1.2
- Improved bond calculation and bond rendering behavior

### 0.1.1
- Initial release

---

## License

This project is licensed under the MIT License.