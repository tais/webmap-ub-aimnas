'use strict';
// Decode a sector's base + roof-overlay webp and emit: base (interiors), overlay-over-grey (roofs),
// and the composite. Run: node build/inspect-roof.js F14
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const { encodePNG } = require('./png');
const cfg = require('./config');
const code = (process.argv[2] || 'F14');
const W = 1600, H = 800;
function pam(p) {
  const tmp = path.join(os.tmpdir(), 'ir_' + path.basename(p) + '.pam');
  execFileSync('dwebp', ['-scale', String(W), String(H), '-pam', p, '-o', tmp], { stdio: 'ignore' });
  const b = fs.readFileSync(tmp); const e = b.indexOf('ENDHDR\n') + 7;
  const w = +/WIDTH (\d+)/.exec(b.slice(0, e))[1], h = +/HEIGHT (\d+)/.exec(b.slice(0, e))[1];
  fs.unlinkSync(tmp); return { rgba: b.slice(e), w, h };
}
const dbg = path.join(cfg.DIST, 'debug'); fs.mkdirSync(dbg, { recursive: true });
const base = pam(path.join(cfg.DIST, 'sectors', code + '.webp'));
const roof = pam(path.join(cfg.DIST, 'sectors', code + '_roof.webp'));
const n = base.w * base.h;
fs.writeFileSync(path.join(dbg, `chk_${code}_base.png`), encodePNG(Buffer.from(base.rgba), base.w, base.h));
const grey = Buffer.alloc(n * 4), comp = Buffer.from(base.rgba);
for (let i = 0; i < n; i++) {
  const a = roof.rgba[i * 4 + 3];
  if (a) { for (let c = 0; c < 3; c++) { grey[i*4+c] = roof.rgba[i*4+c]; comp[i*4+c] = roof.rgba[i*4+c]; } grey[i*4+3]=255; comp[i*4+3]=255; }
  else { grey[i*4]=90; grey[i*4+1]=90; grey[i*4+2]=96; grey[i*4+3]=255; }
}
fs.writeFileSync(path.join(dbg, `chk_${code}_roof.png`), encodePNG(grey, roof.w, roof.h));
fs.writeFileSync(path.join(dbg, `chk_${code}_comp.png`), encodePNG(comp, base.w, base.h));
console.log(`${code}: wrote dist/debug/chk_${code}_{base,roof,comp}.png`);
