/**
 * 700 學習計畫日曆（忍者修行計畫）· 瀏覽器層功能走查（安全網）
 *
 *   node _tools/ui_tests.mjs                     → 對專案根目錄跑
 *   node _tools/ui_tests.mjs --dir=<資料夾>       → 對別的副本跑（反向測試用，可給絕對路徑）
 *
 * 2026-10-03 建立：只寫測試、不改 App。改版前先把「功能照樣能用」釘成測試。
 *
 * 寫法（沿用 605 500碗 ui_tests.mjs 與 609 小釣手踩過的坑）：
 * - 不用 --virtual-time-budget；一律真實時間輪詢（until）。
 * - 自己起 http server 並送 Cache-Control: no-store；直接試綁埠，不先探測（Windows SO_REUSEADDR 會綁到別人的埠）。
 * - 全新 Chrome profile（暫存資料夾，結束即刪）：同網域其他 App 共用 localStorage，
 *   用獨立 profile＋127.0.0.1 才不會讀到／誤刪別人的 key。
 * - 日期固定：init script 把 Date 換成「固定起點＋真實經過時間」的子類別，今天＝2028-02-28（週一，閏年），
 *   時區用 CDP 固定 Asia/Taipei。結果不隨執行日期變動，也順便測閏日 2/29 與月底跨月。
 * - 點擊用 tap()：先 hit-test（elementFromPoint 必須打到目標本身或其子元素）再送真實滑鼠事件，
 *   覆蓋層吃掉點擊會直接失敗，不會被 element.click() 繞過。
 * - 經驗值用測試自己的規則獨立計算（打勾 +5、當天全達成 +20、精熟章節 +30；同一項取消再打勾不重複給），
 *   不呼叫 App 的函式；等級門檻表也在測試裡獨立寫一份。
 * - 每條斷言印出樣本數或實際值，避免「空集合讓測試假通過」。
 */
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirArg = process.argv.find((a) => a.startsWith('--dir='));
const ROOT = path.resolve(HERE, '..', dirArg ? dirArg.slice(6) : '.');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.txt': 'text/plain', '.woff2': 'font/woff2' };

// 固定的「今天」：2028-02-28 10:00（台北）＝ 02:00Z。2028 是閏年，2/28 是週一、2/29 週二、3/1 週三。
const FIXED_TS = Date.UTC(2028, 1, 28, 2, 0, 0);
const KEY = 'study_planner_v1';
const WALLET = 'ninja_xp_v1';
// 等級門檻（測試獨立維護一份；來源＝更新記錄／記憶封存的 11 階表，門檻 XP 不變）
const RANKS = [['修行新生', 0], ['見習忍者', 600], ['初階忍者', 2000], ['中階忍者', 4500], ['專精忍者', 8000], ['高階忍者', 13000],
  ['精英忍者', 19000], ['隱密精銳', 27000], ['宗師候補', 37000], ['傳說之忍', 48000], ['忍者宗師', 60000]];
const rankOf = (xp) => RANKS.filter((r) => xp >= r[1]).pop();
// 經驗值規則（獨立計算）
const XP_TASK = 5, XP_FULLDAY = 20, XP_CHAP = 30;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

/* ── 靜態伺服器：直接試綁，失敗換下一個 ── */
async function startServer() {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
    const p = path.join(ROOT, rel);
    if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    try {
      const b = await readFile(p);
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(b);
    } catch { res.writeHead(404); res.end(); }
  });
  for (let port = 8820; port < 8860; port++) {
    const okBind = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (okBind) return { server, port };
  }
  throw new Error('找不到可用的埠');
}

/* ── 最小 CDP 用戶端 ── */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.errors = []; this.requests = []; this.initScript = null; this.navs = 0; this.alertLog = []; }
  static async connect(debugPort) {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* Chrome 還沒起來 */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('接不上 Chrome 的 CDP');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waiters.has(m.id)) { c.waiters.get(m.id)(m); c.waiters.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') {
        c.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown');
      }
      if (m.method === 'Network.requestWillBeSent') c.requests.push(m.params.request.url);
      // 主框架每完成一次導覽（含 location.reload）就 +1；用來抓「頁面自己重整」
      if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId && /^http/.test(m.params.frame.url)) c.navs++;
    };
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await c.send('Network.enable');
    await c.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Taipei' });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.waiters.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  async until(expr, ms = 8000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await this.eval(expr)) return true; } catch { /* 還沒 ready */ }
      await sleep(step);
    }
    return false;
  }
  async width(w, h = 844) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(200);
  }
  /**
   * 開頁面。clear=true：清本機資料（只有這個暫存 profile 的 127.0.0.1）；onb=true：標記已看過引導／新功能提示，
   * 免得彈窗蓋住畫面；wallet：預先放入共用經驗值錢包。Date 固定在 FIXED_TS 起算。
   * clear=false 用來測「重新整理後資料還在」——這時 init script 不碰 localStorage。
   */
  async open(url, { clear = true, onb = true, wallet = null } = {}) {
    // ⚠ addScriptToEvaluateOnNewDocument 會累積：每次 open 先移除上一支，再整段包成 IIFE。
    try { this.alertLog.push(...((await this.eval('window.__alerts||[]')) || [])); } catch {}
    if (this.initScript) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.initScript });
    const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const RealDate = Date, off = ${FIXED_TS} - RealDate.now();
      class FixedDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(RealDate.now() + off); else super(...a); }
        static now() { return RealDate.now() + off; }
      }
      window.Date = FixedDate;
      try {
        ${clear ? 'localStorage.clear();' : ''}
        ${clear && onb ? `localStorage.setItem('sp_onb','1'); localStorage.setItem('sp_whatsnew_v1','1');` : ''}
        ${clear && wallet ? `localStorage.setItem('${WALLET}', ${JSON.stringify(JSON.stringify(wallet))});` : ''}
      } catch(e) {}
      window.__alerts = []; window.__confirms = []; window.__prints = 0;
      window.alert = (m) => { window.__alerts.push(String(m)); };
      window.confirm = (m) => { window.__confirms.push(String(m)); return true; };
      window.print = () => { window.__prints++; };
    })();` });
    this.initScript = r.result && r.result.identifier;
    await this.send('Page.navigate', { url });
    return this.until(`document.querySelectorAll('#mGrid .mcell').length === 42 && /年/.test(document.getElementById('mTitle').textContent)`, 15000);
  }
  /** 真實點擊：捲到畫面中央 → hit-test 必須打到目標 → 送滑鼠按下／放開。回傳 true 或失敗原因。 */
  async tap(elExpr) {
    const prep = await this.eval(`(()=>{const e=(${elExpr}); if(!e) return {err:'找不到元素'}; e.scrollIntoView({block:'center',inline:'center'}); return {ok:1}})()`);
    if (!prep || prep.err) return prep || { err: 'eval 失敗' };
    await sleep(80);
    const r = await this.eval(`(()=>{const e=(${elExpr}); const b=e.getBoundingClientRect(); const x=b.left+b.width/2, y=b.top+b.height/2;
      const h=document.elementFromPoint(x,y); return {x,y,w:b.width,hgt:b.height,hit:!!h&&(h===e||e.contains(h)),by:h?(h.id||String(h.className)||h.tagName):null}})()`);
    if (!r.hit || r.w === 0) return { err: '點不到（被蓋住或不可見）', ...r };
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    }
    await sleep(60);
    return true;
  }
}

const { server, port } = await startServer();
const BASE = `http://127.0.0.1:${port}/`;
const profile = await mkdtemp(path.join(tmpdir(), 'planner-ui-'));
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let c;
async function cleanup() {
  // 等 Chrome 真的結束再刪暫存 profile（只等 300ms 時 Windows 檔案仍被鎖，profile 會殘留在 %TEMP%）
  const exited = chrome.exitCode !== null ? Promise.resolve() : new Promise((r) => chrome.once('exit', r));
  try { chrome.kill(); } catch {}
  server.close();
  await Promise.race([exited, sleep(5000)]);
  try { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
}

/* ── 頁面讀取小工具（只讀 DOM / localStorage，不呼叫 App 函式）── */
const CELLS = `[...document.querySelectorAll('#mGrid .mcell')].map((e,i)=>({i,out:e.classList.contains('out'),we:e.classList.contains('we'),today:e.classList.contains('today'),
  n:+e.querySelector('.mnum').textContent,corner:((e.querySelector('.mn,.mchk')||{}).textContent||''),brief:((e.querySelector('.mbrief')||{}).textContent||'')}))`;
const inCell = (d) => `[...document.querySelectorAll('#mGrid .mcell:not(.out)')].find(e=>e.querySelector('.mnum').textContent==='${d}')`;
const navBtn = (t) => `document.querySelector('nav button[data-t="${t}"]')`;
const btnText = (scope, txt) => `[...document.querySelectorAll(${JSON.stringify(scope)})].find(b=>b.textContent.includes(${JSON.stringify(txt)}))`;
const state = () => c.eval(`JSON.parse(localStorage.getItem('${KEY}')||'null')`);
const plannerXP = () => c.eval(`((JSON.parse(localStorage.getItem('${WALLET}')||'{}').bySrc)||{}).planner||0`);
const title = () => c.eval(`((document.getElementById('mTitle')||{childNodes:[]}).childNodes[0]||{textContent:''}).textContent.trim()`);
const dnow = () => c.eval(`document.getElementById('dnow').textContent`);
const tasks = () => c.eval(`[...document.querySelectorAll('#taskList .card.task')].map(e=>({t:e.querySelector('.tl').textContent.trim(),done:e.classList.contains('done')}))`);
const sheetOpen = () => c.until(`document.getElementById('ov').classList.contains('show')`, 3000).then(async (v) => { await sleep(320); return v; });
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();   // m 為 0 起算；Node 端獨立計算

try {
  c = await CDP.connect(DEBUG_PORT);
  await c.width(390);

  console.log('\n[1 第一次造訪]');
  c.navs = 0;
  const loaded = await c.open(BASE, { clear: true, onb: false });
  ok('1.1 月曆載入：42 格', loaded, await c.eval(`document.querySelectorAll('#mGrid .mcell').length`));
  // 1.2 第一次造訪：先什麼都不做，等 SW 啟用後再多等 2 秒，主框架導覽次數必須仍是 1（頁面沒有自己重整）。
  //     ⚠ 放在最前面：第一版先做其他斷言，自己重整發生在讀標題途中，整支測試崩潰而不是這條失敗（反向測試抓到）。
  const swActive = await c.until(`navigator.serviceWorker.getRegistration().then(r=>!!(r&&r.active&&r.active.state==='activated'))`, 10000);
  await sleep(2000);
  ok('1.2 🔴 第一次造訪 Service Worker 啟用後，頁面不會自己重整（導覽次數＝1，實測 ' + c.navs + '）', swActive && c.navs === 1, { swActive, navs: c.navs });
  await c.until(`document.querySelectorAll('#mGrid .mcell').length === 42`, 8000);
  ok('1.3 固定日期生效：標題「2028 年 2 月」', (await title()) === '2028 年 2 月', await title());
  const todayCells = (await c.eval(CELLS)).filter((x) => x.today);
  ok('1.4 只有一格標成今天，且是 28 號（樣本 ' + todayCells.length + ' 格）', todayCells.length === 1 && todayCells[0].n === 28 && !todayCells[0].out, todayCells);
  ok('1.5 新使用者看到新手引導', await c.until(`document.getElementById('ov').classList.contains('show') && document.getElementById('sheet').textContent.includes('歡迎來到忍者修行計畫')`, 4000));
  await sleep(350);
  const tOnb = await c.tap(btnText('#sheet button', '開始修行'));
  ok('1.6 按「開始修行」關閉引導並記住（sp_onb＝1）', tOnb === true && await c.until(`!document.getElementById('ov').classList.contains('show') && localStorage.getItem('sp_onb')==='1'`, 3000), tOnb);
  c.navs = 0;
  await c.open(BASE, { clear: false });
  const controlled = await c.until(`!!navigator.serviceWorker.controller`, 6000);
  await sleep(1500);
  ok('1.7 第二次開啟由 SW 控制，且同樣只導覽 1 次（實測 ' + c.navs + '）', controlled && c.navs === 1, { controlled, navs: c.navs });
  ok('1.8 第二次開啟不再跳新手引導／新功能提示', !(await c.eval(`document.getElementById('ov').classList.contains('show')`)));

  console.log('\n[2 日曆切換：月／日、跨月、跨年、閏年]');
  const feb = await c.eval(CELLS);
  const febIn = feb.filter((x) => !x.out);
  ok('2.1 2028 年 2 月（閏年）有 ' + febIn.length + ' 天（應為 ' + daysIn(2028, 1) + '）', febIn.length === daysIn(2028, 1) && febIn.length === 29, febIn.length);
  const firstDow = new Date(2028, 1, 1).getDay();
  ok('2.2 1 號排在正確的星期欄（第 ' + febIn[0].i + ' 格，應為 ' + firstDow + '）且日期連續 1..' + febIn.length,
    febIn[0].i === firstDow && febIn.every((x, k) => x.n === k + 1), febIn.slice(0, 3));
  const weOk = feb.filter((x) => x.we === (x.i % 7 === 0 || x.i % 7 === 6)).length;
  ok('2.3 週末欄著色正確（42 格中 ' + weOk + ' 格正確）', weOk === 42, weOk);
  let t = await c.tap(`document.querySelector('.mhead button[aria-label="下個月"]')`);
  await c.until(`document.getElementById('mTitle').textContent.includes('2028 年 3 月')`, 2000);
  const mar = (await c.eval(CELLS)).filter((x) => !x.out);
  ok('2.4 按「下個月」→ 2028 年 3 月，' + mar.length + ' 天、1 號在第 ' + (mar[0] || {}).i + ' 格',
    t === true && (await title()) === '2028 年 3 月' && mar.length === 31 && mar[0].i === new Date(2028, 2, 1).getDay(), { t, title: await title(), n: mar.length });
  for (let i = 0; i < 3; i++) await c.tap(`document.querySelector('.mhead button[aria-label="上個月"]')`);
  await c.until(`document.getElementById('mTitle').textContent.includes('2027 年 12 月')`, 2000);
  const dec = (await c.eval(CELLS)).filter((x) => !x.out);
  ok('2.5 往前三個月跨年 → 2027 年 12 月（' + dec.length + ' 天）', (await title()) === '2027 年 12 月' && dec.length === 31, await title());
  await c.tap(`document.getElementById('mTitle')`);
  ok('2.6 點月份標題回到本月（2028 年 2 月）', await c.until(`document.getElementById('mTitle').textContent.includes('2028 年 2 月')`, 2000), await title());
  await c.eval(`monthShift(12)`);
  const feb29 = (await c.eval(CELLS)).filter((x) => !x.out);
  ok('2.7 平年 2029 年 2 月只有 ' + feb29.length + ' 天', (await title()) === '2029 年 2 月' && feb29.length === 28, { title: await title(), n: feb29.length });
  await c.tap(`document.getElementById('mTitle')`);
  await c.until(`document.getElementById('mTitle').textContent.includes('2028 年 2 月')`, 2000);

  const tabs = ['today', 'week', 'prog', 'set', 'month'];
  const tabRes = [];
  for (const tb of tabs) {
    const r = await c.tap(navBtn(tb));
    await sleep(120);
    const vis = await c.eval(`['month','today','week','prog','set'].filter(x=>!document.getElementById('tab-'+x).classList.contains('hide'))`);
    const on = await c.eval(`[...document.querySelectorAll('nav button.on')].map(b=>b.dataset.t)`);
    tabRes.push({ tb, r, vis, on });
  }
  ok('2.8 底部五個分頁逐一切換：每次只顯示該分頁、該按鈕亮起（樣本 ' + tabRes.length + '）',
    tabRes.length === 5 && tabRes.every((x) => x.r === true && x.vis.length === 1 && x.vis[0] === x.tb && x.on.length === 1 && x.on[0] === x.tb), tabRes);

  await c.tap(navBtn('today'));
  const d0 = await dnow();
  ok('2.9 今日頁顯示「2月28日 週一・今天」', d0.includes('2月28日') && d0.includes('週一') && d0.includes('今天'), d0);
  await c.tap(`document.querySelector('.datebar button[aria-label="後一天"]')`);
  const d1 = await dnow();
  ok('2.10 後一天 → 閏日「2月29日 週二」', d1.includes('2月29日') && d1.includes('週二') && d1.includes('點此回到今天'), d1);
  await c.tap(`document.querySelector('.datebar button[aria-label="後一天"]')`);
  const d2 = await dnow();
  ok('2.11 再後一天跨月 → 「3月1日 週三」', d2.includes('3月1日') && d2.includes('週三'), d2);
  await c.tap(`document.querySelector('.datebar button[aria-label="前一天"]')`);
  const d3 = await dnow();
  ok('2.12 前一天跨月回 → 「2月29日」', d3.includes('2月29日'), d3);
  await c.tap(`document.getElementById('dnow')`);
  ok('2.13 點日期回到今天（2月28日）', (await dnow()).includes('2月28日') && (await dnow()).includes('今天'), await dnow());

  console.log('\n[3 新增當天任務 → 出現在對的日期]');
  await c.tap(navBtn('month'));
  t = await c.tap(inCell(29));
  ok('3.1 月曆點 29 號 → 跳到今日頁 2月29日', t === true && await c.until(`!document.getElementById('tab-today').classList.contains('hide') && document.getElementById('dnow').textContent.includes('2月29日')`, 2000), { t, d: await dnow() });
  ok('3.2 2月29日 起初沒有任務（0 張卡）', (await tasks()).length === 0, await tasks());
  t = await c.tap(`document.getElementById('fab')`);
  ok('3.3 按 ＋ 打開快速新增（範本 ' + await c.eval(`document.querySelectorAll('.qgrid button').length`) + ' 個）',
    t === true && await sheetOpen() && await c.eval(`document.querySelectorAll('.qgrid button').length >= 5`), t);
  await c.tap(btnText('.qgrid button', '自訂'));
  ok('3.4 選「自訂」→ 新增事件表單標明「2月29日 這一天」', await sheetOpen() && await c.eval(`document.getElementById('sheet').textContent.includes('2月29日 這一天')`),
    await c.eval(`document.querySelector('#sheet p') && document.querySelector('#sheet p').textContent`));
  const LBL = '閏日測試任務';
  await c.eval(`(()=>{const i=document.getElementById('mlbl'); i.value=${JSON.stringify(LBL)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
  t = await c.tap(`document.querySelector('#sheet .sbtns .ok')`);
  await c.until(`!document.getElementById('ov').classList.contains('show')`, 2000);
  let tk = await tasks();
  ok('3.5 存檔後 2月29日 出現 1 張任務卡「' + LBL + '」', t === true && tk.length === 1 && tk[0].t.includes(LBL), tk);
  let st = await state();
  const evKeys = Object.keys(st.events || {}).filter((k) => (st.events[k] || []).some((e) => e.label === LBL));
  ok('3.6 本機資料只記在 2028-02-29（含此任務的日期：' + evKeys.join(',') + '）', evKeys.length === 1 && evKeys[0] === '2028-02-29', evKeys);
  await c.tap(navBtn('month'));
  let cells = await c.eval(CELLS);
  const c29 = cells.find((x) => !x.out && x.n === 29), c28 = cells.find((x) => !x.out && x.n === 28), c31 = cells.find((x) => x.out && x.n === 1 && x.i > 28);
  ok('3.7 月曆 29 號格顯示 0/1 與任務名稱', !!c29 && c29.corner === '0/1' && c29.brief.includes(LBL), c29);
  ok('3.8 相鄰的 28 號與 3/1 格沒有任務（不會錯置）', !!c28 && !!c31 && c28.corner === '' && c31.corner === '', { c28, c31 });
  const withTask = cells.filter((x) => x.corner);
  ok('3.9 2 月整張月曆只有 1 格有任務（實測 ' + withTask.length + ' 格）', withTask.length === 1, withTask.map((x) => x.n));
  ok('3.10 本月概況列出 2/29', await c.eval(`[...document.querySelectorAll('#mSum .mday .date')].map(e=>e.textContent).join(',') === '2/29'`),
    await c.eval(`[...document.querySelectorAll('#mSum .mday .date')].map(e=>e.textContent)`));
  await c.tap(`document.querySelector('.mhead button[aria-label="下個月"]')`);
  await c.until(`document.getElementById('mTitle').textContent.includes('2028 年 3 月')`, 2000);
  const marCells = await c.eval(CELLS);
  const out29 = marCells.find((x) => x.out && x.n === 29 && x.i < 7);
  ok('3.11 3 月月曆前面露出的 2/29（灰格）同樣標 0/1，3 月本身 0 格有任務',
    !!out29 && out29.corner === '0/1' && marCells.filter((x) => !x.out && x.corner).length === 0, { out29, n: marCells.filter((x) => !x.out && x.corner).length });
  await c.tap(`document.getElementById('mTitle')`);

  console.log('\n[4 重新整理後還在]');
  c.navs = 0;
  await c.open(BASE, { clear: false });
  cells = await c.eval(CELLS);
  const r29 = cells.find((x) => !x.out && x.n === 29);
  ok('4.1 重新整理後月曆 29 號仍是 0/1「' + LBL + '」', !!r29 && r29.corner === '0/1' && r29.brief.includes(LBL), r29);
  await c.tap(inCell(29));
  await c.until(`document.getElementById('dnow').textContent.includes('2月29日')`, 2000);
  tk = await tasks();
  ok('4.2 重新整理後點進 2/29 任務卡仍在（' + tk.length + ' 張）', tk.length === 1 && tk[0].t.includes(LBL), tk);

  console.log('\n[5 編輯]');
  const idBefore = (await state()).events['2028-02-29'][0].id;
  t = await c.tap(`document.querySelector('#taskList .card.task .tl')`);
  ok('5.1 點任務卡打開「編輯事件」', t === true && await sheetOpen() && await c.eval(`document.querySelector('#sheet h3').textContent.includes('編輯事件') && document.getElementById('mlbl').value===${JSON.stringify(LBL)}`),
    await c.eval(`document.querySelector('#sheet h3') && document.querySelector('#sheet h3').textContent`));
  const LBL2 = LBL + '（改）';
  await c.eval(`(()=>{const i=document.getElementById('mlbl'); i.value=${JSON.stringify(LBL2)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
  await c.eval(`document.getElementById('sth').value='14'; document.getElementById('enh').value='15'; 1`);
  await c.tap(`document.querySelector('#sheet .sbtns .ok')`);
  await c.until(`!document.getElementById('ov').classList.contains('show')`, 2000);
  st = await state();
  const evs = st.events['2028-02-29'] || [];
  ok('5.2 編輯後仍是同一筆（id 相同、筆數 ' + evs.length + '）、標題與時間已更新',
    evs.length === 1 && evs[0].id === idBefore && evs[0].label === LBL2 && evs[0].start === '14:00' && evs[0].end === '15:00', evs);
  tk = await tasks();
  ok('5.3 今日頁卡片標題跟著變', tk.length === 1 && tk[0].t.includes(LBL2), tk);

  console.log('\n[6 每週固定時段 → 只出現在對的星期]');
  await c.tap(navBtn('week'));
  t = await c.tap(btnText('#tab-week button', '新增固定時段'));
  ok('6.1 修行表「＋新增固定時段」打開表單', t === true && await sheetOpen() && await c.eval(`document.querySelector('#sheet h3').textContent.includes('新增固定時段')`), t);
  await c.tap(btnText('#sheet .dur button', '清除'));
  await c.tap(`document.querySelector('#dp button[data-d="3"]')`);
  const onDays = await c.eval(`[...document.querySelectorAll('#dp button.on')].map(b=>+b.dataset.d)`);
  ok('6.2 星期只選週三（選中 ' + JSON.stringify(onDays) + '）', onDays.length === 1 && onDays[0] === 3, onDays);
  const RL = '週三固定修行';
  await c.eval(`(()=>{const i=document.getElementById('mlbl'); i.value=${JSON.stringify(RL)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
  await c.tap(`document.querySelector('#sheet .sbtns .ok')`);
  await c.until(`!document.getElementById('ov').classList.contains('show')`, 2000);
  const wk = await c.eval(`[...document.querySelectorAll('#weekGrid .wkday')].map(e=>({d:e.querySelector('.wh').childNodes[0].textContent.trim(),n:e.querySelectorAll('.wblk').length}))`);
  ok('6.3 修行表 7 天中只有週三有 1 個時段（' + wk.map((x) => x.d + x.n).join(' ') + '）',
    wk.length === 7 && wk.filter((x) => x.n > 0).length === 1 && wk.find((x) => x.d === '週三').n === 1, wk);
  await c.tap(navBtn('month'));
  cells = await c.eval(CELLS);
  const wantDays = [];
  for (let d = 1; d <= daysIn(2028, 1); d++) if (new Date(2028, 1, d).getDay() === 3) wantDays.push(d);
  wantDays.push(29);   // 第 3 節的單次任務
  wantDays.sort((a, b) => a - b);
  const gotDays = cells.filter((x) => !x.out && x.corner).map((x) => x.n);
  ok('6.4 2 月月曆有任務的日子＝所有週三＋2/29（應 ' + JSON.stringify(wantDays) + '，實 ' + JSON.stringify(gotDays) + '）',
    wantDays.length === 5 && JSON.stringify(gotDays) === JSON.stringify(wantDays), { wantDays, gotDays });
  const outWed = cells.filter((x) => x.out && x.corner).map((x) => x.i % 7);
  ok('6.5 月曆上前後月的灰格中，有任務的也都落在週三欄（樣本 ' + outWed.length + ' 格）', outWed.length >= 1 && outWed.every((col) => col === 3), outWed);

  console.log('\n[7 完成任務 → 修行值／等級（測試獨立計算）]');
  await c.tap(navBtn('set'));
  t = await c.tap(btnText('#setBody button', '載入國中三年科目範本'));
  ok('7.1 設定頁載入國中三年科目範本（21 科）', t === true && await c.until(`(JSON.parse(localStorage.getItem('${KEY}')).subjects||[]).length === 21`, 3000),
    (await state()).subjects.length);
  const xp0 = await plannerXP();
  ok('7.2 起始本計畫修行值＝0（實測 ' + xp0 + '）', xp0 === 0, xp0);
  let expect = 0; const credited = new Set(); const fullDays = new Set();
  const credit = (k) => { if (!credited.has(k)) { credited.add(k); expect += XP_TASK; } };
  await c.tap(navBtn('month'));
  await c.tap(inCell(29));
  await c.until(`document.getElementById('dnow').textContent.includes('2月29日')`, 2000);
  const nTask = (await tasks()).length;
  t = await c.tap(`document.querySelector('#taskList .card.task .tk')`);
  credit('e|2028-02-29');
  await c.until(`!!document.querySelector('#taskList .card.task.done')`, 2000);
  let xp = await plannerXP();
  ok('7.3 打勾 1 項任務（當天 ' + nTask + ' 張卡）→ 修行值 ' + xp + '（應 ' + expect + '）', t === true && nTask === 1 && xp === expect, { xp, expect });
  await c.tap(`document.querySelector('#taskList .card.task .tk')`);
  await c.until(`!document.querySelector('#taskList .card.task.done')`, 2000);
  await c.tap(`document.querySelector('#taskList .card.task .tk')`);
  await c.until(`!!document.querySelector('#taskList .card.task.done')`, 2000);
  xp = await plannerXP();
  ok('7.4 取消再打勾不重複給分 → 仍 ' + xp + '（應 ' + expect + '）', xp === expect, { xp, expect });
  ok('7.5 當天還差每日英語，尚未「全部完成」', await c.eval(`!document.querySelector('#todayStatus .tstat.alldone') && !!document.querySelector('#todayStatus .tstat')`));
  t = await c.tap(btnText('#engBox button.eb', '修行完成'));
  credit('eng|2028-02-29');
  if (!fullDays.has('2028-02-29')) { fullDays.add('2028-02-29'); expect += XP_FULLDAY; }
  await c.until(`!!document.querySelector('#todayStatus .tstat.alldone')`, 2000);
  xp = await plannerXP();
  ok('7.6 完成每日英語 → 當天全達成：修行值 ' + xp + '（應 ' + expect + '＝5+5+20）', t === true && xp === expect && expect === 30, { t, xp, expect });
  ok('7.7 今日儀表板顯示 2/2 全部完成', await c.eval(`document.querySelector('#todayStatus .ring span').textContent==='2/2' && document.querySelector('#todayStatus').textContent.includes('全部完成')`),
    await c.eval(`(document.querySelector('#todayStatus .ring span')||{}).textContent`));
  await c.tap(navBtn('month'));
  cells = await c.eval(CELLS);
  const done29 = cells.find((x) => !x.out && x.n === 29);
  ok('7.8 月曆 29 號變成 ✓（全達成）', !!done29 && done29.corner === '✓', done29);

  await c.tap(navBtn('prog'));
  const maCard = `[...document.querySelectorAll('#progList .card.subj')].find(e=>e.querySelector('.snm').textContent.includes('數學'))`;
  await c.tap(`${maCard}.querySelector('.sh')`);
  await c.until(`!!(${maCard}).querySelector('.chap .ck')`, 2000);
  const nChap = await c.eval(`(${maCard}).querySelectorAll('.chap').length`);
  t = await c.tap(`(${maCard}).querySelector('.chap .ck')`);
  expect += XP_CHAP;
  await c.until(`(${maCard}).querySelector('.chap').classList.contains('done')`, 2000);
  xp = await plannerXP();
  ok('7.9 精熟國一數學第 1 章（該科 ' + nChap + ' 章）→ 修行值 ' + xp + '（應 ' + expect + '）', t === true && nChap === 9 && xp === expect, { xp, expect, nChap });
  await c.tap(`(${maCard}).querySelector('.chap .ck')`);
  await c.until(`!(${maCard}).querySelector('.chap').classList.contains('done')`, 2000);
  await c.tap(`(${maCard}).querySelector('.chap .ck')`);
  await c.until(`(${maCard}).querySelector('.chap').classList.contains('done')`, 2000);
  xp = await plannerXP();
  ok('7.10 章節取消再勾不重複給分 → 仍 ' + xp, xp === expect, { xp, expect });
  const rk = rankOf(expect), nx = RANKS[RANKS.indexOf(rk) + 1];
  const rankTxt = await c.eval(`document.querySelector('#progStats .rankcard').textContent`);
  ok('7.11 等級卡：' + rk[0] + '、修行值 ' + expect + '、離「' + nx[0] + '」還差 ' + (nx[1] - expect),
    rankTxt.includes('忍者等級：' + rk[0]) && rankTxt.includes('本計畫修行值 ' + expect) && rankTxt.includes(`離「${nx[0]}」還差 ${nx[1] - expect}`), rankTxt.slice(0, 160));
  ok('7.12 頁首也顯示「' + rk[0] + '」與 🏅' + expect, await c.eval(`document.getElementById('hsub').textContent.includes(${JSON.stringify(rk[0])}) && document.getElementById('hsub').textContent.includes('🏅${expect} ')`),
    await c.eval(`document.getElementById('hsub').textContent`));
  await c.open(BASE, { clear: false });
  ok('7.13 重新整理後修行值仍是 ' + expect + '、2/29 打勾仍在', (await plannerXP()) === expect &&
    Object.keys(((await state()).checks || {})['2028-02-29'] || {}).length === 2, { xp: await plannerXP(), checks: (await state()).checks });

  console.log('\n[8 刪除]');
  await c.tap(inCell(29));
  await c.until(`document.getElementById('dnow').textContent.includes('2月29日')`, 2000);
  const nBefore = (await tasks()).length;
  t = await c.tap(`document.querySelector('#taskList .card.task .del')`);
  await c.until(`document.querySelectorAll('#taskList .card.task').length === 0`, 2000);
  st = await state();
  ok('8.1 刪除 2/29 單次任務：卡片 ' + nBefore + '→' + (await tasks()).length + '、有先詢問確認、資料已移除',
    t === true && nBefore === 1 && (await tasks()).length === 0 && (await c.eval(`window.__confirms.length`)) === 1 && !(st.events || {})['2028-02-29'], { t, ev: st.events, confirms: await c.eval(`window.__confirms`) });
  ok('8.2 刪任務不會倒扣修行值（仍 ' + await plannerXP() + '）', (await plannerXP()) === expect);
  await c.tap(navBtn('week'));
  t = await c.tap(`document.querySelector('#weekGrid .wblk')`);
  await sheetOpen();
  await c.tap(`document.querySelector('#sheet .sbtns .rm')`);
  await c.until(`document.querySelectorAll('#weekGrid .wblk').length === 0`, 2000);
  st = await state();
  ok('8.3 刪除週三固定時段：修行表 0 個時段、資料 routine 0 筆', t === true && (await c.eval(`document.querySelectorAll('#weekGrid .wblk').length`)) === 0 && st.routine.length === 0, st.routine);
  await c.tap(navBtn('month'));
  ok('8.4 刪除後 2 月月曆沒有任何任務格', (await c.eval(CELLS)).filter((x) => x.corner).length === 0, (await c.eval(CELLS)).filter((x) => x.corner).map((x) => x.n));

  console.log('\n[9 等級只算本計畫（bySrc.planner），不算其他英語 App]');
  const wallet = { xp: 100594, bySrc: { planner: 595, vocab2000: 99999 }, correct: 0, units: 0, jutsu: [], seen: { planner: 1 } };
  await c.open(BASE, { clear: true, wallet });
  const h0 = await c.eval(`document.getElementById('hsub').textContent`);
  ok('9.1 錢包總值 100594、本計畫 595 → 頁首仍是「' + rankOf(595)[0] + '」🏅595', h0.includes(rankOf(595)[0]) && h0.includes('🏅595 ') && !h0.includes('忍者宗師'), h0);
  await c.tap(navBtn('today'));
  await c.tap(`document.getElementById('fab')`);
  await sheetOpen();
  await c.tap(btnText('.qgrid button', '自訂'));
  await sheetOpen();
  await c.eval(`(()=>{const i=document.getElementById('mlbl'); i.value='升級測試'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
  await c.tap(`document.querySelector('#sheet .sbtns .ok')`);
  await c.until(`!document.getElementById('ov').classList.contains('show') && document.querySelectorAll('#taskList .card.task').length===1`, 2000);
  ok('9.2 FAB 新增的任務記在今天 2028-02-28', !!((await state()).events || {})['2028-02-28'], Object.keys((await state()).events || {}));
  await c.tap(`document.querySelector('#taskList .card.task .tk')`);
  await c.until(`!!document.querySelector('#taskList .card.task.done')`, 2000);
  const w1 = await c.eval(`JSON.parse(localStorage.getItem('${WALLET}'))`);
  const want = 595 + XP_TASK;
  ok('9.3 打勾 1 項 → 本計畫 ' + w1.bySrc.planner + '（應 ' + want + '）、錢包總值 ' + w1.xp + '（應 ' + (100594 + XP_TASK) + '）、英語 App 經驗不動',
    w1.bySrc.planner === want && w1.xp === 100594 + XP_TASK && w1.bySrc.vocab2000 === 99999, w1);
  const h1 = await c.eval(`document.getElementById('hsub').textContent`);
  ok('9.4 跨過 600 門檻 → 頁首升為「' + rankOf(want)[0] + '」', rankOf(want)[0] === '見習忍者' && h1.includes('見習忍者') && h1.includes('🏅' + want + ' '), h1);
  await c.tap(navBtn('prog'));
  const progTxt = await c.eval(`document.getElementById('progStats').textContent`);
  ok('9.5 其他英語 App 的經驗只在「額外英語修行 +99999」鼓勵卡顯示，等級卡仍是見習忍者',
    progTxt.includes('額外英語修行') && progTxt.includes('+99999') && progTxt.includes('忍者等級：見習忍者'), progTxt.slice(0, 200));

  console.log('\n[10 版面：手機寬度、按鈕大小]');
  await c.open(BASE, { clear: true });
  await c.tap(navBtn('set'));
  await c.tap(btnText('#setBody button', '載入完整示範'));
  await c.until(`(JSON.parse(localStorage.getItem('${KEY}')).routine||[]).length >= 5`, 3000);
  ok('10.0 載入完整示範（科目 ' + (await state()).subjects.length + '、固定時段 ' + (await state()).routine.length + '）當版面測試資料',
    (await state()).subjects.length === 21 && (await state()).routine.length >= 5);
  for (const w of [360, 390]) {
    await c.width(w);
    const over = [];
    for (const tb of ['month', 'today', 'week', 'prog', 'set']) {
      await c.eval(`go('${tb}')`);
      await sleep(150);
      const m = await c.eval(`[document.documentElement.scrollWidth, window.innerWidth]`);
      if (m[0] > m[1] + 1) over.push({ tb, m });
    }
    ok(`10.${w} ${w}px 五個分頁都沒有水平捲動（溢出 ${over.length}/5）`, over.length === 0, over);
    const sizes = [];
    for (const [tb, sel] of [['month', 'nav button, .mhead button'], ['today', '.datebar button, #fab'], ['set', '#setBody .btn']]) {
      await c.eval(`go('${tb}')`);
      await sleep(120);
      sizes.push(...await c.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>e.offsetParent||getComputedStyle(e).position==='fixed').map(e=>{const r=e.getBoundingClientRect(); return {h:Math.round(r.height), t:(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,10)}})`));
    }
    const small = sizes.filter((x) => x.h < 40);
    ok(`10.${w}b ${w}px 主要按鈕（導覽列／換月／換日／＋／設定頁按鈕，共 ${sizes.length} 顆）高度都 ≥ 40px（最矮 ${Math.min(...sizes.map((x) => x.h))}）`,
      sizes.length >= 15 && small.length === 0, small.slice(0, 5));
    await c.eval(`go('today')`);
    await sleep(120);
    const tks = await c.eval(`[...document.querySelectorAll('#taskList .card.task .tk')].map(e=>Math.round(e.getBoundingClientRect().height))`);
    ok(`10.${w}c ${w}px 任務打勾框（${tks.length} 個）高度 ≥ 28px（現行規格；實測 ${[...new Set(tks)].join('/')}）`, tks.length >= 1 && tks.every((h) => h >= 28), tks);
  }
  await c.width(390);

  console.log('\n[11 沒有錯誤、沒有意外的對外連線]');
  ok('11.1 沒有未捕捉的 JS 例外', c.errors.length === 0, c.errors.slice(0, 3));
  const allAlerts = [...c.alertLog, ...((await c.eval(`window.__alerts`)) || [])];
  ok('11.2 整個走查（含每次重開頁前收集的）沒有跳出 alert（' + allAlerts.length + ' 則）', allAlerts.length === 0, allAlerts);
  const hosts = [...new Set(c.requests.filter((u) => /^https?:/i.test(u)).map((u) => new URL(u).hostname))];
  const unexpected = hosts.filter((h) => h !== '127.0.0.1' && !/(^|\.)googleapis\.com$|(^|\.)gstatic\.com$/.test(h));
  ok('11.3 只連本機（＋Google 字型）；沒有連到其他網域（請求 ' + c.requests.length + ' 次，主機：' + hosts.join(', ') + '）', c.requests.length > 0 && unexpected.length === 0, unexpected);
} catch (e) {
  fail++;
  console.log('  FAIL 測試程式本身出錯：' + (e && e.stack || e));
} finally {
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + '　通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  await cleanup();
  process.exit(fail ? 1 : 0);
}
