import ExcelJS from 'exceljs';

/**
 * Tables written as files a business opens in Excel: the recruitment report
 * and the HR exports. Values stay raw numbers so they can be summed and
 * charted.
 */

export type Cell = string | number | null;
export type DataTable = {
  /** The sheet's name (31 characters at most, Excel's limit). */
  name: string;
  header: string[];
  rows: Cell[][];
};

export type TableFile = {
  /** First line: what the file is and for whom. */
  title: string;
  /** Second line: the period, the offer… */
  subtitle: string;
  tables: DataTable[];
  generatedAt: Date;
  /** Said when a table has no rows. */
  empty?: string;
};

/** One sheet per table, a styled header, numbers kept as numbers. */
export async function tablesXlsx(file: TableFile): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Rabotka';
  workbook.created = file.generatedAt;

  for (const table of file.tables) {
    const sheet = workbook.addWorksheet(table.name.slice(0, 31));
    sheet.addRow([file.title]).font = { bold: true, size: 14 };
    sheet.addRow([file.subtitle]).font = { color: { argb: 'FF5A655F' } };
    sheet.addRow([]);

    const head = sheet.addRow(table.header);
    head.height = 22;
    head.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF0FA84C' },
      };
      cell.alignment = { vertical: 'middle' };
    });
    for (const row of table.rows) sheet.addRow(row);
    if (!table.rows.length) {
      sheet.addRow([file.empty ?? 'Aucune donnée sur la période.']).font = {
        italic: true,
        color: { argb: 'FF7A857F' },
      };
    }

    sheet.views = [{ state: 'frozen', ySplit: head.number }];
    table.header.forEach((label, i) => {
      const longest = Math.max(
        label.length,
        ...table.rows.map((r) => String(r[i] ?? '').length),
      );
      sheet.getColumn(i + 1).width = Math.min(Math.max(longest + 2, 12), 60);
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * The tables one after the other, each under its name, in the format a
 * French spreadsheet opens as is: `;` between cells, a decimal comma, and a
 * BOM so the accents survive.
 */
export function tablesCsv(file: TableFile): string {
  const cell = (v: Cell) => {
    if (v === null) return '';
    const text = typeof v === 'number' ? String(v).replace('.', ',') : v;
    return /[;"\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const line = (cells: Cell[]) => cells.map(cell).join(';');

  const blocks = file.tables.map((t) =>
    [line([t.name]), line(t.header), ...t.rows.map(line)].join('\r\n'),
  );
  const BOM = '﻿';
  return `${BOM}${[
    line([file.title]),
    line([file.subtitle]),
    '',
    blocks.join('\r\n\r\n'),
  ].join('\r\n')}\r\n`;
}
