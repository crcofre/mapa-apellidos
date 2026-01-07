import fs from "fs-extra";
import path from "path";
import { Resvg } from "@resvg/resvg-js";
import { geoMercator, geoPath } from "d3-geo";

/**
 * CONFIGURACIÓN (AJUSTAR SOLO SI ES NECESARIO)
 * - REGIONES_GEOJSON: ruta al GeoJSON de regiones
 * - SUMMARY_PATH: función que encuentra el summary del apellido (slug)
 */
const REGIONES_GEOJSON = "regiones.json";  // <-- AJUSTA AQUÍ si tu geojson está en otra ruta
const SUMMARY_DIR = "pdf_summaries/2";              // <-- AJUSTA AQUÍ si tus summaries están en otra carpeta

// Salidas públicas (GitHub Pages)
const OUT_REPORTS_DIR = "pdf_reports";
const OUT_MAPS_DIR = "pdf_maps";

// Color ramp (similar a choropleth suave)
const COLORS = ["#e8f1ff", "#cfe2ff", "#9ec5fe", "#6ea8fe", "#3d8bfd", "#0b5ed7"];

// Utils
function slugArg() {
  const idx = process.argv.indexOf("--slug");
  if (idx === -1 || !process.argv[idx + 1]) {
    throw new Error("Falta parámetro --slug (ej: node scripts/build_pdf_report.mjs --slug lucero)");
  }
  return process.argv[idx + 1].trim().toLowerCase();
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function colorForPct(pct, maxPct){
  // pct viene como número (ej 0.29) y maxPct es el máximo observado en regiones
  if (!maxPct || maxPct <= 0) return COLORS[0];
  const t = clamp01(pct / maxPct);
  const i = Math.min(COLORS.length - 1, Math.floor(t * (COLORS.length - 1)));
  return COLORS[i];
}

/**
 * Encuentra el summary del apellido.
 * Tu proyecto ya tiene shards/manifest; como no quiero adivinar,
 * aquí busco recursivamente un archivo que termine en "/<slug>.json".
 */
async function loadSummaryFromShard(slug){
  const base = path.resolve(SUMMARY_DIR);
  if (!(await fs.pathExists(base))) {
    throw new Error(`No existe SUMMARY_DIR: ${SUMMARY_DIR}. Ajusta SUMMARY_DIR en el script.`);
  }

  // shard por 2 letras: apellidos_lu.json
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
    throw new Error(`No encontré el slug=${slug} dentro de ${shard}. Ejemplos de slugs: ${sample.join(", ")}`);
  }

  return summary;
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
  // deja 2 decimales. (0.294137 -> 0.29)
  if (x === null || x === undefined || x === "") return "";
  const n = Number(x);
  if (Number.isNaN(n)) return String(x);
  return n.toFixed(2);
}

function normalizeRegionName(s){
  return String(s ?? "")
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")     // sin tildes
    .replace(/^\s*\d+\.\s*/,"")                          // quita "06. "
    .replace(/^REGION\s+(DE(L)?\s+)?/,"REGION ")         // suaviza prefijo
    .replace(/[^A-Z0-9 ]+/g," ")                         // limpia signos
    .replace(/\s+/g," ")
    .trim();
}

function getSampleCoord(geo){
  // Busca la primera coordenada numérica que encuentre
  const walk = (obj) => {
    if (!obj) return null;
    if (typeof obj[0] === "number" && typeof obj[1] === "number") return obj;
    if (Array.isArray(obj)) {
      for (const it of obj) {
        const r = walk(it);
        if (r) return r;
      }
    } else if (typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        const r = walk(obj[k]);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(geo);
}

function flipLonLatIfNeeded(geo){
  // Heurística:
  // Chile en lon/lat típico: lon ~ [-75..-66], lat ~ [-56..-17]
  // Si el primer par parece lat/lon, lo invertimos.
  const c = getSampleCoord(geo);
  if (!c) return geo;

  const a = Number(c[0]);
  const b = Number(c[1]);

  const looksLikeLonLat =
    a >= -90 && a <= -60 && b >= -60 && b <= -10;   // lon en [-90,-60], lat en [-60,-10]

  const looksLikeLatLon =
    a >= -60 && a <= -10 && b >= -90 && b <= -60;   // lat en [-60,-10], lon en [-90,-60]

  if (!looksLikeLatLon) return geo; // si no parece invertido, no tocar

  // Clonar y voltear todas las coords [x,y] -> [y,x]
  const flipCoords = (obj) => {
    if (!obj) return obj;
    if (typeof obj[0] === "number" && typeof obj[1] === "number") {
      return [obj[1], obj[0]];
    }
    if (Array.isArray(obj)) return obj.map(flipCoords);
    if (typeof obj === "object") {
      const out = {};
      for (const k of Object.keys(obj)) out[k] = flipCoords(obj[k]);
      return out;
    }
    return obj;
  };

  return flipCoords(geo);
}


function tableRow(cells){
  return `<tr>${cells.map(c => `<td>${htmlEscape(c)}</td>`).join("")}</tr>`;
}

async function buildMapPng({ slug, summary, regionesGeo }) {
  // Mapa por REGIÓN usando summary.top_regiones
  // Crea un diccionario: region name -> pct_region
  const pctByRegion = new Map();
const topRegs = summary.top_regiones || [];
for (const r of topRegs) {
  const key = normalizeRegionName(r.region);
  pctByRegion.set(key, Number(r.pct_region));
}


  // Encuentra max
  let maxPct = 0;
  for (const v of pctByRegion.values()) if (v > maxPct) maxPct = v;

  // Proyección simple (Chile largo)
  const width = 800;
  const height = 1100;
  const projection = geoMercator().fitExtent([[30, 20], [width-30, height-20]], regionesGeo);
  const pathGen = geoPath(projection);

  // Construir SVG
  const paths = regionesGeo.features.map((f) => {
    const d = pathGen(f);
    // OJO: debes ajustar "propName" si tu geojson usa otra propiedad para el nombre.
    // Intento 3 opciones típicas:
    const props = f.properties || {};
    const regionNameRaw = (props.REGION || "");
const regionKey = normalizeRegionName(regionNameRaw);

const pct = pctByRegion.get(regionKey) ?? 0;

    const fill = colorForPct(pct, maxPct);

    return `<path d="${d}" fill="${fill}" stroke="#1f3b64" stroke-width="0.6" />`;

  }).join("\n");

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <g>${paths}</g>
  </svg>`.trim();

  // SVG -> PNG (resvg)
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 800 } });
  const pngData = resvg.render().asPng();

  await fs.ensureDir(OUT_MAPS_DIR);
  const outPng = path.join(OUT_MAPS_DIR, `${slug}.png`);
  await fs.writeFile(outPng, pngData);
  return outPng;
}

async function buildHtmlReport({ slug, summary }) {
  await fs.ensureDir(OUT_REPORTS_DIR);

  const logoUrl = "https://images.jumpseller.com/store/familias-y-apellidos/store/logo/Sitio_web.png?1741039595"; // <-- AJUSTA a tu URL real del logo (puede ser SVG/PNG)
  const mapUrl = `https://crcofre.github.io/mapa-apellidos/${OUT_MAPS_DIR}/${slug}.png`;

  // Tablas
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
      <img class="logo" src="${logoUrl}" alt="Apellidos.cl"/>
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

async function main(){
  const slug = slugArg();

  // 1) summary
  const summary = await loadSummaryFromShard(slug);


  // 2) geojson regiones
  if (!(await fs.pathExists(REGIONES_GEOJSON))) {
    throw new Error(`No existe REGIONES_GEOJSON: ${REGIONES_GEOJSON}. Ajusta la ruta en el script.`);
  }
  let regionesGeo = await fs.readJson(REGIONES_GEOJSON);
regionesGeo = flipLonLatIfNeeded(regionesGeo);


  // 3) png + html
  await buildMapPng({ slug, summary, regionesGeo });
  await buildHtmlReport({ slug, summary });

  console.log(`OK: generado ${OUT_MAPS_DIR}/${slug}.png y ${OUT_REPORTS_DIR}/${slug}.html`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
