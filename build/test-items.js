'use strict';
// Validate worlditems.js against the real maps: walk each map's items, check the parse completes and
// every item index is valid, and dump a sample. Run: node build/test-items.js [SECTOR]
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { parseDat } = require('./dat');
const { parseWorldItems, IC_LBEGEAR } = require('./worlditems');

// item table (index -> {name, cls}) from Items.xml
const xml = fs.readFileSync(path.join(cfg.TABLEDATA_MAP, '..', 'Items', 'Items.xml'), 'utf8');
const tag = (b, t) => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(b); return m ? m[1].trim() : null; };
const items = {}; let maxIdx = 0; let m; const re = /<ITEM>([\s\S]*?)<\/ITEM>/g;
while ((m = re.exec(xml))) { const b = m[1], i = +tag(b, 'uiIndex'); if (Number.isNaN(i)) continue; items[i] = { name: tag(b, 'szItemName') || tag(b, 'szLongItemName') || ('#' + i), cls: +(tag(b, 'usItemClass') || 0) }; if (i > maxIdx) maxIdx = i; }
const lbeSet = new Set(Object.keys(items).filter((i) => items[i].cls & IC_LBEGEAR).map(Number));
console.log(`item table: ${Object.keys(items).length} items (max index ${maxIdx}), ${lbeSet.size} LBE-gear`);

const only = process.argv[2] && process.argv[2].toUpperCase();
const dir = cfg.MAPS_DIR;
const files = fs.readdirSync(dir).filter((f) => /\.dat$/i.test(f)).sort();
let mapsWithItems = 0, badMaps = 0;
for (const f of files) {
  const code = f.replace(/\.dat$/i, '').toUpperCase();
  if (only && code !== only) continue;
  const buf = fs.readFileSync(path.join(dir, f));
  let dat; try { dat = parseDat(buf); } catch (e) { continue; }
  const wi = parseWorldItems(buf, dat, lbeSet);
  if (!wi || wi.count === 0) continue;
  mapsWithItems++;
  const invalid = wi.items.filter((it) => it.usItem !== 0 && !items[it.usItem]).length;
  const tail = buf.length - wi.endOffset; // bytes left after items (should be small-ish: a few more sections)
  const ok = wi.complete && invalid === 0;
  if (!ok) badMaps++;
  console.log(`${code.padEnd(9)} ${dat.rows}x${dat.cols} maj${dat.major} min${dat.minor}  items=${String(wi.count).padEnd(4)} parsed=${wi.items.length} invalid=${invalid} complete=${wi.complete} tailBytes=${tail}  ${ok ? 'OK' : '*** BAD ***'}`);
  if (only) {
    // dump notable items grouped, with map positions
    const cols = dat.cols;
    const byItem = {};
    for (const it of wi.items) {
      if (!items[it.usItem]) continue;
      const k = items[it.usItem].name;
      (byItem[k] = byItem[k] || []).push(`${it.usItem % 1 === 0 ? '' : ''}(${it.gridNo % cols},${(it.gridNo / cols) | 0})${it.level ? 'L' + it.level : ''}${it.attachments.length ? '+' + it.attachments.map((a) => items[a] ? items[a].name : a).join('/') : ''}`);
    }
    const names = Object.keys(byItem).sort();
    console.log(`  ${names.length} distinct item types:`);
    for (const nm of names) console.log(`   ${(byItem[nm].length + 'x').padStart(4)} ${nm.padEnd(28)} @ ${byItem[nm].slice(0, 6).join(' ')}${byItem[nm].length > 6 ? ' …' : ''}`);
  }
}
console.log(`\n${mapsWithItems} maps with items, ${badMaps} bad.`);
