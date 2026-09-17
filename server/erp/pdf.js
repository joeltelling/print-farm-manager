/**
 * Minimal PDF builder (no deps) for sales history export.
 * Latin-1 text only; long names are truncated.
 */
function escapePdf(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildSalesReportPdf({ title, subtitle, summary, rows }) {
  const header = 'Date       SKU            Qty      Unit$    Total$   Margin/U';
  const perPage = 55;
  const pageCount = Math.max(1, Math.ceil(rows.length / perPage));
  const pages = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const lines = [];
    lines.push(`BT /F1 14 Tf 40 800 Td (${escapePdf(title)}) Tj ET`);
    lines.push(`BT /F1 10 Tf 40 780 Td (${escapePdf(subtitle)}) Tj ET`);
    lines.push(`BT /F1 10 Tf 40 765 Td (${escapePdf(summary)}  Page ${pageIndex + 1}/${pageCount}) Tj ET`);
    let y = 740;
    lines.push(`BT /F1 9 Tf 40 ${y} Td (${escapePdf(header)}) Tj ET`);
    y -= 14;
    for (const r of rows.slice(pageIndex * perPage, (pageIndex + 1) * perPage)) {
      const date = String(r.sale_date || '').slice(0, 10).padEnd(10);
      const sku = String(r.sku || '').slice(0, 12).padEnd(12);
      const qty = numPad(r.qty, 8);
      const unit = numPad(r.unit_price, 8);
      const total = numPad(r.total_price, 8);
      const margin = numPad(r.unit_margin, 8);
      const row = `${date} ${sku} ${qty} ${unit} ${total} ${margin}`;
      lines.push(`BT /F1 8 Tf 40 ${y} Td (${escapePdf(row)}) Tj ET`);
      y -= 12;
    }
    pages.push(lines.join('\n'));
  }

  const objects = [];
  objects.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n');
  const firstPageObject = 3;
  const firstContentObject = firstPageObject + pages.length;
  const fontObject = firstContentObject + pages.length;
  const kids = pages.map((_, i) => `${firstPageObject + i} 0 R`).join(' ');
  objects.push(`2 0 obj<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>endobj\n`);
  pages.forEach((_, i) => {
    objects.push(`${firstPageObject + i} 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${firstContentObject + i} 0 R /Resources << /Font << /F1 ${fontObject} 0 R >> >> >>endobj\n`);
  });
  pages.forEach((content, i) => {
    objects.push(`${firstContentObject + i} 0 obj<< /Length ${Buffer.byteLength(content, 'latin1')} >>stream\n${content}\nendstream\nendobj\n`);
  });
  objects.push(`${fontObject} 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>endobj\n`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += obj;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function numPad(n, width) {
  const s = Number(n || 0).toFixed(2);
  return s.padStart(width, ' ');
}

module.exports = { buildSalesReportPdf };
