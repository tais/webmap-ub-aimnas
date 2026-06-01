'use strict';
// UB-AIMNAS tileset resolver. The mod ships the BINARY JA2SET.DAT (not Ja2Set.dat.xml) plus loose
// per-tileset STI overrides in Tilesets/<id>/ (and /T/); base tile graphics still live in the base
// game's Tilesets.slf. We parse the binary, then resolve a (tilesetId, type) to a decoded STI by
// searching: this tileset's loose dir -> base Tilesets.slf (this tileset) -> generic (0) loose ->
// base Tilesets.slf (generic). Same {tilesets[id].files[type]} shape the renderer expects.
const fs = require('fs');
const path = require('path');
const { openSlf } = require('./slf');
const { decodeSti } = require('./sti');

const GENERIC_TILESET = 0;

// Binary layout (source/TileEngine/WorldDat.cpp): u8 numSets, u32 numFileTypes, then per set:
//   char[32] name (space-padded, NUL-terminated), u8 ambientId, numFileTypes * char[32] tile files.
function readStr(buf, off, len) {
  let end = off;
  const limit = off + len;
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString('latin1', off, end).trim();
}
function parseJa2SetDat(src) {
  // src may be a file path or an already-read Buffer.
  const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
  let p = 0;
  const numSets = buf.readUInt8(p); p += 1;
  const numFileTypes = buf.readUInt32LE(p); p += 4;
  const tilesets = [];
  for (let i = 0; i < numSets; i++) {
    const name = readStr(buf, p, 32); p += 32;
    const ambientId = buf.readUInt8(p); p += 1;
    const files = new Array(numFileTypes);
    for (let j = 0; j < numFileTypes; j++) { files[j] = readStr(buf, p, 32); p += 32; }
    tilesets[i] = { name, ambientId, files };
  }
  return { tilesets, numSets, numFileTypes, bytesConsumed: p, fileSize: buf.length };
}

// Index every loose .sti under Tilesets/<id>/ (recursive, includes /T/) by lowercase basename.
function indexLooseTilesets(tilesetsDir) {
  const byId = new Map(); // id -> Map(lowerBasename -> fullPath)
  let dirs;
  try { dirs = fs.readdirSync(tilesetsDir); } catch (e) { return byId; }
  for (const d of dirs) {
    const id = parseInt(d, 10);
    if (!Number.isInteger(id) || String(id) !== d) continue;
    const m = new Map();
    (function walk(dir) {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      // Index this dir's own .sti FIRST, THEN recurse into subdirs, so a tileset's main tiles win over
      // its /T/ subdir — that holds trimmed/alternate variants (e.g. tiny window-roof frame pieces that
      // would otherwise render flat roofs as a see-through grid). First file found for a name wins.
      for (const e of ents) if (!e.isDirectory() && /\.sti$/i.test(e.name)) { const k = e.name.toLowerCase(); if (!m.has(k)) m.set(k, path.join(dir, e.name)); }
      for (const e of ents) if (e.isDirectory()) walk(path.join(dir, e.name));
    })(path.join(tilesetsDir, d));
    byId.set(id, m);
  }
  return byId;
}

// Merge several parsed JA2SET.DAT tileset tables in VFS priority order (first wins). Crucially this
// merges PER SLOT: a tileset's blank slot in a higher table is filled from a lower one. AIMNAS leaves
// e.g. tileset 51 ("MIXED SNOW") ground blank and relies on the Data-1.13 table defining snow_1.sti —
// so without this merge the landing sector's snow falls through to the generic earth tileset.
function mergeTilesets(list) {
  const merged = [];
  for (const tilesets of list) {
    for (let id = 0; id < tilesets.length; id++) {
      const t = tilesets[id]; if (!t) continue;
      let dst = merged[id]; if (!dst) { dst = merged[id] = { name: '', ambientId: t.ambientId, files: [] }; }
      if (!dst.name && t.name) dst.name = t.name;
      for (let s = 0; s < t.files.length; s++) if (!dst.files[s] && t.files[s]) dst.files[s] = t.files[s];
    }
  }
  return merged;
}

// ja2setSrcs / tilesetsDirs / baseSlfPaths may each be a single value or an ORDERED LIST (highest VFS
// priority first). For the full UB-AIMNAS install the JA2SET tables AND the tile graphics are layered
// across the stack (AIMNAS -> Data-UB -> Data-1.13 -> Data), so both are searched down the whole chain.
function createTilesetResolver(ja2setSrcs, tilesetsDirs, baseSlfPaths) {
  const dirs = (Array.isArray(tilesetsDirs) ? tilesetsDirs : [tilesetsDirs]).filter(Boolean);
  const slfPaths = (Array.isArray(baseSlfPaths) ? baseSlfPaths : [baseSlfPaths]).filter(Boolean);
  const srcs = (Array.isArray(ja2setSrcs) ? ja2setSrcs : [ja2setSrcs]).filter(Boolean);
  const parsed = srcs.map((s) => parseJa2SetDat(s));
  const tilesets = parsed.length > 1 ? mergeTilesets(parsed.map((x) => x.tilesets)) : parsed[0].tilesets;
  const numSets = tilesets.length, numFileTypes = Math.max(...parsed.map((x) => x.numFileTypes));
  // Merge the loose dirs in priority order (the first dir to provide a given file wins).
  const loose = new Map(); // id -> Map(lowerName -> fullPath)
  for (const dir of dirs) {
    for (const [id, m] of indexLooseTilesets(dir)) {
      let dst = loose.get(id); if (!dst) { dst = new Map(); loose.set(id, dst); }
      for (const [k, v] of m) if (!dst.has(k)) dst.set(k, v);
    }
  }
  const baseSlfs = slfPaths.map((p) => (fs.existsSync(p) ? openSlf(p) : null)).filter(Boolean);
  const stiCache = new Map(); // cache key -> decoded STI | null
  const stats = { resolved: 0, fromLoose: 0, fromSlf: 0, generic: 0, missing: 0, missingFiles: new Set() };

  function decode(buf) { if (!buf) return null; try { return decodeSti(buf); } catch (e) { return null; } }
  function loadLoose(id, fnameLower) {
    const m = loose.get(id); if (!m) return null;
    const fp = m.get(fnameLower); if (!fp) return null;
    const key = 'L:' + fp;
    if (stiCache.has(key)) return stiCache.get(key);
    let sti = null; try { sti = decode(fs.readFileSync(fp)); } catch (e) {}
    stiCache.set(key, sti); return sti;
  }
  function loadSlf(id, fname) {
    if (!baseSlfs.length) return null;
    const key = 'S:' + id + '\\' + fname;
    if (stiCache.has(key)) return stiCache.get(key);
    let sti = null;
    for (const slf of baseSlfs) { const buf = slf.get(id + '\\' + fname); if (buf) { sti = decode(buf); if (sti) break; } }
    stiCache.set(key, sti); return sti;
  }

  // Returns a decoded STI (with .subimages) for this (tilesetId, type) or null.
  function resolve(tilesetId, type) {
    let fname = tilesets[tilesetId] && tilesets[tilesetId].files[type];
    let viaGeneric = false;
    if (!fname) { fname = tilesets[GENERIC_TILESET] && tilesets[GENERIC_TILESET].files[type]; viaGeneric = true; }
    if (!fname) { stats.missing++; return null; }
    const lower = fname.toLowerCase();
    let sti = loadLoose(tilesetId, lower);
    if (sti) { stats.resolved++; stats.fromLoose++; if (viaGeneric) stats.generic++; return sti; }
    sti = loadSlf(tilesetId, fname);
    if (sti) { stats.resolved++; stats.fromSlf++; if (viaGeneric) stats.generic++; return sti; }
    sti = loadLoose(GENERIC_TILESET, lower);
    if (sti) { stats.resolved++; stats.fromLoose++; stats.generic++; return sti; }
    sti = loadSlf(GENERIC_TILESET, fname);
    if (sti) { stats.resolved++; stats.fromSlf++; stats.generic++; return sti; }
    stats.missing++; if (stats.missingFiles.size < 40) stats.missingFiles.add(tilesetId + ':' + fname); return null;
  }

  return { tilesets, numSets, numFileTypes, loose, baseSlfs, resolve, stats };
}

module.exports = { parseJa2SetDat, indexLooseTilesets, createTilesetResolver, GENERIC_TILESET };
