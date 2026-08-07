// Закрепление строк/колонок (freeze panes) в готовом xlsx.
// community `xlsx` НЕ пишет заморозку — свойство ws['!freeze'] он молча игнорирует,
// поэтому впрыскиваем <pane> в XML всех листов через fflate.
// Зеркало bot/src/xlsx-freeze.ts — правку делать в ОБОИХ (общего пакета у репо нет).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');

const col = (n) => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s || 'A';
};

function paneXml(xSplit, ySplit) {
  const topLeft = `${col(xSplit + 1)}${ySplit + 1}`;
  const active = xSplit > 0 ? (ySplit > 0 ? 'bottomRight' : 'topRight') : 'bottomLeft';
  const attrs = [
    xSplit > 0 ? `xSplit="${xSplit}"` : '',
    ySplit > 0 ? `ySplit="${ySplit}"` : '',
    `topLeftCell="${topLeft}"`, `activePane="${active}"`, 'state="frozen"',
  ].filter(Boolean).join(' ');
  const sel = [];
  if (xSplit > 0 && ySplit > 0) {
    sel.push(`<selection pane="topRight" activeCell="${col(xSplit + 1)}1" sqref="${col(xSplit + 1)}1"/>`);
    sel.push(`<selection pane="bottomLeft" activeCell="A${ySplit + 1}" sqref="A${ySplit + 1}"/>`);
  }
  sel.push(`<selection pane="${active}" activeCell="${topLeft}" sqref="${topLeft}"/>`);
  return `<pane ${attrs}/>` + sel.join('');
}

/**
 * Заморозить xSplit колонок слева и ySplit строк сверху.
 *
 * Оба параметра принимают ЧИСЛО (одинаково для всех листов) или МАССИВ — значение на лист
 * по порядку добавления через book_append_sheet (он же порядок sheet1.xml, sheet2.xml…).
 * Массив нужен там, где у листов разные шапки: в вечернем отчёте m112 «Разница реал.сканов»
 * начинается сразу с шапки, а у «По складам» перед ней ещё титул и пояснение.
 *
 * Excel требует <selection> на каждую видимую панель, иначе при двойной заморозке
 * (и строки, и колонки) файл открывается без закрепления.
 */
export function freezePane(buf, xSplit, ySplit) {
  const at = (v, i) => (Array.isArray(v) ? (v[i] ?? 0) : v);
  const files = unzipSync(buf);
  for (const name of Object.keys(files)) {
    const m = name.match(/^xl\/worksheets\/sheet(\d+)\.xml$/);
    if (!m) continue;
    const i = +m[1] - 1;                       // sheet1.xml → индекс 0
    const x = at(xSplit, i), y = at(ySplit, i);
    if (x <= 0 && y <= 0) continue;            // этот лист морозить не просили
    let xml = strFromU8(files[name]);
    if (xml.includes('<pane ')) continue;      // уже заморожено
    const PANE = paneXml(x, y);
    if (/<sheetView\b[^>]*\/>/.test(xml)) {
      xml = xml.replace(/<sheetView\b([^>]*)\/>/, `<sheetView$1>${PANE}</sheetView>`);
    } else if (/<sheetView\b[^>]*>/.test(xml)) {
      xml = xml.replace(/(<sheetView\b[^>]*>)/, `$1${PANE}`);
    } else {
      continue; // нет sheetView — пропускаем (без заморозки)
    }
    files[name] = strToU8(xml);
  }
  return zipSync(files);
}

/** Частый случай — закрепить только верхнюю строку. */
export const freezeHeader = (buf) => freezePane(buf, 0, 1);
