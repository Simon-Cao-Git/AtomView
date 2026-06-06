# AtomView

[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.20149818-blue.png)](https://doi.org/10.5281/zenodo.20149818)

AtomView is a lightweight atomic structure viewer inside Visual Studio Code.

Designed for computational materials and atomistic simulation workflows, AtomView provides fast in-editor visualization with automatic live updates as input files are modified.

The goal is not to replace full-featured visualization tools such as VESTA, GaussView, or VMD, but to provide a lightweight utility for rapid inspection, debugging, and sanity checking directly inside VS Code.

![AtomView Demo](https://raw.githubusercontent.com/Simon-Cao-Git/AtomView/main/media/DEMO.gif)

## Installation

Install directly from the VS Marketplace:
[AtomView on VS Marketplace](https://marketplace.visualstudio.com/items?itemName=PurunSimonCao.atomview)

## Features

- Visualization of **VASP** structures (`POSCAR`, `CONTCAR`, `.vasp`) and trajectories (`XDATCAR`) with frame navigation and playback controls
- Visualization of **SIESTA** (`.fdf`) structures
- Visualization of **Quantum ESPRESSO** (`.in`) structures
- Limited visualization of **Gaussian** (`.gjf`) structures
- Automatic live refresh on file changes
- Atom hover inspection with coordinate display
- Highlighting for constrained atoms
- Bond rendering based on element-specific bonding data
- Lightweight workflow-oriented design

### Format Support Notes

#### VASP
- Supports `POSCAR`, `CONTCAR`, `XDATCAR`, and `.vasp`
- Supports multi-frame trajectory playback for `XDATCAR` and stacked `.vasp` files
- Files are recognized when their names contain `POSCAR`, `CONTCAR`, or `XDATCAR` (case-insensitive)
- Supports coordinate constraints (`Selective Dynamics` flags)

#### SIESTA (`.fdf`)
- Z-matrix-based structure definitions are not currently supported
- Constraint parsing is not currently implemented

#### Quantum ESPRESSO (`.in`)
- Nonzero `ibrav` values is not currently supported; explicit `CELL_PARAMETERS` are required
- Symmetry expansion from space-group information (`crystal_sg`) are not currently supported; all atoms must be explicitly listed in `ATOMIC_POSITIONS`
- Supports coordinate constraints

#### Gaussian (`.gjf`)
- Supports Cartesian-coordinate molecule specifications only
- Z-matrix and other internal-coordinate molecule specifications are not currently supported
- Supports coordinate constraints (freeze-code)
- Supports periodic translation vectors (`TV`)
- MM atom types, charges, connectivity, force-field, basis-set, and other parameters are not interpreted for visualization

## Planned Features

- Expanded support and feature coverage for currently supported formats
- Additional structure format support (`.cif`, `.xyz`, etc.)

## Release Notes

### 0.3.0
- Added SIESTA (`.fdf`) support
- Added Quantum ESPRESSO (`.in`) support
- Added limited Gaussian (`.gjf`) support

### 0.2.1
- Added VASP trajectory (`XDATCAR`) support with playback and frame controls
- Added lattice-axis viewer and camera alignment tools
- Improved rendering and trajectory performance

### 0.1.2
- Improved bond rendering behavior

### 0.1.1
- Initial release

---

## License

This project is licensed under the MIT License.