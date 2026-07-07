// «Светофор» — матричный отчёт продаж товаров m112 по месяцам и по дням.
//  Строки: товары m112 (с продажами за период), сортировка по выручке.
//  Ячейка месяца: число = продано шт; цвет = ДОЛЯ дней в наличии = дни_в_наличии / отснятые_дни_месяца.
//    (проценты, а не абсолют — иначе в начале месяца всё было бы красным при неполных данных)
//  Ячейка дня: число = продано шт; цвет = был ли товар в наличии в это утро (зел/красн).
//  Наличие берём из утренних снимков m112_snap (kind='morning'): q_total>0 в этот день.
//  Плюс колонки: Продано, Выручка, ABC (по выручке 80/15/5), Скорость/день (продано / дни в наличии).
// Возвращает { buf } — xlsx (2 листа: «Светофор. по месяцам», «Светофор по дням»).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx-js-style');

// ---------- палитра светофора ----------
const CLR = {
  green: '63BE7B',   // ≥26 дней / в наличии / ABC=A
  lgreen: 'B7E1A1',  // 18–25 дней
  yellow: 'FFD666',  // 12–17 дней / ABC=B
  red: 'F8696B',     // <12 дней / нет в наличии / ABC=C
  head: '305496', headTxt: 'FFFFFF', grey: 'F2F2F2', line: 'BBBBBB',
};
const B = { top:{style:'thin',color:{rgb:CLR.line}}, bottom:{style:'thin',color:{rgb:CLR.line}}, left:{style:'thin',color:{rgb:CLR.line}}, right:{style:'thin',color:{rgb:CLR.line}} };
const hdr = (t) => ({ v:t, t:'s', s:{ font:{bold:true,color:{rgb:CLR.headTxt}}, fill:{fgColor:{rgb:CLR.head}}, alignment:{horizontal:'center',vertical:'center',wrapText:true}, border:B } });
const cell = (v, o={}) => { const n = typeof v==='number'; return { v: v ?? '', t: n?'n':'s', s:{
  alignment:{vertical:'center', horizontal:o.h||(n?'center':'left'), wrapText:!!o.wrap},
  border:B, ...(o.fill?{fill:{fgColor:{rgb:o.fill}}}:{}),
  font:{ ...(o.bold?{bold:true}:{}), ...(o.color?{color:{rgb:o.color}}:{}) },
  ...(o.fmt?{z:o.fmt}:{}),
} }; };

const UA_MON = ['','січ','лют','бер','квіт','трав','черв','лип','серп','вер','жовт','лист','груд'];
const monLabel = (ym) => { const [y,m] = ym.split('-'); return `${UA_MON[+m]}. ${y.slice(2)}`; };
const dayLabel = (d) => { const [ , m, dd] = d.split('-'); return `${dd}.${m}`; };

// цвет ячейки месяца по ДОЛЕ дней в наличии (дни_в_наличии / отснятые_дни_месяца)
//  ≥90% зел · 70–90% св.зел · 40–70% жёлт · 0–40% красн · нет снимков за месяц → без цвета
const monFill = (days, tracked) => {
  if (!tracked) return undefined;
  const pct = days / tracked;
  return pct >= 0.90 ? CLR.green : pct >= 0.70 ? CLR.lgreen : pct >= 0.40 ? CLR.yellow : CLR.red;
};
const abcFill = (a) => a === 'A' ? CLR.green : a === 'B' ? CLR.yellow : CLR.red;

export async function buildSvetofor({ d1 }) {
  // ---- продажи по товару и месяцу/дню ----
  const sales = await d1(
    `SELECT product_id, MAX(name) name, MAX(section_name) section, MAX(brand) brand,
       strftime('%Y-%m', ts,'unixepoch','+3 hours') ym,
       date(ts,'unixepoch','+3 hours') d,
       SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END) sold,
       SUM(CASE WHEN delta<0 THEN -delta*COALESCE(price,0) ELSE 0 END) revenue
     FROM m112_moves
     GROUP BY product_id, d
     HAVING sold > 0`);

  // ---- утренние снимки (наличие по дням) ----
  const snaps = await d1(`SELECT day, data FROM m112_snap WHERE kind='morning' ORDER BY day`);
  const snapDays = snaps.map(s => s.day);                      // список дней с данными о наличии
  const stockByDay = new Map();                               // day -> Set(product_id в наличии)
  for (const s of snaps) {
    const obj = JSON.parse(s.data);
    const set = new Set();
    for (const pid in obj) if (obj[pid] > 0) set.add(pid);
    stockByDay.set(s.day, set);
  }
  const monthsWithSnap = {};                                  // ym -> кол-во дней-снимков в месяце
  for (const day of snapDays) { const ym = day.slice(0,7); monthsWithSnap[ym] = (monthsWithSnap[ym]||0)+1; }

  // ---- агрегируем по товару ----
  const prod = new Map();  // pid -> {name,section,brand, soldByMonth{}, soldByDay{}, totalSold, totalRev}
  const allYm = new Set(), allDay = new Set();
  for (const r of sales) {
    const pid = String(r.product_id);
    let p = prod.get(pid);
    if (!p) { p = { name:r.name, section:r.section, brand:r.brand, soldByMonth:{}, soldByDay:{}, totalSold:0, totalRev:0 }; prod.set(pid, p); }
    p.soldByMonth[r.ym] = (p.soldByMonth[r.ym]||0) + r.sold;
    p.soldByDay[r.d] = (p.soldByDay[r.d]||0) + r.sold;
    p.totalSold += r.sold; p.totalRev += r.revenue;
    allYm.add(r.ym); allDay.add(r.d);
  }
  for (const d of snapDays) allDay.add(d);                     // дни-снимки без продаж тоже нужны как колонки? нет — только с продажами; но день наличия учитываем
  const months = [...allYm].sort();
  const days = [...allDay].sort();

  // дни в наличии по товару: за месяц и всего
  const stockDaysMonth = (pid, ym) => { let c=0; for (const day of snapDays) if (day.slice(0,7)===ym && stockByDay.get(day).has(pid)) c++; return c; };
  const stockDaysTotal = (pid) => { let c=0; for (const day of snapDays) if (stockByDay.get(day).has(pid)) c++; return c; };

  // ---- ABC по выручке ----
  const list = [...prod.entries()].sort((a,b) => b[1].totalRev - a[1].totalRev);
  const grandRev = list.reduce((s,[,p]) => s+p.totalRev, 0) || 1;
  let cum = 0;
  for (const [,p] of list) { cum += p.totalRev; const share = cum/grandRev; p.abc = share <= 0.80 ? 'A' : share <= 0.95 ? 'B' : 'C'; }

  const wb = XLSX.utils.book_new();

  // =============== ЛИСТ 1: по месяцам ===============
  {
    const head = ['Категорія\\Номенклатура','Розділ','Бренд','Продано\nшт','Виручка','ABC','Швидк./день', ...months.map(monLabel)];
    const A = [head.map(hdr)];
    for (const [pid,p] of list) {
      const sd = stockDaysTotal(pid);
      const speed = sd > 0 ? +(p.totalSold/sd).toFixed(1) : '';
      const row = [
        cell(p.name,{wrap:true}), cell(p.section,{wrap:true}), cell(p.brand),
        cell(p.totalSold,{bold:true}), cell(Math.round(p.totalRev)), cell(p.abc,{bold:true,h:'center',fill:abcFill(p.abc)}),
        cell(speed,{fmt:'0.0'}),
      ];
      for (const ym of months) {
        const sold = p.soldByMonth[ym] || 0;
        const days = stockDaysMonth(pid, ym);
        row.push(cell(sold || '', { h:'center', fill: monFill(days, monthsWithSnap[ym] || 0) }));
      }
      A.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(A);
    ws['!cols'] = [{wch:42},{wch:20},{wch:14},{wch:9},{wch:11},{wch:5},{wch:11}, ...months.map(()=>({wch:8}))];
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:0,c:0},e:{r:A.length-1,c:head.length-1}}) };
    ws['!freeze'] = { xSplit:3, ySplit:1 };
    XLSX.utils.book_append_sheet(wb, ws, 'Светофор. по месяцам');
  }

  // =============== ЛИСТ 2: по дням ===============
  {
    const head = ['Категорія\\Номенклатура','Розділ','Бренд','Продано\nшт','Виручка','ABC','Швидк./день', ...days.map(dayLabel)];
    const A = [head.map(hdr)];
    for (const [pid,p] of list) {
      const sd = stockDaysTotal(pid);
      const speed = sd > 0 ? +(p.totalSold/sd).toFixed(1) : '';
      const row = [
        cell(p.name,{wrap:true}), cell(p.section,{wrap:true}), cell(p.brand),
        cell(p.totalSold,{bold:true}), cell(Math.round(p.totalRev)), cell(p.abc,{bold:true,h:'center',fill:abcFill(p.abc)}),
        cell(speed,{fmt:'0.0'}),
      ];
      for (const d of days) {
        const sold = p.soldByDay[d] || 0;
        const hasSnap = stockByDay.has(d);
        const inStock = hasSnap && stockByDay.get(d).has(pid);
        // цвет: есть снимок → зелёный (в наличии) / красный (нет); нет снимка за день → без цвета
        const fill = hasSnap ? (inStock ? CLR.green : CLR.red) : undefined;
        row.push(cell(sold || '', { h:'center', fill }));
      }
      A.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(A);
    ws['!cols'] = [{wch:42},{wch:20},{wch:14},{wch:9},{wch:11},{wch:5},{wch:11}, ...days.map(()=>({wch:7}))];
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:0,c:0},e:{r:A.length-1,c:head.length-1}}) };
    ws['!freeze'] = { xSplit:3, ySplit:1 };
    XLSX.utils.book_append_sheet(wb, ws, 'Светофор по дням');
  }

  const buf = Buffer.from(XLSX.write(wb, { type:'buffer', bookType:'xlsx' }));
  return { buf, products: list.length, months: months.length, days: days.length, snapDays: snapDays.length };
}
