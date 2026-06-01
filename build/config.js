'use strict';
const path = require('path');

// UB-AIMNAS instance, pointed at the FULL merged install (JA2 UB + 1.13 + UB-AIMNAS) so every source
// resolves down the same VFS stack the game uses, highest priority first:
//   AIMNAS addon  ->  Data-UB (UB)  ->  Data-1.13 (1.13)  ->  Data (vanilla/base, incl. Tilesets.slf)
// This matters because the JA2SET tileset tables AND the tile graphics are layered: AIMNAS leaves some
// slots (e.g. tileset 51 "MIXED SNOW" ground) blank and inherits them from the 1.13 table below it.
const EDIT_ROOT = path.resolve(__dirname, '..', '..');                 // .../edit113
const INSTALL = path.join(EDIT_ROOT, 'JA2UB-AIMNAS');                  // the merged full install
const AIMNAS = path.join(INSTALL, 'Data-UB', 'AddOns', 'Data-UB-AIMNAS');
const ja2set = (rel) => path.join(INSTALL, rel, 'BinaryData', 'JA2SET.DAT');

module.exports = {
  EDIT_ROOT,
  INSTALL,
  AIMNAS,
  // Maps: AIMNAS bigmaps override loose UB maps; sectors in neither fall back to the vanilla UB Maps.slf.
  MAPS_DIRS: [path.join(AIMNAS, 'MAPS'), path.join(INSTALL, 'Data-UB', 'Maps')],
  MAPS_DIR: path.join(AIMNAS, 'MAPS'), // primary (used by overlays' loot reader)
  UB_MAPS_SLF: path.join(INSTALL, 'Data', 'Campaigns', 'Unfinished Business', 'Maps.slf'),
  // JA2SET tileset tables, merged per-slot in priority order (AIMNAS wins, blanks fall through).
  JA2SET_DATS: [
    path.join(AIMNAS, 'BinaryData', 'JA2SET.DAT'),
    ja2set('Data-UB'), ja2set('Data-1.13'), ja2set('Data'),
  ],
  // Tile graphics: loose tileset overrides down the stack, then the base Tilesets.slf (the UB tileset).
  TILESET_DIRS: [
    path.join(AIMNAS, 'Tilesets'),
    path.join(INSTALL, 'Data-UB', 'Tilesets'),
    path.join(INSTALL, 'Data-1.13', 'Tilesets'),
    path.join(INSTALL, 'Data', 'Tilesets'),
  ],
  BASE_TILESETS_SLF: [path.join(INSTALL, 'Data', 'Tilesets.slf')],
  TABLEDATA_MAP: path.join(AIMNAS, 'TableData', 'Map'),
  DIST: path.resolve(__dirname, '..', 'dist'),
  RENDER_SCALE: 1.0,
};
