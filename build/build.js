'use strict';
// Build entry. Usage:
//   node build/build.js --one J9 [--height]   Render a single sector (debug iso + square PNG).
//   node build/build.js [--detail 0.5] [--overview 0.0625] [--limit N]
//                                              Render all surface sectors + overviews + manifest.
//
// Each sector is rendered isometrically, then un-projected into an axis-aligned SQUARE so the
// sectors fill their cells and tessellate into one seamless map (the "strategic grid"). The
// connected isometric world is also composited as an overview-only toggle.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { openSlf } = require('./slf');
const { createTilesetResolver } = require('./tilesets');
const { parseDat } = require('./dat');
const { renderSector, warpToContentSquare } = require('./render-sector');
const { encodePNG, encodeIndexedPNG } = require('./png');
const { encodeWebpToFile, checkCwebp } = require('./webp');

const TILE_W = 7200, TILE_H = 3600;  // content-tile output size (px) for these 360x360 "bigmaps" — exactly
                                     // HALF the native iso (~14400x7200): a clean 1:2 = a round 20px per
                                     // game-tile (matches the webmap-aimnas sibling). 4800 gave 13.3px/tile.
// TILE PYRAMID: the warped content is sliced into PT_W x PT_H tiles at several resolution levels, so the
// viewer loads only the on-screen tiles at the current zoom — small, fast decodes — instead of one huge
// whole-sector image (which queued up decodes and stalled panning). z0 = 1/4 res (1 tile), up to full
// res (NxN). PT_W must divide all level widths: 7200/4=1800, 7200/2=3600, 7200 -> 1800 divides each.
const PT_W = 1800, PT_H = 900;
const PYR = [0.25, 0.5, 1.0].map((s, z) => {
  const w = Math.round(TILE_W * s), h = Math.round(TILE_H * s);
  return { z, w, h, cols: Math.max(1, Math.round(w / PT_W)), rows: Math.max(1, Math.round(h / PT_H)) };
});
const LETTERS = 'ABCDEFGHIJKLMNOP';

// Box-average downscale with binary alpha (no partial edges -> clean seams).
function downscale(rgba, w, h, factor) {
  if (factor === 1) return { rgba, w, h };
  const nw = Math.max(1, Math.round(w * factor)), nh = Math.max(1, Math.round(h * factor));
  const out = new Uint8Array(nw * nh * 4);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = (y * sy) | 0, y1 = Math.max(y0 + 1, Math.min(h, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < nw; x++) {
      const x0 = (x * sx) | 0, x1 = Math.max(x0 + 1, Math.min(w, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, covered = 0, total = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        total++; const si = (yy * w + xx) * 4;
        if (rgba[si + 3]) { r += rgba[si]; g += rgba[si + 1]; b += rgba[si + 2]; covered++; }
      }
      if (covered > 0 && covered * 2 >= total) {
        const di = (y * nw + x) * 4;
        out[di] = (r / covered) | 0; out[di + 1] = (g / covered) | 0; out[di + 2] = (b / covered) | 0; out[di + 3] = 255;
      }
    }
  }
  return { rgba: out, w: nw, h: nh };
}

// Extract a tw x th tile at (tx,ty) from a w x h RGBA buffer (zero-padded past the right/bottom edge).
function extractTile(rgba, w, h, tx, ty, tw, th) {
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = ty + y; if (sy < 0 || sy >= h) continue;
    const copyW = Math.min(tw, w - tx); if (copyW <= 0) continue;
    const si = (sy * w + tx) * 4;
    out.set(rgba.subarray(si, si + copyW * 4), y * tw * 4);
  }
  return out;
}
function anyOpaque(rgba) { for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) return true; return false; }

function blit(dst, dstW, dstH, src, srcW, srcH, ox, oy) {
  for (let y = 0; y < srcH; y++) {
    const cy = oy + y; if (cy < 0 || cy >= dstH) continue;
    for (let x = 0; x < srcW; x++) {
      const si = (y * srcW + x) * 4;
      if (src[si + 3]) {
        const cx = ox + x; if (cx < 0 || cx >= dstW) continue;
        const di = (cy * dstW + cx) * 4;
        dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = 255;
      }
    }
  }
}

function parseCode(code) {
  const m = /^([A-P])(\d{1,2})(?:_(.+))?$/i.exec(code);
  return m ? { code, letter: m[1].toUpperCase(), number: +m[2], sx: +m[2] - 1, sy: LETTERS.indexOf(m[1].toUpperCase()), suffix: m[3] || null } : null;
}
// Resolve each sector's .dat by VFS priority: loose MAPS dirs (AIMNAS bigmaps override loose UB maps),
// then the vanilla UB Maps.slf for sectors neither ships (e.g. some K15/L15 basements). First dir wins.
function createMapSource() {
  const m = new Map(); // UPPERCASE code -> path (highest-priority dir wins)
  for (const dir of cfg.MAPS_DIRS) {
    let files; try { files = fs.readdirSync(dir); } catch (e) { continue; }
    for (const f of files) { if (!/\.dat$/i.test(f)) continue; const code = f.replace(/\.dat$/i, '').toUpperCase(); if (!m.has(code)) m.set(code, path.join(dir, f)); }
  }
  let slf = null;
  const codes = new Set(m.keys());
  if (fs.existsSync(cfg.UB_MAPS_SLF)) {
    slf = openSlf(cfg.UB_MAPS_SLF);
    for (const n of slf.names()) { const b = path.basename(n); if (/\.dat$/i.test(b)) codes.add(b.replace(/\.dat$/i, '').toUpperCase()); }
  }
  function resolve(code) {
    const p = m.get(code.toUpperCase());
    if (p) return { buf: fs.readFileSync(p), src: 'loose' };
    if (slf) { const buf = slf.get(code + '.dat'); if (buf) return { buf, src: 'UB.slf' }; }
    return null;
  }
  return { codes: [...codes].sort(), resolve };
}
function renderOne(src, resolver, code, opts) {
  const r = src.resolve(code); if (!r) return null;
  const dat = parseDat(r.buf); const img = renderSector(dat, resolver, opts);
  return img ? { dat, img, src: r.src } : null;
}

const LEVELS = [
  { id: 'surface', label: 'Surface', re: /^[A-P]\d{1,2}$/i },
  { id: 'b1', label: 'Basement 1', re: /^[A-P]\d{1,2}_b1$/i },
  { id: 'b2', label: 'Basement 2', re: /^[A-P]\d{1,2}_b2$/i },
  { id: 'b3', label: 'Basement 3', re: /^[A-P]\d{1,2}_b3$/i },
];

// Clip overlay data to the sectors that actually have a map. The mod's TableData is a 256-sector,
// Arulco-derived table: the UB region is correctly named/populated, but it keeps Arulco defaults for
// the ~217 out-of-campaign cells. Without this, towns/difficulty/POIs/etc. paint onto empty sectors
// (e.g. "Omerta" on A9/A10) — see README "Overlay data". `builtCells` = base codes (no _Bn suffix).
function pruneOverlays(o, builtCells) {
  const cellOf = (c) => String(c).replace(/_b\d$/i, '').toUpperCase();
  const inB = (c) => builtCells.has(cellOf(c));
  const keyed = (obj) => { const r = {}; for (const k in (obj || {})) if (inB(k)) r[k] = obj[k]; return r; };
  const arr = (a) => (a || []).filter((e) => e && inB(e.code));
  return {
    sectorNames: keyed(o.sectorNames), water: keyed(o.water),
    towns: (o.towns || []).map((t) => ({ ...t, sectors: (t.sectors || []).filter(inB) })).filter((t) => t.sectors.length),
    samSites: arr(o.samSites), mines: arr(o.mines), coolness: keyed(o.coolness),
    facilities: keyed(o.facilities), bloodcats: keyed(o.bloodcats), heliSites: arr(o.heliSites),
    shipping: arr(o.shipping), garrisons: keyed(o.garrisons),
    patrols: (o.patrols || []).filter((p) => (p.sectors || []).length && p.sectors.every(inB)),
    terrain: keyed(o.terrain),
    creatures: { cells: ((o.creatures || {}).cells || []).filter(inB), zones: (o.creatures || {}).zones || [] },
    pois: arr(o.pois), npcs: arr(o.npcs), militiaCap: o.militiaCap, items: keyed(o.items),
  };
}

function buildAll(detailScale, overviewScale, limit, webp, webpQ) {
  if (webp && !checkCwebp()) { console.error('--webp needs the `cwebp` tool on PATH (brew install webp).'); process.exit(1); }
  const ext = webp ? 'webp' : 'png';
  // Encode one tile. WebP keeps alpha lossless either way. In PNG fallback the opaque base uses the
  // small 8-bit indexed encoder; the roof overlay needs real transparency, so it takes full RGBA PNG.
  const writeTile = (rgba, w, h, fn, hasAlpha) => {
    if (webp) return encodeWebpToFile(rgba, w, h, webpQ, fn);
    const png = hasAlpha ? encodePNG(rgba, w, h) : encodeIndexedPNG(rgba, w, h);
    fs.writeFileSync(fn, png); return png.length;
  };
  const src = createMapSource();
  const resolver = createTilesetResolver(cfg.JA2SET_DATS, cfg.TILESET_DIRS, cfg.BASE_TILESETS_SLF);
  const outDir = path.join(cfg.DIST, 'sectors');
  fs.rmSync(outDir, { recursive: true, force: true }); // tiles live in per-sector subdirs now; wipe all
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(cfg.DIST)) if (/^overview_.*\.(png|webp)$/i.test(f)) fs.unlinkSync(path.join(cfg.DIST, f));

  // Slice a full-res content buffer into pyramid tiles under dir/. Returns present tile keys
  // ("z_col_row"); for the (sparse) roof overlay, fully-transparent tiles are skipped.
  const writePyramid = (rgba, fullW, fullH, dir, suffix, isRoof) => {
    fs.mkdirSync(dir, { recursive: true });
    const present = [];
    for (const L of PYR) {
      const ds = downscale(rgba, fullW, fullH, L.w / fullW);
      for (let row = 0; row < L.rows; row++) for (let col = 0; col < L.cols; col++) {
        const t = extractTile(ds.rgba, ds.w, ds.h, col * PT_W, row * PT_H, PT_W, PT_H);
        if (isRoof && !anyOpaque(t)) continue;
        totalBytes += writeTile(t, PT_W, PT_H, path.join(dir, `z${L.z}_${col}_${row}${suffix}.${ext}`), isRoof);
        present.push(`${L.z}_${col}_${row}`);
      }
    }
    return present;
  };

  const cW = Math.round(TILE_W * detailScale), cH = Math.round(TILE_H * detailScale);   // detail cell (2:1)
  const oW = Math.round(TILE_W * overviewScale), oH = Math.round(TILE_H * overviewScale); // overview cell (2:1)
  const GOW = 16 * oW, GOH = 16 * oH;
  const bounds = { minX: 0, minY: 0, maxX: 16 * cW, maxY: 16 * cH, width: 16 * cW, height: 16 * cH };

  const allCodes = src.codes;
  const levelsOut = {}, levelOrder = [];
  const srcTally = {};
  let totalBytes = 0;
  const t0 = Date.now();

  for (const lvl of LEVELS) {
    let codes = allCodes.filter((c) => lvl.re.test(c)).sort();
    if (limit && lvl.id === 'surface') codes = codes.slice(0, limit);
    if (!codes.length) continue;

    const gridOv = new Uint8Array(GOW * GOH * 4); // seamless 16x16 grid overview (roofless on surface)
    const gridOvRoof = lvl.id === 'surface' ? new Uint8Array(GOW * GOH * 4) : null; // surface roof-overlay overview
    const sectors = [];
    // Surface: draw all roofs (overhead building look). Underground: 'exterior' roofs — a basement's
    // roof layer is the cave ceiling that blankets the whole map; like the game we keep it only over
    // unreachable rock (no floor tile) and reveal the floor inside the walls (see render-sector.js).
    const roofMode = lvl.id === 'surface' ? 'all' : 'exterior';
    for (const code of codes) {
      const g = parseCode(code);
      // Surface ships a roofless BASE tile + a transparent roof-only OVERLAY tile so the viewer can
      // toggle roofs at runtime (off reveals interiors). Both passes share one bounding box (bounds are
      // computed over all layers regardless of roofPass), so they warp pixel-aligned and composite
      // exactly. Basements have no overhead roofs — a single pass.
      const passes = lvl.id === 'surface' ? ['base', 'overlay'] : [null];
      const sector = { code: `${g.letter}${g.number}`, sx: g.sx, sy: g.sy, gx: g.sx * cW, gy: g.sy * cH };
      let empty = false;
      for (const roofPass of passes) {
        const r = renderOne(src, resolver, code, { roofs: true, roofMode, roofPass });
        if (!r) { console.log(`  ${code}: SKIP (empty)`); empty = true; break; }
        if (roofPass !== 'overlay') srcTally[r.src] = (srcTally[r.src] || 0) + 1; // count each sector once
        // Content tile (native 2:1): un-project + rotate 45° + crop to inscribed square (blank corners cut).
        // gridMax = the map's tile-grid size - 1 (359 for a 360 bigmap) so the content diamond maps right.
        const tile = warpToContentSquare(r.img, TILE_W, TILE_H, r.dat.cols - 1);
        const det = downscale(tile.canvas, tile.width, tile.height, detailScale);
        const overlay = roofPass === 'overlay';
        const present = writePyramid(det.rgba, det.w, det.h, path.join(outDir, code), overlay ? '_roof' : '', overlay);
        const sq = downscale(tile.canvas, tile.width, tile.height, overviewScale);
        blit(overlay ? gridOvRoof : gridOv, GOW, GOH, sq.rgba, sq.w, sq.h, g.sx * oW, g.sy * oH);
        if (overlay) sector.roofTiles = present;       // present roof-tile keys (sparse)
        else sector.tiles = code;                      // per-sector tile dir (full code, incl. _Bn basements)
      }
      if (!empty) sectors.push(sector);
    }
    const ovName = `overview_${lvl.id}.${ext}`, ovPath = path.join(cfg.DIST, ovName);
    if (webp) encodeWebpToFile(gridOv, GOW, GOH, webpQ, ovPath);
    else fs.writeFileSync(ovPath, encodePNG(gridOv, GOW, GOH));
    const overview = { image: ovName, width: GOW, height: GOH };
    if (gridOvRoof) { // surface: a matching transparent roof-overlay overview for the zoomed-out toggle
      const ovRoofName = `overview_${lvl.id}_roof.${ext}`, ovRoofPath = path.join(cfg.DIST, ovRoofName);
      if (webp) encodeWebpToFile(gridOvRoof, GOW, GOH, webpQ, ovRoofPath);
      else fs.writeFileSync(ovRoofPath, encodePNG(gridOvRoof, GOW, GOH));
      overview.imageRoof = ovRoofName;
    }
    levelsOut[lvl.id] = { label: lvl.label, overview, sectors };
    levelOrder.push(lvl.id);
    console.log(`  ${lvl.label.padEnd(11)} ${sectors.length} sectors  ${(totalBytes / 1e6).toFixed(1)}MB  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  const manifest = {
    detailScale, overviewScale, tilePx: { w: TILE_W, h: TILE_H },
    pyramid: { tile: [PT_W, PT_H], ext, levels: PYR.map((L) => ({ z: L.z, w: L.w, h: L.h, cols: L.cols, rows: L.rows })) },
    grid: { cols: 16, rows: 16, letters: LETTERS, cellW: cW, cellH: cH, bounds },
    defaultLevel: 'surface', levelOrder, levels: levelsOut,
  };
  fs.writeFileSync(path.join(cfg.DIST, 'manifest.json'), JSON.stringify(manifest, null, 1));
  // Overlays (towns/mines/etc.) read the mod's TableData; tolerate failures so a metadata gap doesn't
  // block the map render. On failure fall back to a COMPLETE empty skeleton (all keys present) so the
  // viewer's marker/legend code never trips over a missing field. TODO: adapt overlays.js to UB-AIMNAS.
  const EMPTY_OVERLAYS = {
    sectorNames: {}, water: {}, towns: [], samSites: [], mines: [], coolness: {}, facilities: {},
    bloodcats: {}, heliSites: [], shipping: [], garrisons: {}, patrols: [], terrain: {},
    creatures: { cells: [], zones: [] }, pois: [], npcs: [], militiaCap: 20, items: {},
  };
  let overlays = EMPTY_OVERLAYS;
  try { overlays = require('./overlays').build(); }
  catch (e) { console.warn('  overlays skipped (using empty skeleton):', e.message); }
  // Clip to sectors that have a map so Arulco defaults in the mod's 256-sector tables don't show.
  const builtCells = new Set();
  for (const id of levelOrder) for (const s of levelsOut[id].sectors) builtCells.add(s.code.replace(/_b\d$/i, '').toUpperCase());
  const before = Object.keys(overlays.coolness || {}).length;
  overlays = pruneOverlays(overlays, builtCells);
  console.log(`overlays clipped to ${builtCells.size} mapped sectors (coolness ${before} -> ${Object.keys(overlays.coolness).length}); ` +
    `${overlays.towns.length} towns, ${overlays.samSites.length} sam, ${Object.keys(overlays.garrisons).length} garrison, ${overlays.pois.length} poi`);
  fs.writeFileSync(path.join(cfg.DIST, 'data.js'), `window.JA2_DATA = ${JSON.stringify({ manifest, overlays })};\n`);

  console.log(`\nDone. ${(totalBytes / 1e6).toFixed(1)}MB. levels: ${levelOrder.join(', ')}.`);
  console.log('map source:', srcTally, '| tile resolver:', { ...resolver.stats, missingFiles: [...resolver.stats.missingFiles] });
}

const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? parseFloat(args[i + 1]) : def; };
if (args[0] === '--one') {
  const code = args[1] || 'D9';
  const src = createMapSource();
  const resolver = createTilesetResolver(cfg.JA2SET_DATS, cfg.TILESET_DIRS, cfg.BASE_TILESETS_SLF);
  const r = renderOne(src, resolver, code, { roofs: !args.includes('--no-roofs'), shadows: args.includes('--shadows'), applyHeight: args.includes('--height') });
  if (!r) { console.error(`Sector ${code} not found`); process.exit(1); }
  const dbg = path.join(cfg.DIST, 'debug'); fs.mkdirSync(dbg, { recursive: true });
  const sq = warpToContentSquare(r.img, TILE_W, TILE_H, r.dat.cols - 1);
  const ds = downscale(sq.canvas, sq.width, sq.height, 0.5);
  fs.writeFileSync(path.join(dbg, `square_${code}.png`), encodePNG(ds.rgba, ds.w, ds.h));
  console.log(`${code} (${r.dat.rows}x${r.dat.cols}, tileset ${r.dat.tilesetId}): iso ${r.img.width}x${r.img.height} -> square ${sq.width}x${sq.height} -> debug/square_${code}.png`);
  console.log('tile resolver:', { ...resolver.stats, missingFiles: [...resolver.stats.missingFiles] });
} else {
  buildAll(getArg('--detail', 0.5), getArg('--overview', 0.0625), getArg('--limit', 0) | 0, args.includes('--webp'), getArg('--webp-quality', 80) | 0);
}
