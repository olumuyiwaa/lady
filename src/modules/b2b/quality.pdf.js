const PDFDocument = require('pdfkit');

const T = {
  nl: {
    title: 'Kwaliteitsrapport',
    for: 'voor',
    summary: 'Samenvatting',
    branches: 'Per locatie',
    visits: 'Bezoeken',
    completed: 'Afgerond',
    rating: 'Beoordeling',
    checklist: 'Checklist',
    punctuality: 'Op tijd',
    complaints: 'Klachten',
    none: '—',
    noVisits: 'Geen bezoeken in deze maand.',
    notes: [
      'Beoordeling: gemiddelde klantscore (1-5) van afgeronde bezoeken.',
      'Checklist: aangevinkte taken als percentage van alle taken op afgeronde bezoeken.',
      'Op tijd: percentage bezoeken waarbij de schoonmaker uiterlijk {g} minuten na de afgesproken starttijd inchecte. Bezoeken zonder check-in tellen niet mee ({n} in totaal).',
    ],
    generated: 'Opgesteld op',
  },
  en: {
    title: 'Quality report',
    for: 'for',
    summary: 'Summary',
    branches: 'By location',
    visits: 'Visits',
    completed: 'Completed',
    rating: 'Rating',
    checklist: 'Checklist',
    punctuality: 'On time',
    complaints: 'Complaints',
    none: '—',
    noVisits: 'No visits this month.',
    notes: [
      'Rating: average customer score (1-5) of completed visits.',
      'Checklist: ticked tasks as a share of all tasks on completed visits.',
      'On time: share of visits where the cleaner checked in within {g} minutes of the booked start. Visits without a check-in are left out ({n} in total).',
    ],
    generated: 'Generated',
  },
};

const pctText = (v, none) => (v == null ? none : `${String(v).replace('.', ',')}%`);
const ratingText = (v, none) => (v == null ? none : `${String(v).replace('.', ',')} / 5`);

/** Renders the quality report to a PDF Buffer. */
function renderQualityPdf({ report, month, companyName, businessName, language = 'nl', now = new Date() }) {
  const t = T[language] || T.nl;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${t.title} ${month}`, Author: businessName || 'Tod Cleaning Services' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;

    doc.font('Helvetica-Bold').fontSize(20).text(`${t.title} ${month}`);
    doc.font('Helvetica').fontSize(11).fillColor('#555').text(`${businessName || ''} ${t.for} ${companyName || ''}`.trim());
    doc.moveDown(1.2).fillColor('#000');

    // Summary tiles
    const tot = report.total;
    doc.font('Helvetica-Bold').fontSize(13).text(t.summary);
    doc.moveDown(0.4);
    const tiles = [
      [t.visits, String(tot.visits)],
      [t.rating, ratingText(tot.averageRating, t.none)],
      [t.checklist, pctText(tot.checklistCompletionPct, t.none)],
      [t.punctuality, pctText(tot.punctualityPct, t.none)],
      [t.complaints, String(tot.complaints)],
    ];
    const tileW = width / tiles.length;
    const y0 = doc.y;
    tiles.forEach(([label, value], i) => {
      const x = left + i * tileW;
      doc.font('Helvetica').fontSize(9).fillColor('#555').text(label, x, y0, { width: tileW - 6 });
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text(value, x, y0 + 13, { width: tileW - 6 });
    });
    doc.y = y0 + 44;
    doc.x = left;

    // Branch table
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(13).text(t.branches, left);
    doc.moveDown(0.4);
    const cols = [
      { h: '', w: 0.30, get: (b) => b.label || '—', align: 'left' },
      { h: t.visits, w: 0.14, get: (b) => `${b.completedVisits}/${b.visits}`, align: 'right' },
      { h: t.rating, w: 0.14, get: (b) => ratingText(b.averageRating, t.none), align: 'right' },
      { h: t.checklist, w: 0.14, get: (b) => pctText(b.checklistCompletionPct, t.none), align: 'right' },
      { h: t.punctuality, w: 0.14, get: (b) => pctText(b.punctualityPct, t.none), align: 'right' },
      { h: t.complaints, w: 0.14, get: (b) => String(b.complaints), align: 'right' },
    ];
    const drawRow = (cells, bold) => {
      const startY = doc.y;
      let x = left;
      let rowH = 0;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
      cols.forEach((c, i) => {
        const w = c.w * width;
        const h = doc.heightOfString(cells[i], { width: w - 6 });
        rowH = Math.max(rowH, h);
        x += w;
      });
      if (startY + rowH + 8 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        return drawRow(cells, bold);
      }
      x = left;
      cols.forEach((c, i) => {
        const w = c.w * width;
        doc.text(cells[i], x, startY, { width: w - 6, align: c.align });
        x += w;
      });
      doc.y = startY + rowH + 4;
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.5).strokeColor('#ddd').stroke();
      doc.y += 4;
      doc.x = left;
    };
    drawRow(cols.map((c) => c.h), true);
    if (report.branches.length === 0) {
      doc.font('Helvetica').fontSize(10).text(t.noVisits, left);
    } else {
      report.branches.forEach((b) => drawRow(cols.map((c) => c.get(b)), false));
    }

    // Notes
    doc.moveDown(1).font('Helvetica').fontSize(8.5).fillColor('#555');
    t.notes.forEach((n) => doc.text(n.replace('{g}', report.graceMinutes).replace('{n}', tot.noCheckIn), left, doc.y, { width }).moveDown(0.3));
    doc.moveDown(0.5).text(`${t.generated} ${now.toISOString().slice(0, 10)}`, left);

    doc.end();
  });
}

module.exports = { renderQualityPdf };
