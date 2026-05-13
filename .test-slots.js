const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
fs.writeFileSync('/tmp/embed.js', m[1]);
require('child_process').execSync('node --check /tmp/embed.js', { stdio: 'inherit' });
console.log('✅ index.html JS');

const srv = fs.readFileSync(__dirname + '/server.js', 'utf8');
const checks = [
  ['后端 position_slots 列', srv.includes('position_slots TEXT NOT NULL DEFAULT')],
  ['后端 ALTER 迁移', srv.includes('ALTER TABLE songs ADD COLUMN position_slots')],
  ['后端 sanitizePositionSlots', srv.includes('function sanitizePositionSlots')],
  ['后端 POST 接受 slots', srv.includes("const { title, artist, type, notes, position_slots }")],
  ['后端 GET 反序列化', srv.includes('s.position_slots = JSON.parse')],
  ['前端 KPOP_GROUPS', html.includes('const KPOP_GROUPS = {')],
  ['前端 aespa 成员', html.includes('Karina') && html.includes('Ningning')],
  ['前端 suggestSlots', html.includes('function suggestSlots')],
  ['前端 onArtistInput', html.includes('function onArtistInput')],
  ['前端 saveSong 传 slots', html.includes('position_slots: songSlotsDraft.slice()')],
  ['前端 队伍 slot-row', html.includes('class="slot-row"')],
  ['前端 编辑队伍 模态', html.includes('<h3>编辑队伍</h3>')],
  ['前端 editSlotsDraft', html.includes('let editSlotsDraft')],
  ['前端 slots 改了才 PATCH', html.includes('if (slotsChanged)')],
];
for (const [l, ok] of checks) console.log((ok ? '✅' : '❌'), l);

// 测识别
const kgroups = {
  aespa: ['Karina', 'Winter', 'Giselle', 'Ningning'],
  BLACKPINK: ['Jisoo', 'Jennie', 'Rosé', 'Lisa'],
  TWICE: ['Nayeon'],
};
function norm(s) { return s.trim().toLowerCase().replace(/[()\s\-_.·・]/g, ''); }
const map = {};
for (const [n, mem] of Object.entries(kgroups)) map[norm(n)] = { name: n, members: mem };
console.log('--- 识别测试 ---');
['aespa', 'AESPA', '  AeSpA  ', 'blackpink', 'BLACKPINK', 'Black-Pink', 'TWICE', '不存在的团'].forEach(a => {
  const r = map[norm(a)];
  console.log(`  "${a}" →`, r ? r.name + ` (${r.members.length}人)` : '未识别');
});
