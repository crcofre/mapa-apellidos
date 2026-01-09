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

 @page {
  size: A4;
  margin: 10mm;
}

html, body {
  margin: 0;
  padding: 0;
}

body {
  font-family: Arial, Helvetica, sans-serif;
  color: #111;
  background: #fff;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* CONTENEDOR A4 REAL */
.page {
  width: 190mm;
  height: 277mm; /* 297 - 2*10 */
  margin: 0 auto;
  overflow: hidden;
}

/* HEADER */
.header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4mm;
}
.logo { height: 11mm; }
.meta { font-size: 10px; color: #555; }

/* TÍTULOS */
h1 { font-size: 18px; margin: 0 0 2mm; }
.sub { font-size: 12px; margin: 0 0 4mm; }

/* BLOQUE SUPERIOR */
.top {
  display: grid;
  grid-template-columns: 32% 68%;
  gap: 4mm;
  height: 155mm; /* CLAVE */
}

/* MAPA */
.mapImg {
  width: 100%;
  max-height: 155mm;   /* CLAVE ABSOLUTA */
  object-fit: contain;
  display: block;
}

/* TABLAS DERECHA */
.right {
  display: flex;
  flex-direction: column;
  gap: 4mm;
}

/* CARDS */
.card {
  border: 1px solid #e6e6e6;
  border-radius: 8px;
  padding: 3mm;
  background: #fff;
}

/* TABLAS */
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

th, td {
  border: 1px solid #eee;
  font-size: 10.2px;
  padding: 1.4mm 2mm;
}

thead th {
  background: #f7f7f7;
}

/* COMUNAS ABAJO */
.bottom {
  margin-top: 4mm;
  max-height: 70mm;
  overflow: hidden;
}

/* PIE */
.foot {
  margin-top: 3mm;
  font-size: 10px;
  color: #666;
}

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
