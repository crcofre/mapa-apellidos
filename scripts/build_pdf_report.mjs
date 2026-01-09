import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright";

/**
 * CONFIG
 */
const SUMMARY_DIR = "pdf_summaries/2";
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
    .replace(/^\s*\d+\s*[\.\-]?\s*/i, "")
    .replace(/^REGI[ÓO]N\s+(DEL\s+|DE\s+)?/i, "")
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
    throw new Error(
      `No existe SUMMARY_DIR: ${SUMMARY_DIR}. Ajusta SUMMARY_DIR en el script.`
    );
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

  const url =
    `${MAP_BASE_URL}?apellido=${encodeURIComponent(slug)}` +
    `&pdf=1&t=${Date.now()}`;

  const outPng = path.join(OUT_MAPS_DIR, `${slug}.png`);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  // Más alto: evita que el sur “muera” por viewport y permite recorte mejor
  const page = await browser.newPage({
    viewport: { width: 1100, height: 2200 },
    deviceScaleFactor: 2,
  });

  try {
    // Fuerza “no cache”
    await page.route("**/*", (route) => {
      const headers = { ...route.request().headers(), "Cache-Control": "no-cache" };
      route.continue({ headers });
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });

    await page.waitForFunction(
      () => document.documentElement.getAttribute("data-pdf-ready") === "1",
      { timeout: 120000 }
    );

    // Oculta UI, fuerza fondo blanco
    await page.addStyleTag({
      content: `
        .leaflet-control-container,
        .search-ui,
        #suggestBox,
        #ctaBottomControl,
        .log-panel { display:none !important; }

        html, body { background:#fff !important; }
        #map { background:#fff !important; }
      `,
    });

    // Reflow Leaflet
    await page.evaluate(() => {
      try { window.map?.invalidateSize?.(true); } catch (e) {}
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      try { window.map?.invalidateSize?.(true); } catch (e) {}
    });

    const mapEl = await page.$("#map");
    if (!mapEl) throw new Error("No encontré el elemento #map en la página del mapa.");

    const box = await mapEl.boundingBox();
    if (!box) throw new Error("No pude calcular el bounding box de #map.");

    /**
     * RECORTE “FINAL”:
     * - Más angosto (quita aire)
     * - Enfocado un poco hacia abajo (para que el sur llegue al borde)
     * Ajusta fino si quieres (pero con esto normalmente queda “listo”).
     */
    const crop = {
      x: Math.round(box.x + box.width * 0.285),  // recorta más izquierda
      y: Math.round(box.y + box.height * 0.000), // no recorta arriba
      width: Math.round(box.width * 0.43),       // más angosto (Chile llena mejor)
      height: Math.round(box.height * 1.0),      // todo el alto
    };

    // Seguridad: evita clip fuera de pantalla
    const clip = {
      x: Math.max(0, crop.x),
      y: Math.max(0, crop.y),
      width: Math.max(1, Math.min(crop.width, (box.x + box.width) - crop.x)),
      height: Math.max(1, Math.min(crop.height, (box.y + box.height) - crop.y)),
    };

    await page.screenshot({ path: outPng, type: "png", clip });
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

  // Cache-bust
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
<html>
<head>
  <meta charset="utf-8"/>
  <title>Informe ${htmlEscape(summary.apellido)}</title>
  <style>
  @page { size: A4; margin: 10mm; } /* un poco menos margen para asegurar cabida */
  html, body { margin:0; padding:0; }
  * { box-sizing: border-box; }

  body{
    font-family: Arial, Helvetica, sans-serif;
    color:#111;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* CLAVE: bloque de página con alto fijo utilizable (A4 297 - 2*10 = 277mm) */
  .page{
    width: 100%;
    max-width: 190mm;     /* 210 - 2*10 */
    height: 277mm;
    margin: 0 auto;
    overflow: hidden;     /* evita que “salte” a 2da página */
  }

  .header{
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    gap:8px;
    margin-bottom: 3mm;
  }
  .brand{ display:flex; align-items:center; gap:8px; }
  .logo{ height: 11mm; }
  .meta{ font-size: 10px; color:#555; text-align:right; line-height:1.25; padding-top:1.5mm; }

  h1{ font-size: 18px; margin: 0 0 1.5mm; }
  .sub{ font-size: 12px; color:#333; margin: 0 0 3mm; }

  /* GRID superior: fija altura para que SIEMPRE quede espacio para comunas */
  .grid{
    display:grid;
    grid-template-columns: 32% 68%;
    gap: 4mm;
    align-items: stretch;
    height: 172mm;        /* altura total del bloque superior (mapa + 2 tablas) */
  }

  .rightCol{
    display:flex;
    flex-direction:column;
    gap:4mm;
    height:100%;
  }

  .card{
    border:1px solid #e6e6e6;
    border-radius:10px;
    padding: 3mm;
    background:#fff;
  }

  /* MAPA: altura controlada por el alto del grid */
  .mapCard{
    height: 100%;
    padding: 3mm;
    display:flex;
  }
  .mapWrap{
    width:100%;
    height:100%;
    overflow:hidden;
    border-radius:10px;
    border:1px solid #e2e2e2;
    background:#fff;
  }

  /* CLAVE: no “cover” (eso te recorta y obliga a agrandar). Mantén contain y centra */
  .mapImg{
    width:100%;
    height:100%;
    object-fit: contain;
    object-position: 50% 50%;
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
    white-space: normal;
    vertical-align: middle;
    padding-top: 1.2mm;
    padding-bottom: 1.2mm;
  }

  /* filas un poco más bajas para asegurar 1 página */
  tbody td{
    height: 9mm;
    vertical-align: middle;
    padding-top: 1.2mm;
    padding-bottom: 1.2mm;
  }

  /* Asegura que las dos tarjetas derecha “calcen” dentro del alto del grid */
  .rightCol .card{
    height: calc((172mm - 4mm) / 2); /* (alto grid - gap) / 2 */
    overflow: hidden;
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

  /* Bloque comunas: alto fijo para que NUNCA empuje a página 2 */
  .below{
    margin-top: 4mm;
    height: 78mm;      /* control total del bloque inferior */
    padding: 2.4mm;
    overflow: hidden;
  }

  /* pie de página: compacto */
  .foot{
    font-size: 10px;
    color:#666;
    margin-top: 2mm;
    line-height: 1.25;
  }

  .card, table { break-inside: avoid; page-break-inside: avoid; }

  
  /* ====== FIX 1-PÁGINA + NO DESORDEN ====== */

/* Contenedor maestro en 2 filas: arriba (mapa+tablas), abajo (comunas) */
.layout{
  display: grid;
  grid-template-rows: 168mm auto; /* fila 1 fija, fila 2 lo que quede */
  gap: 4mm;
}

/* Fila superior (mapa+tablas) */
.grid{
  display:grid;
  grid-template-columns: 30% 70%;
  gap: 4mm;
  align-items: stretch;
  height: 168mm;          /* CLAVE: fija */
  overflow: hidden;       /* CLAVE: nada puede “invadir” */
}

/* Columna derecha ocupa el alto de la fila superior */
.rightCol{
  height: 168mm;
  display:flex;
  flex-direction:column;
  gap:4mm;
}

/* Cada card derecha se reparte el alto disponible */
.rightCol .card{
  height: calc((168mm - 4mm) / 2);
  overflow: hidden;
}

/* MAPA: NO se estira infinito. Se ajusta a la altura de la fila superior */
.mapCard{
  height: 168mm;
  display:flex;
  flex-direction:column;
}

/* el wrap toma el alto completo del mapCard */
.mapWrap{
  height: 100%;
  overflow: hidden;
  border-radius:10px;
  border:1px solid #e2e2e2;
  background:#fff;
}

/* CLAVE: evita que el mapa se “agrande” y se recorte raro */
.mapImg{
  width:100%;
  height:100%;
  object-fit: contain;
  object-position: 50% 70%; /* un poco hacia el sur, pero sin inflar */
  display:block;
}

/* Comunas SIEMPRE abajo, a todo el ancho */
.below{
  width:100%;
  margin-top: 0;          /* el gap ya lo maneja .layout */
  overflow: hidden;       /* asegura 1 página si el texto crece */
}

  
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
    <!-- MAPA -->
    <div class="card mapCard">
      <div class="mapWrap">
        <img class="mapImg" src="${mapUrl}" alt="Mapa de Chile"/>
      </div>
    </div>

    <!-- TABLAS DERECHA -->
    <div class="rightCol">
      ... (tus dos cards de regiones y provincias tal cual) ...
    </div>
  </div>

  <!-- COMUNAS ABAJO A TODO ANCHO -->
  <div class="card below">
    ... (tu tabla de comunas tal cual) ...
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

async function main() {
  const slug = slugArg();
  const summary = await loadSummaryFromShard(slug);

  await buildMapPngWithPlaywright({ slug });
  await buildHtmlReport({ slug, summary });

  console.log(`OK: generado ${OUT_MAPS_DIR}/${slug}.png y ${OUT_REPORTS_DIR}/${slug}.html`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
