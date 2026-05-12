// 在 Node 里模拟浏览器跑前端 JS，看具体哪个函数抛错
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
let src = m[1].replace(/^\s*boot\(\);?\s*$/m, '');

function makeEl() {
  const fake = {};
  return new Proxy(fake, {
    get(t, k) {
      if (k === 'value' || k === 'textContent' || k === 'innerHTML' || k === 'src') return t[k] ?? '';
      if (k === 'style') return new Proxy({}, { get(o, kk){ return o[kk] ?? ''; }, set(o, kk, v){ o[kk]=v; return true; } });
      if (k === 'classList') return { add(){}, remove(){}, toggle(){}, contains:()=>false };
      if (k === 'dataset') return t._dataset || (t._dataset = {});
      if (k === 'addEventListener') return ()=>{};
      if (k === 'querySelectorAll') return ()=>[];
      if (k === 'querySelector') return ()=>null;
      if (k === 'appendChild' || k === 'removeChild' || k === 'remove') return ()=>{};
      if (k === 'files') return [];
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

global.document = {
  getElementById: () => makeEl(),
  querySelectorAll: () => [],
  querySelector: () => null,
  body: { appendChild(){}, removeChild(){} },
  activeElement: { tagName: 'BODY' },
  createElement: () => makeEl(),
};
global.window = { addEventListener(){} };
global.localStorage = { getItem:()=>null, setItem(){}, removeItem(){} };
global.location = { search:'', origin:'http://localhost', reload(){} };
global.URLSearchParams = class { get(){return null;} };
global.fetch = async () => ({ ok:false, status:0, json:async()=>({}) });
global.setInterval = () => {};
global.setTimeout = () => {};
global.clearTimeout = () => {};
global.URL = { createObjectURL:()=>'', revokeObjectURL(){} };
global.Blob = class {};
global.FormData = class { append(){} };
global.navigator = { clipboard:{ writeText:async()=>{} } };
global.confirm = () => true;
global.alert = () => {};
global.prompt = () => '';

// 暴露脚本里需要的标识符
const callTest = `
;
state.user = { id: 1, name: '特别', avatar: '👤' };
state.songs = [{
  id: 10, owner_id: 1, my_role: 'owner', title: 'wda', artist: 'aespa',
  type: 'new', notes: '', owner: { id:1, name:'特别' },
  team: [{ user_id:1, name:'特别', avatar:'👤', position:'', status:'active', joined_at:0 }],
  rehearsals: [],
  performances: [{
    id: 100, song_id: 10, name:'5.17aqua随舞', city:'北京', date:'2026-05-17', time:'下午4点',
    location:'待定', outfit:'', outfit_images:[], status:'planned', notes:'',
    attendance:[{user_id:1, status:'yes', name:'特别', avatar:'👤'}],
    member_outfits:[]
  }]
}];
currentSongId = 10;
try { openPerfModal(); console.log('✅ openPerfModal() 没抛错'); }
catch (e) { console.log('❌ openPerfModal() 抛错:', e.message, '\\n', (e.stack||'').split('\\n').slice(0,5).join('\\n')); }
try { openPerfModal(100); console.log('✅ openPerfModal(100) 没抛错'); }
catch (e) { console.log('❌ openPerfModal(100) 抛错:', e.message, '\\n', (e.stack||'').split('\\n').slice(0,5).join('\\n')); }
try { renderPerformances(); console.log('✅ renderPerformances() 没抛错'); }
catch (e) { console.log('❌ renderPerformances() 抛错:', e.message, '\\n', (e.stack||'').split('\\n').slice(0,5).join('\\n')); }
`;

try {
  // 用 eval 让顶层 let/const 暴露给后续代码
  eval(src + callTest);
} catch (e) {
  console.log('❌ 加载脚本时异常:', e.message);
  console.log((e.stack||'').split('\n').slice(0,5).join('\n'));
}
