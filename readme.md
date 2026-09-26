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
- Visualization of **Gaussian** (`.gjf`) structures
- Independent previews for different files
- Automatic live refresh on file changes
- Atom hover inspection with coordinate and constraint information
- Highlighting for constrained atoms
- Bond rendering using element-specific distance cutoffs
- Lightweight workflow-oriented design

#### Format-Specific Notes

#### VASP
- Supports `POSCAR`, `CONTCAR`, `XDATCAR`, and `.vasp`
- Supports multi-frame trajectory playback for `XDATCAR` and stacked `.vasp` files
- Files are recognized when their names contain `POSCAR`, `CONTCAR`, or `XDATCAR` (case-insensitive)
- Supports coordinate constraints (`Selective Dynamics`)

#### SIESTA (`.fdf`)
- Supports both Z-matrix and Cartesian/fractional coordinates
- Shows Z-matrix geometry (distance/angle/torsion) labels and constraint status on hover
- Supports Cartesian/fractional constraints defined through `Geometry.Constraints`
- Cartesian/fractional constraints that do not act on individual atoms (`center`, `rigid`, `molecule`, `rigid-max`, `molecule-max`, `cell-angle`, `cell-vector`, `stress`, `routine`) are not currently visualized

#### Quantum ESPRESSO (`.in`)
- Nonzero `ibrav` values are not currently supported; explicit `CELL_PARAMETERS` are required
- Space-group expansion (`crystal_sg`) is not currently supported; all atoms must be explicitly listed in `ATOMIC_POSITIONS`
- Supports coordinate constraints (`if_pos`)

#### Gaussian (`.gjf`)
- Supports Cartesian, Z-matrix, and mixed-coordinate input
- Shows Z-matrix geometry (distance/angle/torsion) labels and constraint status on hover
- Supports `freeze-code` coordinate constraints
- Supports periodic translation vectors (`TV`)
- Dummy atoms are hidden; ghost atoms are shown and identified on hover
- The alternate two-angle Z-matrix format is not supported
- Trailing atom indices, MM atom types, charges, isotopes, fragments, and other parameters are ignored for visualization
- Explicit connectivity information is not used for bond generation

## Planned Features

- Expanded support and feature coverage for currently supported formats
- Additional structure format support (`.cif`, `.xyz`, etc.)

## Release Notes

### 0.4.1
- Added Z-matrix geometry (distance/angle/torsion) labels and constraint status on hover

### 0.4.0
- Added SIESTA and Gaussian Z-matrix support
- Added Gaussian dummy and ghost atoms support

### 0.3.3
- Added support for multiple independent preview windows
- Improved viewer performance
- Improved loading and playback of long trajectories
- Fixed various minor parsing issues

### 0.3.2
- Minor fix for SIESTA parser

### 0.3.1
- Added support for SIESTA `Geometry.Constraints` coordinate constraints

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
