// Relatório da rota em PDF gerado no próprio aparelho (jsPDF). Substitui window.print(),
// que não funciona no app instalado na tela inicial do iPhone/iPad.
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { OUTCOME_LABEL, routeStats } from './delivery.js';
import { farFromStopM, fmtDistance } from './tracking.js';

const PHOTO_W = 34; // mm
const PHOTO_MAX_H = 34;
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');

export function reportRows(stops) {
  return stops.map((s, i) => [
    String(i + 1),
    s.ref ? `${s.address}\n${s.ref}` : s.address,
    (OUTCOME_LABEL[s.outcome] ?? 'Pendente') + (s.outcome === 'failed' && s.failReason ? `\n${s.failReason}` : ''),
    [s.arrivedAt && `Chegou ${fmtTime(s.arrivedAt)}`, s.outcomeAt && fmtDateTime(s.outcomeAt)].filter(Boolean).join('\n'),
    [s.note, s.outcomeDistM > farFromStopM(s) && `Marcado a ${fmtDistance(s.outcomeDistM)} do endereço`].filter(Boolean).join('\n'),
    '',
  ]);
}

/**
 * @param photos objeto { [stopId]: dataUrl JPEG }
 * @returns Blob (application/pdf)
 */
export function buildReportPdf(route, stops, photos = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const st = routeStats(stops);
  doc.setFontSize(16);
  doc.text(route.name, 14, 16);
  doc.setFontSize(10);
  const summary = [
    `${st.delivered} entregues · ${st.failed} com problema · ${st.pending} pendentes`,
    route.tracking?.meters > 500 ? `${fmtDistance(route.tracking.meters)} rodados (GPS)`
      : route.plan ? `${(route.plan.distance / 1000).toFixed(1)} km` : '',
    route.finishedAt ? `finalizada em ${fmtDateTime(route.finishedAt)}` : '',
  ].filter(Boolean).join(' · ');
  doc.text(summary, 14, 23);

  const dims = {};
  for (const [id, url] of Object.entries(photos)) {
    const { width, height } = doc.getImageProperties(url);
    dims[id] = { w: PHOTO_W, h: Math.min(PHOTO_MAX_H, (PHOTO_W * height) / width) };
  }

  autoTable(doc, {
    startY: 28,
    head: [['#', 'Endereço', 'Situação', 'Horário', 'Observação', 'Foto']],
    body: reportRows(stops),
    styles: { fontSize: 9, cellPadding: 1.8, valign: 'top' },
    headStyles: { fillColor: [15, 118, 110] },
    columnStyles: {
      0: { cellWidth: 8 },
      2: { cellWidth: 24 },
      3: { cellWidth: 22 },
      4: { cellWidth: 38 },
      5: { cellWidth: PHOTO_W + 4 },
    },
    didParseCell: (data) => {
      const d = data.section === 'body' && dims[stops[data.row.index].id];
      if (d) data.cell.styles.minCellHeight = d.h + 4;
      if (data.section === 'body' && data.column.index === 2) {
        const o = stops[data.row.index].outcome;
        if (o === 'failed') data.cell.styles.textColor = [185, 28, 28];
        if (o === 'delivered') data.cell.styles.textColor = [21, 128, 61];
      }
    },
    didDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 5) return;
      const s = stops[data.row.index];
      if (photos[s.id]) doc.addImage(photos[s.id], 'JPEG', data.cell.x + 2, data.cell.y + 2, dims[s.id].w, dims[s.id].h);
    },
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`Gerado pelo Rota Express em ${fmtDateTime(new Date().toISOString())} · página ${p}/${pages}`, 14, 290);
  }
  return doc.output('blob');
}
