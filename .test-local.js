const fs = require('fs');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const main = scripts.reduce((a, b) => b[1].length > a[1].length ? b : a)[1];

const start = main.indexOf('function localParseActivity(text)');
const end = main.indexOf('// 用 AI 从小红书原文里提字段');
const code = main.slice(start, end);
fs.writeFileSync('/tmp/localparse.cjs', code + '\nmodule.exports = { localParseActivity };');

const { localParseActivity } = require('/tmp/localparse.cjs');

const sample = `AQUA DANCE第2️⃣4️⃣期活动（确认有面光灯）
于5月16日 13:00 aespa➕TWS专场
地点于悠唐一层中庭（松山棉店已撤 为大场地）
背板 地贴 全场相机官摄
5月16日活动官摄团队：姜姜老师 小天老师 鸣皓老师 小小帅老师
全体+个人官摄：鸣皓老师
个人直拍官摄：姜姜老师 小天老师 小小帅老师
路演投稿从即日开始
路演投稿截止5.13日晚23:00
于截止后公布过审名单
「路演报名流程」
路演投稿邮箱：13901276431@163.com（备注5.16悠唐路演投稿）不备注投稿无效
投稿格式：（不按格式投稿无效）
歌名+团名：
组名：
组长：
组员+对应位置：
组长联系方式（vx联系方式）：
审核视频
音频mp3会在后续统一进行收集
撤稿一定要提前说`;

const r = localParseActivity(sample);
console.log('\n=== 本地识别 用户真实公告 ===\n');
for (const [k, v] of Object.entries(r)) {
  console.log(`${k}:`);
  console.log(`  ${v}\n`);
}
