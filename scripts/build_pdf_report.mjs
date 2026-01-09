import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright";

/**
 * CONFIG
 */
const SUMMARY_DIR = "pdf_summaries/2";     // carpeta donde están los shards apellidos_xx.json
const OUT_REPORTS_DIR = "pdf_reports";
const OUT_MAPS_DIR = "pdf_maps";

// GitHub Pages del mapa (base)
const MAP_BASE_URL = "https://crcofre.github.io/mapa-apellidos/";

// Logo (Apellidos.cl)
const LOGO_URL =
  "https://images.jumpseller.com/store/familias-y-apellidos/store/logo/Sitio_web.png?1741039595";

/**
 * CLI
 */
function slugArg() {
  const idx = process.argv.indexOf("--slug");
  if (idx === -1 || !process.argv[idx + 1]) {
    throw new Error(
      "Falta parámetro --slug (ej: node scripts/build_pdf_report.mjs --slug lucero)"
    );
  }
  return process.argv[idx + 1].trim().toLowerCase();
}

function htmlEscape(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatPct(x) {
  if (x === null || x === undefined || x === "") return "";
  const n = Number(x);
  if (Number.isNaN(n)) return String(x);
  return n.toFixed(2);
}

function cleanRegionLabel(s) {
  // "06. REGION DEL LIBERTADOR..." -> "DEL LIBERTADOR..."
  return String(s ?? "")
    .trim()
    .replace(/^\s*\d+\s*[\.\-]?\s*/i, "")                 // quita "06." o "06 -"
    .replace(/^REGI[ÓO]N\s+(DEL\s+|DE\s+)?/i, "")         // quita "REGION " / "REGIÓN " y opcional "DE/DEL"
    .trim();
}


function tableRow(cells) {
  return `<tr>${cells.map((c) => `<td>${htmlEscape(c)}</td>`).join("")}</tr>`;
}

/**
 * Carga summary desde shard pdf_summaries/2/apellidos_xx.json (estructura {"items":[...]})
 */
async function loadSummaryFromShard(slug) {
  const base = path.resolve(SUMMARY_DIR);
  if (!(await fs.pathExists(base))) {
    throw new Error(`No existe SUMMARY_DIR: ${SUMMARY_DIR}. Ajusta SUMMARY_DIR en el script.`);
  }

  const p2 = slug.slice(0, 2);
  const shard = path.join(base, `apellidos_${p2}.json`);

  if (!(await fs.pathExists(shard))) {
    throw new Error(
      `No existe shard esperado: ${shard}. Revisa que exista apellidos_${p2}.json en ${SUMMARY_DIR}`
    );
  }

  const data = await fs.readJson(shard);

  const items = Array.isArray(data?.items) ? data.items : null;
  if (!items) {
    throw new Error(`El shard ${shard} no tiene estructura {"items":[...]}.`);
  }

  const summary = items.find((it) => String(it?.slug ?? "").toLowerCase() === slug);

  if (!summary) {
    const sample = items.slice(0, 10).map((it) => it.slug).filter(Boolean);
    throw new Error(
      `No encontré el slug=${slug} dentro de ${shard}. Ejemplos de slugs: ${sample.join(", ")}`
    );
  }

  return summary;
}

/**
 * Genera PNG del mapa usando Playwright (Leaflet real)
 * Requiere que tu index.html soporte:
 *   ?apellido=lucero&pdf=1
 * y que setee: <html data-pdf-ready="1"> cuando termina buscarApellido()
 */
async function buildMapPngWithPlaywright({ slug }) {
  await fs.ensureDir(OUT_MAPS_DIR);

  // cache-bust real: t=timestamp
  const url =
    `${MAP_BASE_URL}?apellido=${encodeURIComponent(slug)}` +
    `&pdf=1&t=${Date.now()}`;

  const outPng = path.join(OUT_MAPS_DIR, `${slug}.png`);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage({
  viewport: { width: 1000, height: 1700 }, // más alto para no perder la zona sur
  deviceScaleFactor: 2,
});


  try {
    // Fuerza “no cache” y carga limpia
    await page.route("**/*", (route) => {
      const headers = { ...route.request().headers(), "Cache-Control": "no-cache" };
      route.continue({ headers });
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });

    // Espera a que tu script marque data-pdf-ready="1"
    await page.waitForFunction(
      () => document.documentElement.getAttribute("data-pdf-ready") === "1",
      { timeout: 120000 }
    );

        // 1) Oculta todo lo que no sea el mapa (controles, buscador, leyenda, botones)
    await page.addStyleTag({
      content: `
        .leaflet-control-container,
        .search-ui,
        #suggestBox,
        #ctaBottomControl,
        .log-panel { display:none !important; }

        /* fuerza fondo blanco (reduce “gris”) */
        html, body { background:#fff !important; }
        #map { background:#fff !important; }
      `,
    });

    // 2) Asegura que Leaflet recalcula el tamaño antes de capturar
    await page.evaluate(() => {
      try { window.map?.invalidateSize?.(true); } catch (e) {}
    });

    // Pausa corta para que re-renderice
    await page.waitForTimeout(250);

    // Asegura que Leaflet recalcula tamaño
    await page.evaluate(() => {
      try { window.map?.invalidateSize?.(true); } catch (e) {}
    });

    // Captura SOLO el div #map
        const mapEl = await page.$("#map");
    if (!mapEl) {
      throw new Error("No encontré el elemento #map en la página del mapa.");
    }

    const box = await mapEl.boundingBox();
    if (!box) {
      throw new Error("No pude calcular el bounding box de #map.");
    }

    // 3) Recorte proporcional para “quitar aire” y dejar Chile más lleno
    // Ajusta estos números si quieres más/menos recorte
    const crop = {
  x: Math.round(box.x + box.width * 0.22),  // más recorte a la izquierda → Chile más centrado/angosto
  y: Math.round(box.y + box.height * 0.01), // no recorta arriba
  width: Math.round(box.width * 0.56),      // más angosto → menos “aire”
  height: Math.round(box.height * 0.985),    // captura todo el alto (evita cortar el sur)
};


    await page.screenshot({ path: outPng, type: "png", clip: crop });
    
    return outPng;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * HTML del reporte (usa el PNG generado en pdf_maps/slug.png)
 */
async function buildHtmlReport({ slug, summary }) {
  await fs.ensureDir(OUT_REPORTS_DIR);

  // OJO: esta URL debe ser pública en GitHub Pages
  const mapUrl = `../${OUT_MAPS_DIR}/${slug}.png?v=${Date.now()}`;


  const regionesRows = (summary.top_regiones || [])
  .map((r) => tableRow([r.rank, cleanRegionLabel(r.region), `${formatPct(r.pct_region)}%`]))
  .join("");


  const provinciasRows = (summary.top_provincias || [])
  .map((r) => tableRow([r.rank, r.provincia, cleanRegionLabel(r.region), `${formatPct(r.pct_provincia)}%`]))
  .join("");


  const comunasRows = (summary.top_comunas || [])
  .map((r) =>
    tableRow([r.rank, r.comuna, r.provincia, cleanRegionLabel(r.region), `${formatPct(r.pct_comuna)}%`])
  )
  .join("");


    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Informe ${htmlEscape(summary.apellido)}</title>
  <style>
    /* === CLAVE para PDF: margen real de impresión y evitar cortes === */
    @page { size: A4; margin: 12mm; }
    html, body { margin:0; padding:0; }
    * { box-sizing: border-box; }

    body{
      font-family: Arial, Helvetica, sans-serif;
      color:#111;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* Contenedor de “una hoja” */
    .page{
      width: 100%;
      max-width: 180mm;          /* A4 (210mm) - 2*12mm margen = 186mm; dejo un poco menos por seguridad */
      margin: 0 auto;
    }

    /* Header compacto */
    .header{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:10px;
      margin-bottom: 4mm;
    }
    .brand{ display:flex; align-items:center; gap:10px; }
    .logo{ height: 12mm; }
    .meta{ font-size: 10px; color:#555; text-align:right; line-height:1.25; padding-top:2mm; }

    h1{ font-size: 18px; margin: 0 0 2mm; }
    .sub{ font-size: 12px; color:#333; margin: 0 0 4mm; }

    /* Layout principal: mapa izquierda, tablas derecha */
    .grid{
      display:grid;
      grid-template-columns: 36% 64%; /* mapa más angosto */
      gap: 4mm;
      align-items: stretch;          /* CLAVE: que ambas columnas puedan igualar altura */
    }

/* el card del mapa debe poder estirar */
/* .grid > .card{ height:100%; }      /* aplica al primer .card del grid (mapa) */

      /* el mapa ocupa todo el alto disponible */
     /*  .mapWrap{
     /*    width:100%;
    /*     height: 100%;                    /* CLAVE: ahora calza con la altura de la columna derecha */
     /*    overflow:hidden;
    /*     border-radius:10px;
    /*     border:1px solid #e2e2e2;
    /*     background:#fff;
   /*    }


    .rightCol{
      display:flex;
      flex-direction:column;
      gap:4mm;              /* reemplaza el margin-bottom inline */
      height:100%;
    }


    /* “Cards” sin rellenos excesivos para que quepa en 1 hoja */
    .card{
      border:1px solid #e6e6e6;
      border-radius:10px;
      padding: 3mm;
      background:#fff;
    }

    /* Recorte del mapa (sin “fondo” alrededor) */
    .mapWrap{
      width:100%;
      height: 132mm; /* más largo */
      overflow:hidden;
      border-radius:10px;
      border:1px solid #e2e2e2;
      background:#fff;
    }

    
    .mapImg{
      width:100%;
      height:100%;
      object-fit: cover;
      object-position: 50% 65%;   /* baja el encuadre */
      display:block;
    }


    /* Tablas: tamaño y columnas para NO cortar “Frecuencia” */
    h2{ font-size: 12.5px; margin: 0 0 2mm; }
    table{
      width:100%;
      border-collapse:collapse;
      table-layout: fixed;       /* clave para que respete anchos */
    }
    th, td{
  border:1px solid #eee;
  padding: 2mm 2.2mm;
  font-size: 10.5px;
  line-height: 1.2;        /* NUEVO: controla alto por líneas */
  word-wrap: break-word;
  overflow-wrap: anywhere;
}

thead th{
  background:#f7f7f7;
  text-align:left;
  white-space: normal;     /* permite salto de línea */
  vertical-align: middle;  /* NUEVO: centra encabezado */
  padding-top: 1.4mm;      /* NUEVO: más compacto */
  padding-bottom: 1.4mm;   /* NUEVO */
}

tbody td{
  height: 10mm;            /* NUEVO: “alto fijo” por fila (ajusta 9.5–11mm) */
  vertical-align: middle;  /* NUEVO: centra el texto verticalmente */
  padding-top: 1.6mm;      /* NUEVO: ajusta centrado fino */
  padding-bottom: 1.6mm;   /* NUEVO */
}



    /* Anchos por columna (evita recorte del último encabezado) */
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
    .t-comunas col.c5{ width: 12%; }  /* Frec. */


    /* Sección comunas a lo ancho, debajo */
    .below{ margin-top: 4mm; }

    .foot{
      font-size: 11px;
      color:#666;
      margin-top: 3mm;
    }

    /* Evitar saltos feos dentro de cards/tablas */
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

    <div class="grid">
      <!-- MAPA -->
      <div class="card">
        <div class="mapWrap">
          <img class="mapImg" src="${mapUrl}" alt="Mapa de Chile"/>
        </div>
      </div>

      <!-- TABLAS DERECHA -->
      <div class="rightCol">
        <div class="card">
          <h2>Top regiones</h2>
          <table class="t-regiones">
            <colgroup>
              <col class="c1"><col class="c2"><col class="c3">
            </colgroup>
            <thead><tr><th>#</th><th>Región</th><th>Frecuencia</th></tr></thead>
            <tbody>${regionesRows}</tbody>
          </table>
        </div>

        <div class="card">
          <h2>Top provincias</h2>
          <table class="t-provincias">
            <colgroup>
              <col class="c1"><col class="c2"><col class="c3"><col class="c4">
            </colgroup>
            <thead><tr><th>#</th><th>Provincia</th><th>Región</th><th>Frecuencia</th></tr></thead>
            <tbody>${provinciasRows}</tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- COMUNAS ABAJO A TODO ANCHO -->
    <div class="card below">
      <h2>Top comunas</h2>
      <table class="t-comunas">
        <colgroup>
          <col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5">
        </colgroup>
        <thead>
          <tr>
            <th>#</th><th>Comuna</th><th>Provincia</th><th>Región</th><th>Frecuencia</th>
          </tr>
        </thead>

        <tbody>${comunasRows}</tbody>
      </table>
    </div>

    <div class="foot">
      Fuente: www.apellidos.cl / Mapa de apellidos en Chile. Este informa presenta los lugares donde hay mayor frecuencia relativa del apellido, lo que en muchos casos se explica por su antigua presencia en aquellos lugares.
    </div>

  </div>
</body>
</html>`;


  const outHtml = path.join(OUT_REPORTS_DIR, `${slug}.html`);
  await fs.writeFile(outHtml, html, "utf8");
  return outHtml;
}

async function main() {
  const slug = slugArg();

  const summary = await loadSummaryFromShard(slug);

  // 1) Generar PNG con Leaflet real
  await buildMapPngWithPlaywright({ slug });

  // 2) Generar HTML
  await buildHtmlReport({ slug, summary });

  console.log(`OK: generado ${OUT_MAPS_DIR}/${slug}.png y ${OUT_REPORTS_DIR}/${slug}.html`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
