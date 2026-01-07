// scripts/build_pdf_report.mjs
import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright";

/**
 * =========================
 * CONFIGURACIÓN
 * =========================
 */
const SUMMARY_DIR = "pdf_summaries/2";      // carpeta donde están los shards apellidos_xx.json
const OUT_REPORTS_DIR = "pdf_reports";      // salida HTML pública
const OUT_MAPS_DIR = "pdf_maps";            // salida PNG pública

// URL base de tu GitHub Pages del mapa (sin slash final idealmente)
const MAP_BASE_URL = "https://crcofre.github.io/mapa-apellidos";

// Logo apellidos.cl (el tuyo)
const LOGO_URL = "https://images.jumpseller.com/store/familias-y-apellidos/store/logo/Sitio_web.png?1741039595";

// Render settings del PNG (tamaño final del mapa exportado)
const MAP_EXPORT_WIDTH = 900;
const MAP_EXPORT_HEIGHT = 1100;

// Esperas (ms) para dar tiempo a Leaflet a pintar
const WAIT_AFTER_GOTO_MS = 1200;
const WAIT_AFTER_SEARCH_MS = 1200;

/**
 * =========================
 * UTILS
 * =========================
 */
function slugArg() {
  const idx = process.argv.indexOf("--slug");
  if (idx === -1 || !process.argv[idx + 1]) {
    throw new Error('Falta parámetro --slug (ej: node scripts/build_pdf_report.mjs --slug lucero)');
  }
  return process.argv[idx + 1].trim().toLowerCase();
}

function htmlEscape(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function formatPct(x){
  // deja 2 decimales
  if (x === null || x === undefined || x === "") return "";
  const n = Number(x);
  if (Number.isNaN(n)) return String(x);
  return n.toFixed(2);
}

function tableRow(cells){
  return `<tr>${cells.map(c => `<td>${htmlEscape(c)}</td>`).join("")}</tr>`;
}

/**
 * =========================
 * 1) CARGAR SUMMARY DESDE SHARD
 * Estructura shard: { "items": [ { slug, apellido, ... } ] }
 * Archivo shard: apellidos_<2 letras>.json
 * =========================
 */
async function loadSummaryFromShard(slug){
  const base = path.resolve(SUMMARY_DIR);
  if (!(await fs.pathExists(base))) {
    throw new Error(`No existe SUMMARY_DIR: ${SUMMARY_DIR}. Ajusta SUMMARY_DIR en el script.`);
  }

  const p2 = slug.slice(0, 2);
  const shard = path.join(base, `apellidos_${p2}.json`);

  if (!(await fs.pathExists(shard))) {
    throw new Error(`No existe shard esperado: ${shard}. Revisa que exista apellidos_${p2}.json en ${SUMMARY_DIR}`);
  }

  const data = await fs.readJson(shard);

  const items = Array.isArray(data?.items) ? data.items : null;
  if (!items) {
    throw new Error(`El shard ${shard} no tiene estructura {"items":[...]}.`);
  }

  const summary = items.find(it => String(it?.slug ?? "").toLowerCase() === slug);

  if (!summary) {
    const sample = items.slice(0, 10).map(it => it.slug).filter(Boolean);
    throw new Error(`No encontré el slug=${slug} dentro de ${shard}. Ejemplos: ${sample.join(", ")}`);
  }

  return summary;
}

/**
 * =========================
 * 2) GENERAR PNG DEL MAPA (Leaflet) CON PLAYWRIGHT
 * Usa una URL de export:
 *   ${MAP_BASE_URL}/?export=1&apellido=<slug>&nivel=region&w=900&h=1100
 *
 * Requiere que tu index.html del mapa implemente esos parámetros:
 * - export=1: oculta UI y fija tamaño del #map a w/h
 * - apellido: autocompleta input y ejecuta buscarApellido()
 * - nivel: region|provincia|comuna (modo manual)
 * =========================
 */
async function buildMapPngLeaflet({ slug }){
  await fs.ensureDir(OUT_MAPS_DIR);

  const url =
    `${MAP_BASE_URL}/?export=1` +
    `&apellido=${encodeURIComponent(slug)}` +
    `&nivel=region` +
    `&w=${MAP_EXPORT_WIDTH}` +
    `&h=${MAP_EXPORT_HEIGHT}`;

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  // viewport un poco mayor que el mapa para evitar cortes por scrollbars
  const page = await browser.newPage({
    viewport: { width: MAP_EXPORT_WIDTH + 120, height: MAP_EXPORT_HEIGHT + 160 }
  });

  // Carga inicial
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(WAIT_AFTER_GOTO_MS);

  // Espera a que exista #map
  await page.waitForSelector("#map", { timeout: 15000 });

  // Si tu export mode deja #map con width/height fijos, esto debería bastar.
  // Damos un margen extra por si Leaflet termina de pintar.
  await page.waitForTimeout(WAIT_AFTER_SEARCH_MS);

  const mapEl = await page.$("#map");
  if (!mapEl) {
    await browser.close();
    throw new Error("No encontré #map en la página de exportación.");
  }

  const outPng = path.join(OUT_MAPS_DIR, `${slug}.png`);
  await mapEl.screenshot({ path: outPng });

  await browser.close();
  return outPng;
}

/**
 * =========================
 * 3) GENERAR HTML REPORTE (con logo y tablas)
 * =========================
 */
async function buildHtmlReport({ slug, summary }) {
  await fs.ensureDir(OUT_REPORTS_DIR);

  // Este PNG será publicado por GitHub Pages dentro del repo
  const mapUrl = `${MAP_BASE_URL}/${OUT_MAPS_DIR}/${slug}.png`;

  const regionesRows = (summary.top_regiones || []).map(r =>
    tableRow([r.rank, r.region, `${formatPct(r.pct_region)}%`])
  ).join("");

  const provinciasRows = (summary.top_provincias || []).map(r =>
    tableRow([r.rank, r.provincia, r.region, `${formatPct(r.pct_provincia)}%`])
  ).join("");

  const comunasRows = (summary.top_comunas || []).map(r =>
    tableRow([r.rank, r.comuna, r.provincia, r.region, r.personas, `${formatPct(r.pct_comuna)}%`])
  ).join("");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Informe ${htmlEscape(summary.apellido)}</title>
  <style>
    body{ font-family: Arial, Helvetica, sans-serif; margin:0; color:#111; }
    .page{ padding:26px 32px; max-width: 900px; margin:0 auto; }
    .header{ display:flex; justify-content:space-between; align-items:center; gap:16px; }
    .logo{ height:42px; }
    .meta{ font-size:12px; color:#555; text-align:right; line-height:1.35; }
    h1{ font-size:22px; margin:14px 0 6px; }
    .sub{ color:#444; font-size:13px; margin:0 0 14px; }
    .card{ border:1px solid #e6e6e6; border-radius:12px; padding:14px; margin:12px 0; }
    .kpis{ display:flex; gap:12px; flex-wrap:wrap; }
    .kpi{ flex:1; min-width:220px; font-size:12px; color:#666; }
    .kpi strong{ display:block; font-size:18px; color:#111; margin-top:2px; }
    img.map{ width:100%; max-width:520px; display:block; margin:12px auto 0; border:1px solid #e2e2e2; border-radius:12px; }
    h2{ font-size:15px; margin:0 0 10px; }
    table{ width:100%; border-collapse:collapse; }
    th, td{ border:1px solid #eee; padding:8px 10px; font-size:12.5px; vertical-align:top; }
    th{ background:#f7f7f7; text-align:left; }
    .foot{ font-size:11px; color:#666; margin-top:14px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <img class="logo" src="${LOGO_URL}" alt="Apellidos.cl"/>
      <div class="meta">
        Actualizado: ${htmlEscape(summary.updated_at || "")}
      </div>
    </div>

    <h1>Mapa del apellido ${htmlEscape(summary.apellido || "")}</h1>
    <p class="sub">Distribución relativa por territorio en Chile. Tonos más oscuros indican mayor frecuencia relativa.</p>

    <div class="card">
      <div class="kpis">
        <div class="kpi">Personas registradas<strong>${htmlEscape(summary.total_personas)}</strong></div>
        <div class="kpi">Comunas con presencia<strong>${htmlEscape(summary.n_comunas)}</strong></div>
      </div>
      <img class="map" src="${mapUrl}" alt="Mapa de Chile"/>
    </div>

    <div class="card">
      <h2>Top regiones</h2>
      <table>
        <thead><tr><th>#</th><th>Región</th><th>Frecuencia</th></tr></thead>
        <tbody>${regionesRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Top provincias</h2>
      <table>
        <thead><tr><th>#</th><th>Provincia</th><th>Región</th><th>Frecuencia</th></tr></thead>
        <tbody>${provinciasRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Top comunas</h2>
      <table>
        <thead><tr><th>#</th><th>Comuna</th><th>Provincia</th><th>Región</th><th>Personas</th><th>Frecuencia</th></tr></thead>
        <tbody>${comunasRows}</tbody>
      </table>
    </div>

    <div class="foot">
      Fuente: Apellidos.cl / Mapa de apellidos en Chile. Este informe es referencial y se basa en frecuencias relativas.
    </div>
  </div>
</body>
</html>`;

  const outHtml = path.join(OUT_REPORTS_DIR, `${slug}.html`);
  await fs.writeFile(outHtml, html, "utf8");
  return outHtml;
}

/**
 * =========================
 * MAIN
 * =========================
 */
async function main(){
  const slug = slugArg();

  // 1) summary desde shard
  const summary = await loadSummaryFromShard(slug);

  // 2) mapa PNG (Leaflet headless)
  await buildMapPngLeaflet({ slug });

  // 3) html
  await buildHtmlReport({ slug, summary });

  console.log(`OK: generado ${OUT_MAPS_DIR}/${slug}.png y ${OUT_REPORTS_DIR}/${slug}.html`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
