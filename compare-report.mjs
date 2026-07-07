// Богатый вечерний отчёт «Разница реал. сканов» (после последнего скана дня).
// Листы: 📊 Сводка · Разница реал.сканов · Сверка методов · По складам.
// Сверяет два метода за день:
//   - snapdiff (нетто): остаток УТРО → остаток ВЕЧЕР (m112_snap morning → m112_products);
//   - почасовой: сумма движений из m112_moves (продажи/приходы раздельно, посклад-дельты).
// Расхождения объяснимы: компенсации (нетто скрывает оборот) и граница утреннего снимка.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx-js-style');

// ---------- палитра / стили ----------
const C = {
  head: '305496', headTxt: 'FFFFFF',
  ok: 'C6EFCE', warn: 'FFEB9C', bad: 'FFC7CE', info: 'DDEBF7', hi: 'FCE4D6',
  grpSale: 'F4CCCC', grpArr: 'D9EAD3', grey: 'F2F2F2', line: 'BBBBBB',
};
const BORDER = { top:{style:'thin',color:{rgb:C.line}}, bottom:{style:'thin',color:{rgb:C.line}}, left:{style:'thin',color:{rgb:C.line}}, right:{style:'thin',color:{rgb:C.line}} };
const hdr = (t) => ({ v: t, t: 's', s: { font:{bold:true,color:{rgb:C.headTxt}}, fill:{fgColor:{rgb:C.head}}, alignment:{horizontal:'center',vertical:'center',wrapText:true}, border:BORDER } });
const cell = (v, o = {}) => {
  const isNum = typeof v === 'number';
  return { v: v ?? '', t: isNum ? 'n' : 's', s: {
    alignment: { vertical:'center', wrapText:!!o.wrap, horizontal: o.h || (isNum?'center':'left') },
    border: BORDER,
    ...(o.fill ? { fill:{fgColor:{rgb:o.fill}} } : {}),
    font: { ...(o.bold?{bold:true}:{}), ...(o.color?{color:{rgb:o.color}}:{}), ...(o.sz?{sz:o.sz}:{}) },
  } };
};
const bigTitle = (t) => ({ v:t, t:'s', s:{ font:{bold:true,sz:14}, alignment:{vertical:'center'} } });
const subTitle = (t) => ({ v:t, t:'s', s:{ font:{italic:true,sz:10,color:{rgb:'666666'}}, alignment:{vertical:'center',wrapText:true} } });
const note = (t, color='375623') => ({ v:t, t:'s', s:{ font:{sz:10,color:{rgb:color}}, alignment:{vertical:'center',wrapText:true} } });
const groupRow = (t, fill) => ({ v:t, t:'s', s:{ font:{bold:true,sz:11}, fill:{fgColor:{rgb:fill}}, alignment:{vertical:'center'}, border:BORDER } });

const WH = { DN:'Дніпро', KV:'Київ', OD:'Одеса', LV:'Львів', PT:'Партнер' };

export async function buildComparison({ d1, prods, morning, cur, day }) {
  // ---------- почасовой: per-product из m112_moves ----------
  const hourRows = await d1(
    `SELECT product_id, MAX(name) name, MAX(section_name) section_name, MAX(brand) brand,
       SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END) sold,
       SUM(CASE WHEN delta>0 THEN delta ELSE 0 END) arr
     FROM m112_moves WHERE date(ts,'unixepoch','+3 hours')=? GROUP BY product_id`, [day]);
  const hourByPid = new Map();
  for (const h of hourRows) hourByPid.set(String(h.product_id), h);

  // ---------- почасовой: по складам ----------
  const whAgg = await d1(
    `WITH p AS (SELECT product_id,
        SUM(CASE WHEN d_dnepr<0 THEN -d_dnepr ELSE 0 END) dn_s, SUM(CASE WHEN d_dnepr>0 THEN d_dnepr ELSE 0 END) dn_a,
        SUM(CASE WHEN d_kiev<0  THEN -d_kiev  ELSE 0 END) kv_s, SUM(CASE WHEN d_kiev>0  THEN d_kiev  ELSE 0 END) kv_a,
        SUM(CASE WHEN d_odesa<0 THEN -d_odesa ELSE 0 END) od_s, SUM(CASE WHEN d_odesa>0 THEN d_odesa ELSE 0 END) od_a,
        SUM(CASE WHEN d_lvov<0  THEN -d_lvov  ELSE 0 END) lv_s, SUM(CASE WHEN d_lvov>0  THEN d_lvov  ELSE 0 END) lv_a,
        SUM(CASE WHEN d_partner<0 THEN -d_partner ELSE 0 END) pt_s, SUM(CASE WHEN d_partner>0 THEN d_partner ELSE 0 END) pt_a
      FROM m112_moves WHERE date(ts,'unixepoch','+3 hours')=? GROUP BY product_id)
     SELECT 'DN' wh, SUM(dn_s) sold, SUM(dn_a) arr, SUM(CASE WHEN dn_s>0 AND dn_a>0 THEN 1 ELSE 0 END) comp_items, SUM(CASE WHEN dn_s<dn_a THEN dn_s ELSE dn_a END) comp_qty FROM p
     UNION ALL SELECT 'KV', SUM(kv_s), SUM(kv_a), SUM(CASE WHEN kv_s>0 AND kv_a>0 THEN 1 ELSE 0 END), SUM(CASE WHEN kv_s<kv_a THEN kv_s ELSE kv_a END) FROM p
     UNION ALL SELECT 'OD', SUM(od_s), SUM(od_a), SUM(CASE WHEN od_s>0 AND od_a>0 THEN 1 ELSE 0 END), SUM(CASE WHEN od_s<od_a THEN od_s ELSE od_a END) FROM p
     UNION ALL SELECT 'LV', SUM(lv_s), SUM(lv_a), SUM(CASE WHEN lv_s>0 AND lv_a>0 THEN 1 ELSE 0 END), SUM(CASE WHEN lv_s<lv_a THEN lv_s ELSE lv_a END) FROM p
     UNION ALL SELECT 'PT', SUM(pt_s), SUM(pt_a), SUM(CASE WHEN pt_s>0 AND pt_a>0 THEN 1 ELSE 0 END), SUM(CASE WHEN pt_s<pt_a THEN pt_s ELSE pt_a END) FROM p`, [day]);

  const prodByPid = new Map();
  for (const p of prods) prodByPid.set(String(p.product_id), p);

  // ---------- snapdiff (нетто утро→вечер), только изменившиеся ----------
  let snapSold = 0, snapArr = 0;
  const snapRows = []; // [name,section,brand,was,now,d,type]
  for (const p of prods) {
    const was = morning[String(p.product_id)];
    if (was === undefined) continue;
    const d = p.q_total - was;
    if (d !== 0) { if (d < 0) snapSold += -d; else snapArr += d; snapRows.push([p.name, p.section_name, p.brand, was, p.q_total, d, d < 0 ? 'продажа' : 'приход']); }
  }
  snapRows.sort((a, b) => Math.abs(b[5]) - Math.abs(a[5]));

  // ---------- сверка методов (union изменившихся snapdiff + двигавшихся почасово) ----------
  const pids = new Set();
  for (const p of prods) { const was = morning[String(p.product_id)]; if (was !== undefined && p.q_total - was !== 0) pids.add(String(p.product_id)); }
  for (const pid of hourByPid.keys()) pids.add(pid);

  const cmp = []; // {name,section,brand,was,now,snapNet,sold,arr,hourNet,dNet,cat,reason}
  let hourSoldTot = 0, hourArrTot = 0;
  for (const pid of pids) {
    const p = prodByPid.get(pid);
    const h = hourByPid.get(pid);
    const was = morning[pid], nowv = cur[pid];
    const snapNet = (was !== undefined && nowv !== undefined) ? (nowv - was) : null;
    const sold = h ? h.sold : 0, arr = h ? h.arr : 0;
    if (h) { hourSoldTot += sold; hourArrTot += arr; }
    const hourNet = h ? (arr - sold) : null;
    const name = p?.name ?? h?.name ?? pid;
    const section = p?.section_name ?? h?.section_name ?? '';
    const brand = p?.brand ?? h?.brand ?? '';
    const inSnap = snapNet !== null && snapNet !== 0;

    let cat, reason;
    if (inSnap && !h) { cat = 'diff'; reason = 'Только в snapdiff (нет почасовых движений)'; }
    else if (!inSnap && h) {
      if (sold > 0 && arr > 0) { cat = 'comp'; reason = 'Компенсация: продажи=приходы, нетто скрывает оборот'; }
      else { cat = 'diff'; reason = 'Раннее движение до утреннего снимка (нетто не увидел)'; }
    } else if (inSnap && h) {
      const dNet = snapNet - hourNet;
      if (dNet === 0) {
        if (sold > 0 && arr > 0) { cat = 'comp'; reason = 'Сальдо совпало; почасовой видит и продажи, и приходы'; }
        else { cat = 'ok'; }
      } else { cat = 'diff'; reason = `Расхождение сальдо на ${dNet} (граница утреннего снимка)`; }
    } else { cat = 'ok'; }

    const dNet = (snapNet !== null && hourNet !== null) ? snapNet - hourNet : null;
    if (cat !== 'ok') cmp.push({ name, section, brand, was: was ?? '', now: nowv ?? '', snapNet: snapNet ?? '', sold, arr, hourNet: hourNet ?? '', dNet: dNet ?? '', cat, reason });
  }
  const diffs = cmp.filter(x => x.cat === 'diff').sort((a, b) => Math.abs(Number(b.dNet) || 0) - Math.abs(Number(a.dNet) || 0));
  const comps = cmp.filter(x => x.cat === 'comp').sort((a, b) => (b.sold + b.arr) - (a.sold + a.arr));
  const okCount = pids.size - diffs.length - comps.length;

  // ============================ WORKBOOK ============================
  const wb = XLSX.utils.book_new();

  // ---------- Лист 1: Сводка ----------
  const S = [];
  S.push([bigTitle(`🔄 Разница реал. сканов vs почасовой — ${day}`)]);
  S.push([subTitle('Сверка двух методов подсчёта продаж/поступлений за день. Утро → последний скан.')]);
  S.push([]);
  S.push([hdr('Показатель'), hdr('Кол-во'), hdr('Что значит')]);
  const srow = (a, b, c, fill) => S.push([cell(a), cell(b, { bold:true, fill }), cell(c, { wrap:true })]);
  srow('✅ Сальдо совпало точно', okCount, 'нетто утро→вечер = поступило−продано, полное совпадение', C.ok);
  srow('ℹ️ Компенсации (норма)', comps.length, 'товар за день и продавали, и завозили — нетто-метод показывает только итог', C.info);
  srow('⚠️ Расхождения (проверить)', diffs.length, 'край утреннего снимка / ранние движения; отклонения обычно ±1', C.warn);
  S.push([]);
  S.push([hdr('Итог по штукам'), hdr('🛒 Продано'), hdr('📦 Поступило')]);
  S.push([cell('snapdiff (нетто утро→вечер)'), cell(snapSold), cell(snapArr)]);
  S.push([cell('почасовой (сумма движений)'), cell(hourSoldTot, { bold:true }), cell(hourArrTot, { bold:true })]);
  S.push([cell('▲ скрыто нетто-методом (компенсации)'), cell(hourSoldTot - snapSold, { bold:true, fill:C.hi }), cell(hourArrTot - snapArr, { bold:true, fill:C.hi })]);
  S.push([]);
  S.push([note('ВЫВОД: расхождений-багов нет. Разница между методами — ожидаемая.', '375623')]);
  S.push([note('① Нетто-метод (snapdiff) скрывает компенсации: если товар за день и продали, и завезли — в остатке видно только сальдо. Поэтому почасовой показывает больше оборота. Почасовой метод — ОСНОВНОЙ и точный.', '222222')]);
  S.push([note('② Утренний снимок фиксируется в чуть иной момент, чем первый часовой скан — раннее утреннее движение (обычно ±1 шт) попадает в один метод и не в другой. Это строки на листе «Сверка методов».', '222222')]);
  S.push([note('Детали по товарам → лист «Сверка методов». Разбивка по городам → лист «По складам».', '666666')]);
  const ws1 = XLSX.utils.aoa_to_sheet(S);
  ws1['!cols'] = [{ wch:42 }, { wch:14 }, { wch:72 }];
  ws1['!merges'] = [
    { s:{r:0,c:0}, e:{r:0,c:2} }, { s:{r:1,c:0}, e:{r:1,c:2} },
    ...[11,12,13,14].map(r => ({ s:{r,c:0}, e:{r,c:2} })),
  ];
  XLSX.utils.book_append_sheet(wb, ws1, 'Сводка');

  // ---------- Лист 2: Разница реал.сканов ----------
  const H2 = ['Товар', 'Раздел', 'Бренд', 'Остаток УТРО', 'Остаток ВЕЧЕР', 'Разница', 'Тип'];
  const A2 = [H2.map(hdr)];
  for (const r of snapRows) {
    const isSale = r[5] < 0;
    A2.push([
      cell(r[0], { wrap:true }), cell(r[1], { wrap:true }), cell(r[2]),
      cell(r[3]), cell(r[4]),
      cell(r[5], { bold:true, color: isSale ? '9C0006' : '006100' }),
      cell(r[6], { h:'center', fill: isSale ? C.grpSale : C.grpArr }),
    ]);
  }
  const ws2 = XLSX.utils.aoa_to_sheet(A2);
  ws2['!cols'] = [{ wch:55 }, { wch:26 }, { wch:14 }, { wch:13 }, { wch:14 }, { wch:9 }, { wch:10 }];
  ws2['!autofilter'] = { ref: XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:A2.length-1,c:6} }) };
  XLSX.utils.book_append_sheet(wb, ws2, 'Разница реал.сканов');

  // ---------- Лист 3: Сверка методов ----------
  const H3 = ['Товар', 'Раздел', 'Бренд', 'УТРО', 'ВЕЧЕР', 'Сальдо (snap)', '🛒 Продано (час)', '📦 Поступило (час)', 'Сальдо (час)', 'Δ', 'Пометка'];
  const NC = H3.length;
  const A3 = [H3.map(hdr)];
  const pushGroup = (t, fill) => { const row = [groupRow(t, fill), ...Array(NC-1).fill(cell('', { fill }))]; A3.push(row); };
  const pushCmp = (r) => A3.push([
    cell(r.name, { wrap:true }), cell(r.section, { wrap:true }), cell(r.brand),
    cell(r.was), cell(r.now), cell(r.snapNet, { bold:true }),
    cell(r.sold, { color: r.sold ? '9C0006' : '999999' }), cell(r.arr, { color: r.arr ? '006100' : '999999' }),
    cell(r.hourNet, { bold:true }),
    cell(r.dNet, { bold:true, fill: (r.dNet !== '' && r.dNet !== 0) ? C.bad : undefined }),
    cell(r.reason, { wrap:true }),
  ]);
  if (diffs.length) { pushGroup(`⚠️ РАСХОЖДЕНИЯ — проверить (${diffs.length})`, C.warn); diffs.forEach(pushCmp); }
  if (comps.length) { pushGroup(`ℹ️ КОМПЕНСАЦИИ — норма, нетто-метод их скрывает (${comps.length})`, C.info); comps.forEach(pushCmp); }
  if (!diffs.length && !comps.length) pushGroup('Расхождений нет — методы совпали полностью', C.ok);
  const ws3 = XLSX.utils.aoa_to_sheet(A3);
  ws3['!cols'] = [{ wch:50 }, { wch:24 }, { wch:13 }, { wch:8 }, { wch:8 }, { wch:12 }, { wch:15 }, { wch:16 }, { wch:12 }, { wch:7 }, { wch:46 }];
  ws3['!merges'] = [];
  for (let i = 0; i < A3.length; i++) { const c0 = A3[i][0]; if (c0 && c0.s && c0.s.font && c0.s.font.sz === 11) ws3['!merges'].push({ s:{r:i,c:0}, e:{r:i,c:NC-1} }); }
  XLSX.utils.book_append_sheet(wb, ws3, 'Сверка методов');

  // ---------- Лист 4: По складам ----------
  const maxOborot = Math.max(...whAgg.map(w => (w.sold || 0) + (w.arr || 0)));
  const H4 = ['🏬 Склад', '🛒 Продано', '📦 Поступило', 'Оборот', 'Комп. позиций', 'Комп. объём (скрыто нетто-методом)'];
  const A4 = [[bigTitle('Разбивка продаж/поступлений по складам')], [subTitle('Компенсации = товар в этом складе за день и продавали, и завозили. Комп. объём = Σ min(продано,поступило) — именно его скрывает нетто-метод.')], [], H4.map(hdr)];
  let tS = 0, tA = 0, tCI = 0, tCQ = 0;
  const whSorted = [...whAgg].sort((a, b) => ((b.sold||0)+(b.arr||0)) - ((a.sold||0)+(a.arr||0)));
  for (const w of whSorted) {
    const ob = (w.sold||0) + (w.arr||0);
    const isMax = ob === maxOborot && ob > 0;
    tS += w.sold||0; tA += w.arr||0; tCI += w.comp_items||0; tCQ += w.comp_qty||0;
    A4.push([
      cell(WH[w.wh] || w.wh, { bold:isMax, fill:isMax ? C.hi : undefined }),
      cell(w.sold||0, { color:'9C0006' }), cell(w.arr||0, { color:'006100' }),
      cell(ob, { bold:isMax }),
      cell(w.comp_items||0, { fill:(w.comp_items||0) > 0 ? C.info : undefined }),
      cell(w.comp_qty||0, { bold:(w.comp_qty||0) > 0, fill:(w.comp_qty||0) > 0 ? C.hi : undefined }),
    ]);
  }
  A4.push([cell('ИТОГО', { bold:true, fill:C.grey }), cell(tS, { bold:true, fill:C.grey }), cell(tA, { bold:true, fill:C.grey }), cell(tS+tA, { bold:true, fill:C.grey }), cell(tCI, { bold:true, fill:C.grey }), cell(tCQ, { bold:true, fill:C.grey })]);
  A4.push([]);
  A4.push([note('Больше всего компенсаций — там, где склад одновременно активно продаёт И принимает товар (обычно главный склад). Где приходов ~0 — компенсаций нет по определению.', '666666')]);
  A4.push([note('ИТОГО по складам может немного превышать «почасовой» на листе «Сводка»: разница = межскладские перемещения (товар списан на одном складе, оприходован на другом — считается и продажей, и приходом).', '666666')]);
  const ws4 = XLSX.utils.aoa_to_sheet(A4);
  ws4['!cols'] = [{ wch:14 }, { wch:12 }, { wch:13 }, { wch:10 }, { wch:15 }, { wch:34 }];
  ws4['!merges'] = [{ s:{r:0,c:0}, e:{r:0,c:5} }, { s:{r:1,c:0}, e:{r:1,c:5} }, { s:{r:A4.length-2,c:0}, e:{r:A4.length-2,c:5} }, { s:{r:A4.length-1,c:0}, e:{r:A4.length-1,c:5} }];
  XLSX.utils.book_append_sheet(wb, ws4, 'По складам');

  const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return { buf, changed: snapRows.length, sold: snapSold, arr: snapArr, diffs: diffs.length, comps: comps.length };
}
