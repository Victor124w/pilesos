// «Светофор» — матричный отчёт продаж товаров m112 по месяцам и по дням.
//  Иерархия (группировка строк с кнопками 1/2/3): Розділ → Бренд → Номенклатура.
//    - ветка Розділ  — заливка #FFE8B3, ABC/выручка группы;
//    - ветка Бренд   — заливка чуть светлее #FFF3D6;
//    - позиции внутри бренда — обычные строки, сортировка по названию А-Я.
//  Сортировка групп (Розділ, Бренд) — по выручке ↓ (= порядок ABC).
//  Ячейка периода у позиции: число = продано шт; цвет = ДОЛЯ дней в наличии
//    = дни_в_наличии / отснятые_дни (по утренним снимкам m112_snap kind='morning'):
//    ≥90% зел · 70–90 св.зел · 40–70 жёлт · 0–40 красн. Для дней — зел/красн (был/не был утром).
//  Ячейка периода у группы: сумма продаж детей, заливка цветом ветки.
//  Колонки: Продано, Выручка, ABC (по выручке 80/15/5), Швидк./день (продано / дни в наличии).
// Возвращает { buf } — xlsx (2 листа: «Светофор. по месяцам», «Светофор по дням»).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx-js-style');

const CLR = {
  green: '63BE7B', lgreen: 'B7E1A1', yellow: 'FFD666', red: 'F8696B',
  sec: 'FFE8B3', bra: 'FFF3D6',           // заливки веток Розділ / Бренд
  head: '305496', headTxt: 'FFFFFF', line: 'BBBBBB',
};
const B = { top:{style:'thin',color:{rgb:CLR.line}}, bottom:{style:'thin',color:{rgb:CLR.line}}, left:{style:'thin',color:{rgb:CLR.line}}, right:{style:'thin',color:{rgb:CLR.line}} };
const hdr = (t) => ({ v:t, t:'s', s:{ font:{bold:true,color:{rgb:CLR.headTxt}}, fill:{fgColor:{rgb:CLR.head}}, alignment:{horizontal:'center',vertical:'center',wrapText:true}, border:B } });
const cell = (v, o={}) => { const n = typeof v==='number'; return { v: v ?? '', t: n?'n':'s', s:{
  alignment:{ vertical:'center', horizontal:o.h||(n?'center':'left'), wrapText:!!o.wrap, ...(o.indent?{indent:o.indent}:{}) },
  border:B, ...(o.fill?{fill:{fgColor:{rgb:o.fill}}}:{}),
  font:{ ...(o.bold?{bold:true}:{}), ...(o.color?{color:{rgb:o.color}}:{}) },
  ...(o.fmt?{z:o.fmt}:{}),
} }; };

const UA_MON = ['','січ','лют','бер','квіт','трав','черв','лип','серп','вер','жовт','лист','груд'];
const monLabel = (ym) => { const [y,m] = ym.split('-'); return `${UA_MON[+m]}. ${y.slice(2)}`; };
const dayLabel = (d) => { const [ , m, dd] = d.split('-'); return `${dd}.${m}`; };
const monFill = (days, tracked) => { if (!tracked) return undefined; const p = days/tracked; return p>=0.90?CLR.green:p>=0.70?CLR.lgreen:p>=0.40?CLR.yellow:CLR.red; };
const abcFill = (a) => a==='A'?CLR.green:a==='B'?CLR.yellow:CLR.red;
const abcOf = (sortedRevs) => { const tot = sortedRevs.reduce((s,x)=>s+x.rev,0)||1; let c=0; for (const x of sortedRevs){ c+=x.rev; const sh=c/tot; x.abc = sh<=0.80?'A':sh<=0.95?'B':'C'; } };

export async function buildSvetofor({ d1 }) {
  // ---- продажи по товару и дню ----
  const sales = await d1(
    `SELECT product_id, MAX(name) name, MAX(section_name) section, MAX(brand) brand,
       date(ts,'unixepoch','+3 hours') d,
       SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END) sold,
       SUM(CASE WHEN delta<0 THEN -delta*COALESCE(price,0) ELSE 0 END) revenue
     FROM m112_moves GROUP BY product_id, d HAVING sold > 0`);

  // ---- утренние снимки (наличие по дням) ----
  const snaps = await d1(`SELECT day, data FROM m112_snap WHERE kind='morning' ORDER BY day`);
  const snapDays = snaps.map(s => s.day);
  const stockByDay = new Map();
  for (const s of snaps) { const o = JSON.parse(s.data); const set = new Set(); for (const pid in o) if (o[pid] > 0) set.add(pid); stockByDay.set(s.day, set); }
  const monthsWithSnap = {}; for (const day of snapDays) { const ym = day.slice(0,7); monthsWithSnap[ym] = (monthsWithSnap[ym]||0)+1; }

  // ---- агрегируем по товару ----
  const prod = new Map();
  const allYm = new Set();
  for (const r of sales) {
    const pid = String(r.product_id);
    let p = prod.get(pid);
    if (!p) { p = { pid, name:r.name, section:r.section||'—', brand:r.brand||'—', byMonth:{}, byDay:{}, sold:0, rev:0 }; prod.set(pid, p); }
    const ym = r.d.slice(0,7);
    p.byMonth[ym] = (p.byMonth[ym]||0) + r.sold;
    p.byDay[r.d] = (p.byDay[r.d]||0) + r.sold;
    p.sold += r.sold; p.rev += r.revenue;
    allYm.add(ym);
  }
  const months = [...allYm].sort();
  const days = [...new Set(sales.map(r=>r.d))].sort();
  const stockDaysMonth = (pid, ym) => { let c=0; for (const day of snapDays) if (day.slice(0,7)===ym && stockByDay.get(day).has(pid)) c++; return c; };
  const stockDaysTotal = (pid) => { let c=0; for (const day of snapDays) if (stockByDay.get(day).has(pid)) c++; return c; };

  // глобальный ABC позиций (по выручке)
  const gp = [...prod.values()].map(p => ({ p, rev:p.rev })); gp.sort((a,b)=>b.rev-a.rev); abcOf(gp);
  for (const x of gp) x.p.abc = x.abc;

  // ---- иерархия: Розділ → Бренд → позиции ----
  const secMap = new Map();  // section -> { sold, rev, byMonth, byDay, brands:Map }
  for (const p of prod.values()) {
    let s = secMap.get(p.section);
    if (!s) { s = { name:p.section, sold:0, rev:0, byMonth:{}, byDay:{}, brands:new Map() }; secMap.set(p.section, s); }
    s.sold += p.sold; s.rev += p.rev;
    for (const k in p.byMonth) s.byMonth[k]=(s.byMonth[k]||0)+p.byMonth[k];
    for (const k in p.byDay) s.byDay[k]=(s.byDay[k]||0)+p.byDay[k];
    let b = s.brands.get(p.brand);
    if (!b) { b = { name:p.brand, sold:0, rev:0, byMonth:{}, byDay:{}, items:[] }; s.brands.set(p.brand, b); }
    b.sold += p.sold; b.rev += p.rev; b.items.push(p);
    for (const k in p.byMonth) b.byMonth[k]=(b.byMonth[k]||0)+p.byMonth[k];
    for (const k in p.byDay) b.byDay[k]=(b.byDay[k]||0)+p.byDay[k];
  }
  // ABC разделов + сортировка
  const secArr = [...secMap.values()]; const secAbc = secArr.map(s=>({ ref:s, rev:s.rev })); secAbc.sort((a,b)=>b.rev-a.rev); abcOf(secAbc);
  for (const x of secAbc) x.ref.abc = x.abc;
  const sortedSecs = secAbc.map(x=>x.ref);
  // ABC брендов внутри раздела + сортировка
  for (const s of sortedSecs) {
    const bl = [...s.brands.values()]; const ba = bl.map(b=>({ ref:b, rev:b.rev })); ba.sort((a,b)=>b.rev-a.rev); abcOf(ba);
    for (const x of ba) x.ref.abc = x.abc;
    s.sortedBrands = ba.map(x=>x.ref);
    for (const b of s.sortedBrands) b.items.sort((x,y)=> String(x.name).localeCompare(String(y.name), 'uk'));
  }

  const wb = XLSX.utils.book_new();

  // строит один лист (periods — список ym или дней; isMonth — режим цвета)
  const buildSheet = (periods, isMonth, sheetName) => {
    const head = ['Категорія\\Номенклатура','Розділ','Бренд','Продано\nшт','Виручка','ABC','Швидк./день', ...periods.map(isMonth?monLabel:dayLabel)];
    const A = [head.map(hdr)];
    const rows = [{}]; // строка заголовка
    const byX = (obj, per) => obj[per] || '';

    for (const s of sortedSecs) {
      // --- ветка Розділ (level 0) ---
      const secRow = [
        cell(s.name, { bold:true, wrap:true, fill:CLR.sec }), cell('', {fill:CLR.sec}), cell('', {fill:CLR.sec}),
        cell(s.sold, { bold:true, fill:CLR.sec }), cell(Math.round(s.rev), { fill:CLR.sec }),
        cell(s.abc, { bold:true, h:'center', fill:abcFill(s.abc) }), cell('', { fill:CLR.sec }),
      ];
      for (const per of periods) secRow.push(cell(byX(isMonth?s.byMonth:s.byDay, per), { h:'center', fill:CLR.sec }));
      A.push(secRow); rows.push({ level:0 });

      for (const b of s.sortedBrands) {
        // --- ветка Бренд (level 1) ---
        const braRow = [
          cell(b.name, { bold:true, indent:1, fill:CLR.bra }), cell('', {fill:CLR.bra}), cell('', {fill:CLR.bra}),
          cell(b.sold, { bold:true, fill:CLR.bra }), cell(Math.round(b.rev), { fill:CLR.bra }),
          cell(b.abc, { bold:true, h:'center', fill:abcFill(b.abc) }), cell('', { fill:CLR.bra }),
        ];
        for (const per of periods) braRow.push(cell(byX(isMonth?b.byMonth:b.byDay, per), { h:'center', fill:CLR.bra }));
        A.push(braRow); rows.push({ level:1 });

        for (const p of b.items) {
          // --- позиция (level 2) ---
          const sd = stockDaysTotal(p.pid);
          const speed = sd>0 ? +(p.sold/sd).toFixed(1) : '';
          const row = [
            cell(p.name, { wrap:true, indent:2 }), cell(p.section, { wrap:true }), cell(p.brand),
            cell(p.sold, { bold:true }), cell(Math.round(p.rev)),
            cell(p.abc, { bold:true, h:'center', fill:abcFill(p.abc) }), cell(speed, { fmt:'0.0' }),
          ];
          for (const per of periods) {
            const sold = (isMonth?p.byMonth:p.byDay)[per] || 0;
            let fill;
            if (isMonth) fill = monFill(stockDaysMonth(p.pid, per), monthsWithSnap[per]||0);
            else { const has = stockByDay.has(per); fill = has ? (stockByDay.get(per).has(p.pid)?CLR.green:CLR.red) : undefined; }
            row.push(cell(sold || '', { h:'center', fill }));
          }
          A.push(row); rows.push({ level:2 });
        }
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(A);
    ws['!cols'] = [{wch:44},{wch:20},{wch:14},{wch:9},{wch:11},{wch:5},{wch:11}, ...periods.map(()=>({wch: isMonth?8:7}))];
    ws['!rows'] = rows;
    ws['!outline'] = { above: true };                     // шапка ветки СВЕРХУ
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:0,c:0},e:{r:A.length-1,c:head.length-1}}) };
    ws['!freeze'] = { xSplit:3, ySplit:1 };
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  };

  buildSheet(months, true, 'Светофор. по месяцам');
  buildSheet(days, false, 'Светофор по дням');

  const buf = Buffer.from(XLSX.write(wb, { type:'buffer', bookType:'xlsx' }));
  return { buf, products: prod.size, months: months.length, days: days.length, snapDays: snapDays.length };
}
