async function buildHtmlReport({ slug, summary }) {
  await fs.ensureDir(OUT_REPORTS_DIR);

  // Cache-bust para GitHub Pages
  const mapUrl = `../${OUT_MAPS_DIR}/${slug}.png?v=${Date.now()}`;

  const regionesRows = (summary.top_regiones || [])
    .map((r) => tableRow([r.rank, cleanRegionLabel(r.region), `${formatPct(r.pct_region)}%`]))
    .join("");

  const provinciasRows = (summary.top_provincias || [])
    .map((r) =>
      tableRow([r.rank, r.provincia, cleanRegionLabel(r.region), `${formatPct(r.pct_provincia)}%`])
    )
    .join("");

  const comunasRows = (summary.top_comunas || [])
    .map((r) =>
      tableRow([r.rank, r.comuna, r.provincia, cleanRegionLabel(r.region), `${formatPct(r.pct_comuna)}%`])
    )
    .join("");

  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Informe ${htmlEscape(summary.apellido || slug)}</title>

  <style>
    @page { size: A4; margin: 10mm; }
    html, body { margin:0; padding:0; }
    * { box-sizing: border-box; }

    body{
      font-family: Arial, Helvetica, sans-serif;
      color:#111;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      background:#fff;
    }

    .page{
      width:100%;
      max-width: 190mm; /* 210 - 2*10 */
      margin: 0 auto;
    }

    .header{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:10px;
      margin-bottom: 3mm;
    }
    .brand{ display:flex; align-items:center; gap:10px; }
    .logo{ height: 11mm; }
    .meta{ font-size: 10px; color:#555; text-align:right; line-height:1.25; padding-top:1.5mm; }

    h1{ font-size: 18px; margin: 0 0 1.5mm; }
    .sub{ font-size: 12px; color:#333; margin: 0 0 3mm; }

    .card{
      border:1px solid #e6e6e6;
      border-radius:10px;
      padding: 3mm;
      background:#fff;
    }

    /* ===== ESTRUCTURA EN 2 FILAS (1 página y sin invasiones) ===== */
    .layout{
      display:grid;
      grid-template-rows: 168mm auto;
      gap: 4mm;
    }

    .grid{
      display:grid;
      grid-template-columns: 32% 68%;
      gap: 4mm;
      height: 168mm;
      overflow: hidden;
      align-items: stretch;
    }

    .rightCol{
      height: 168mm;
      display:flex;
      flex-direction:column;
      gap:4mm;
    }

    .rightCol .card{
      height: calc((168mm - 4mm) / 2);
      overflow: hidden;
    }

    .mapCard{
      height: 168mm;
      display:flex;
      flex-direction:column;
    }
    .mapWrap{
      height: 100%;
      overflow:hidden;
      border-radius:10px;
      border:1px solid #e2e2e2;
      background:#fff;
    }
    .mapImg{
      width:100%;
      height:100%;
      object-fit: contain;
      object-position: 50% 65%;
      display:block;
    }

    h2{ font-size: 12.5px; margin: 0 0 2mm; }

    table{
      width:100%;
      border-collapse:collapse;
      table-layout: fixed;
    }

    th, td{
      border:1px solid #eee;
      padding: 1.6mm 2mm;
      font-size: 10.3px;
      line-height: 1.15;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }

    thead th{
      background:#f7f7f7;
      text-align:left;
      vertical-align: middle;
      padding-top: 1.2mm;
      padding-bottom: 1.2mm;
    }

    tbody td{
      height: 9mm;
      vertical-align: middle;
      padding-top: 1.2mm;
      padding-bottom: 1.2mm;
    }

    .t-regiones col.c1{ width: 10%; }
    .t-regiones col.c2{ width: 70%; }
    .t-regiones col.c3{ width: 20%; }

    .t-provincias col.c1{ width: 10%; }
    .t-provincias col.c2{ width: 30%; }
    .t-provincias col.c3{ width: 40%; }
    .t-provincias col.c4{ width: 20%; }

    .t-comunas col.c1{ width: 6%; }
    .t-comunas col.c2{ width: 20%; }
    .t-comunas col.c3{ width: 20%; }
    .t-comunas col.c4{ width: 42%; }
    .t-comunas col.c5{ width: 12%; }

    .below{
      width:100%;
      padding: 2.4mm;
      overflow: hidden;
    }

    .foot{
      font-size: 10px;
      color:#666;
      margin-top: 2mm;
      line-height: 1.25;
    }

    .card, table { break-inside: avoid; page-break-inside: avoid; }
  </style>
</head>

<body>
  <div class="page">

    <div class="header">
      <div class="brand">
        <img class="logo" src="${LOGO_URL}" alt="Apellidos.cl"/>
      </div>
      <div class="meta">Actualizado: ${htmlEscape(summary.updated_at || "")}</div>
    </div>

    <h1>Mapa del apellido ${htmlEscape(summary.apellido || "")}</h1>
    <p class="sub">Lugares donde tiene mayor arraigo histórico.</p>

    <div class="layout">

      <div class="grid">
        <div class="card mapCard">
          <div class="mapWrap">
            <img class="mapImg" src="${mapUrl}" alt="Mapa de Chile"/>
          </div>
        </div>

        <div class="rightCol">
          <div class="card">
            <h2>Top regiones</h2>
            <table class="t-regiones">
              <colgroup><col class="c1"><col class="c2"><col class="c3"></colgroup>
              <thead><tr><th>#</th><th>Región</th><th>Frecuencia</th></tr></thead>
              <tbody>${regionesRows}</tbody>
            </table>
          </div>

          <div class="card">
            <h2>Top provincias</h2>
            <table class="t-provincias">
              <colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"></colgroup>
              <thead><tr><th>#</th><th>Provincia</th><th>Región</th><th>Frecuencia</th></tr></thead>
              <tbody>${provinciasRows}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card below">
        <h2>Top comunas</h2>
        <table class="t-comunas">
          <colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5"></colgroup>
          <thead><tr><th>#</th><th>Comuna</th><th>Provincia</th><th>Región</th><th>Frecuencia</th></tr></thead>
          <tbody>${comunasRows}</tbody>
        </table>
      </div>

    </div>

    <div class="foot">
      Fuente: www.apellidos.cl / Mapa de apellidos en Chile. Este reporte presenta los lugares donde hay mayor frecuencia relativa del apellido, lo que en muchos casos se explica por su antigua presencia en aquellos lugares.
    </div>

  </div>
</body>
</html>`;

  const outHtml = path.join(OUT_REPORTS_DIR, `${slug}.html`);
  await fs.writeFile(outHtml, html, "utf8");
  return outHtml;
}
