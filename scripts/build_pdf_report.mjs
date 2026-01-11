import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright";
import { PNG } from "pngjs";

/**
 * CONFIG
 */
const SUMMARY_DIR = "pdf_summaries/2";
const OUT_REPORTS_DIR = "pdf_reports";
const OUT_MAPS_DIR = "pdf_maps";

const MAP_BASE_URL = "https://crcofre.github.io/mapa-apellidos/";
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
  if (!items) throw new Error(`El shard ${shard} no tiene estructura {"items":[...]}.`);

  const summary = items.find(
    (it) => String(it?.slug ?? "").toLowerCase() === slug
  );

  if (!summary) {
    const sample = items.slice(0, 10).map((it) => it.slug).filter(Boolean);
    throw new Error(
      `No encontré el slug=${slug} dentro de ${shard}. Ejemplos de slugs: ${sample.join(", ")}`
    );
  }

  return summary;
}

/**
 * 1) Captura PNG completo del #map
 * 2) Recorta automáticamente al contenido (Chile) detectando píxeles no-blancos
 */
async function buildMapPngWithPlaywright({ slug }) {
  await fs.ensureDir(OUT_MAPS_DIR);

  const url =
    `${MAP_BASE_URL}?apellido=${encodeURIComponent(slug)}` +
    `&pdf=1&t=${Date.now()}`;

  const outRaw = path.join(OUT_MAPS_DIR, `${slug}.raw.png`);
  const outPng = path.join(OUT_MAPS_DIR, `${slug}.png`);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1100, height: 2200 },
    deviceScaleFactor: 2,
  });

  try {
    await page.route("**/*", (route) => {
      const headers = { ...route.request().headers(), "Cache-Control": "no-cache" };
      route.continue({ headers });
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });

    await page.waitForFunction(
      () => document.documentElement.getAttribute("data-pdf-ready") === "1",
      { timeout: 120000 }
    );

    await page.addStyleTag({
      content: `
        .leaflet-control-container,
        .search-ui,
        #suggestBox,
        #ctaBottomControl,
        .log-panel { display:none !important; }
        html, body, #map { background:#fff !important; }
      `,
    });

    await page.evaluate(() => {
      try { window.map?.invalidateSize?.(true); } catch(e) {}
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      try { window.map?.invalidateSize?.(true); } catch(e) {}
    });

    const mapEl = await page.$("#map");
    if (!mapEl) throw new Error("No encontré el elemento #map en la página del mapa.");

    // Screenshot del #map completo (sin recorte)
    await mapEl.screenshot({ path: outRaw, type: "png" });

    // Recorte automático por contenido
    await autoCropPngByContent(outRaw, outPng, {
      margin: 60,         // margen alrededor del contenido (px)
      whiteThreshold: 250 // 0-255: qué tan "blanco" debe ser para considerarlo fondo
    });

    // Limpia raw
    await fs.remove(outRaw).catch(() => {});
    return outPng;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Recorta un PNG detectando el bounding box de píxeles no-blancos.
 */
async function autoCropPngByContent(inPath, outPath, opts = {}) {
  const margin = Number(opts.margin ?? 12);
  const whiteThreshold = Number(opts.whiteThreshold ?? 250);

  const buf = await fs.readFile(inPath);
  const png = PNG.sync.read(buf);

  const { width, height, data } = png;

  let minX = width, minY = height, maxX = -1, maxY = -1;

  // Consideramos "contenido" cualquier pixel que NO sea casi blanco
  // y con alpha > 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];

      if (a === 0) continue; // transparente => fondo
      const isWhite =
        r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold;

      if (!isWhite) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Fallback si no encontró nada (no debería pasar)
  if (maxX < 0 || maxY < 0) {
    await fs.copy(inPath, outPath);
    return;
  }

  // Agrega margen y clampa
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(width - 1, maxX + margin);
  maxY = Math.min(height - 1, maxY + margin);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  const out = new PNG({ width: cropW, height: cropH });

  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcIdx = ((width * (minY + y) + (minX + x)) << 2);
      const dstIdx = ((cropW * y + x) << 2);
      out.data[dstIdx] = data[srcIdx];
      out.data[dstIdx + 1] = data[srcIdx + 1];
      out.data[dstIdx + 2] = data[srcIdx + 2];
      out.data[dstIdx + 3] = data[srcIdx + 3];
    }
  }

  const outBuf = PNG.sync.write(out);
  await fs.writeFile(outPath, outBuf);
}

/**
 * HTML del reporte
 */
async function buildHtmlReport({ slug, summary }) {
  await fs.ensureDir(OUT_REPORTS_DIR);

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
    @page { size: A4; margin: 12mm; }
    html, body { margin:0; padding:0; }
    * { box-sizing: border-box; }

    body{
      font-family: Arial, Helvetica, sans-serif;
      color:#111;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .page{
      width:100%;
      max-width:180mm;
      margin:0 auto;
    }

    .header{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:10px;
      margin-bottom:4mm;
    }
    .brand{ display:flex; align-items:center; gap:10px; }
    .logo{ height:12mm; }
    .meta{ font-size:10px; color:#555; text-align:right; line-height:1.25; padding-top:2mm; }

    h1{ font-size:18px; margin:0 0 2mm; }
    .sub{ font-size:12px; color:#333; margin:0 0 4mm; }

    .grid{
      display:grid;
      grid-template-columns: 40% 60%;
      gap:4mm;
      align-items:stretch;
    }

    .rightCol{
      display:flex;
      flex-direction:column;
      gap:4mm;
    }

    .card{
      border:1px solid #e6e6e6;
      border-radius:10px;
      padding:3mm;
      background:#fff;
    }

   .mapWrap{
  width:100%;
  height:128mm;
  overflow:hidden;
  border:none;
  background:transparent;

  display:flex;
  align-items:flex-end;     /* ancla abajo */
  justify-content:center;   /* centra horizontal */
}

.mapImg{
  height:100%;
  width:auto;               /* mantiene proporción, evita recorte lateral */
  max-width:100%;
  object-fit: contain;      /* clave: NO recorta */
  display:block;

  transform: scale(1.25);   /* “llena más” sin cortar */
  transform-origin: 50% 100%;
}


    h2{ font-size:12.5px; margin:0 0 2mm; }

    table{ width:100%; border-collapse:collapse; table-layout:fixed; }
    th, td{
      border:1px solid #eee;
      padding:2mm 2.2mm;
      font-size:10.5px;
      line-height:1.2;
      word-wrap:break-word;
      overflow-wrap:anywhere;
    }
    thead th{
      background:#f7f7f7;
      text-align:left;
      white-space:normal;
      vertical-align:middle;
      padding-top:1.4mm;
      padding-bottom:1.4mm;
    }
    tbody td{
      height:10mm;
      vertical-align:middle;
      padding-top:1.6mm;
      padding-bottom:1.6mm;
    }

    .t-regiones col.c1{ width:10%; }
    .t-regiones col.c2{ width:70%; }
    .t-regiones col.c3{ width:20%; }

    .t-provincias col.c1{ width:10%; }
    .t-provincias col.c2{ width:30%; }
    .t-provincias col.c3{ width:40%; }
    .t-provincias col.c4{ width:20%; }

    .t-comunas col.c1{ width:6%; }
    .t-comunas col.c2{ width:20%; }
    .t-comunas col.c3{ width:20%; }
    .t-comunas col.c4{ width:42%; }
    .t-comunas col.c5{ width:12%; }

    .below{ margin-top:4mm; }
    .foot{ font-size:11px; color:#666; margin-top:3mm; }

    .card, table{ break-inside:avoid; page-break-inside:avoid; }
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
      <div class="card">
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
