# AtomView

Lightweight live atomic structure preview for VASP POSCAR files inside VS Code.

AtomView provides fast in-editor structure visualization for computational materials and atomistic simulation workflows, with automatic live updates as structures are modified.

The goal is not to replace full-featured tools like VESTA, but to provide a lightweight utility for rapid inspection, debugging, and sanity checking directly inside Visual Studio Code.

## Features

- Live preview for `POSCAR` / `CONTCAR` / `.vasp` files
- Atom hover inspection with coordinates and selective dynamics
- Selective dynamics highlight (constrained atoms become translucent)
- Automatic live refresh on file changes
- Lightweight and workflow-oriented design

![AtomView Demo](https://raw.githubusercontent.com/Simon-Cao-Git/AtomView/main/media/DEMO.gif)

## Planned Features

- XDATCAR and trajectory visualization
- Additional structure format support (`.cif`, `.xyz`, `.pdb`, `.cube`, etc.)
- Supercell generation
- Enhanced camera and alignment controls

---

## License

This project is licensed under the MIT License.