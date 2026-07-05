// Закрепление верхней строки (freeze header) в готовом xlsx.
// community `xlsx` не пишет заморозку — впрыскиваем <pane> в XML всех листов через fflate.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');

const PANE =
  '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
  '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';

export function freezeHeader(buf) {
  const files = unzipSync(buf);
  for (const name of Object.keys(files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    let xml = strFromU8(files[name]);
    if (xml.includes('<pane ')) continue;
    if (/<sheetView\b[^>]*\/>/.test(xml)) {
      xml = xml.replace(/<sheetView\b([^>]*)\/>/, `<sheetView$1>${PANE}</sheetView>`);
    } else if (/<sheetView\b[^>]*>/.test(xml)) {
      xml = xml.replace(/(<sheetView\b[^>]*>)/, `$1${PANE}`);
    } else {
      continue;
    }
    files[name] = strToU8(xml);
  }
  return zipSync(files);
}
