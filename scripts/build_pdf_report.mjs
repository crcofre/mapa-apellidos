// scripts/build_pdf_report.mjs
import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright";
import { PNG } from "pngjs";

/**
 * CONFIG
 */
const SUMMARY_DIR_2 = "pdf_summaries/2";
const SUMMARY_DIR_3 = "pdf_summaries/3";
const OUT_REPORTS_DIR = "pdf_reports";
const OUT_MAPS_DIR = "pdf_maps";

const RAW_BASE_URL = "https://raw.githubusercontent.com/CRCOFRE/mapa-apellidos/main/";
const LOGO_URL =
  "https://images.jumpseller.com/store/familias-y-apellidos/store/logo/Sitio_web.png?1741039595";

/**
 * PNG final: altura fija (equivalente a 128mm en un PDF “bonito”)
 * Ajusta SOLO estas 2 constantes si quieres:
 */
const MAP_TARGET_HEIGHT_MM = 128;
const MAP_RENDER_DPI = 300;
const MAP_TARGET_HEIGHT_PX = Math.round((MAP_TARGET_HEIGHT_MM / 25.4) * MAP_RENDER_DPI);

/**
 * TIMEOUTS (robustez en GitHub Actions)
 */
const NAV_TIMEOUT_MS = 180000;   // navegación
const WAIT_READY_MS = 180000;    // espera data-pdf-ready
const LEAFLET_FALLBACK_MS = 120000; // fallback esperando Leaflet (antes 30s)

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
 * Carga summary desde shards:
 * - pdf_summaries/2/apellidos_xx.json (2 letras)
 * - pdf_summaries/3/apellidos_xxx.json (3 letras)
 * Estructura esperada: {"items":[...]}
 */
async function loadSummaryFromShard(slug) {
  const attempts = [
    { dir: SUMMARY_DIR_2, prefixLen: 2 },
    { dir: SUMMARY_DIR_3, prefixLen: 3 },
  ];

  const errors = [];

  for (const a of attempts) {
    const base = path.resolve(a.dir);

    if (!(await fs.pathExists(base))) {
      errors.push(`No existe dir: ${a.dir}`);
      continue;
    }

    const pref = slug.slice(0, a.prefixLen);
    const shard = path.join(base, `apellidos_${pref}.json`);

    if (!(await fs.pathExists(shard))) {
      errors.push(`No existe shard: ${a.dir}/apellidos_${pref}.json`);
      continue;
    }

    const data = await fs.readJson(shard);
    const items = Array.isArray(data?.items) ? data.items : null;
    if (!items) {
      errors.push(`Shard sin estructura {"items":[...]}: ${shard}`);
      continue;
    }

    const summary = items.find(
      (it) => String(it?.slug ?? "").toLowerCase() === slug
    );

    if (summary) return summary;

    errors.push(`No encontré slug=${slug} en ${shard}`);
  }

  throw new Error(
    `No pude resolver slug=${slug} en pdf_summaries/2 ni /3.\n` +
      errors.map((e) => `- ${e}`).join("\n")
  );
}

/**
 * 1) Captura PNG completo del #map (con Leaflet real)
 * 2) Auto-crop por contenido (quita aire blanco)
 * 3) Escala el PNG resultante a altura final fija (MAP_TARGET_HEIGHT_PX)
 */
async function buildMapPngWithPlaywright({ slug }) {
  await fs.ensureDir(OUT_MAPS_DIR);

  const url =
    `${RAW_BASE_URL}?apellido=${encodeURIComponent(slug)}` +
    `&pdf=1&t=${Date.now()}`;

  const outRaw = path.join(OUT_MAPS_DIR, `${slug}.raw.png`);
  const outCrop = path.join(OUT_MAPS_DIR, `${slug}.crop.png`);
  const outPng = path.join(OUT_MAPS_DIR, `${slug}.png`);
  const outPageError = path.join(OUT_MAPS_DIR, `${slug}.pageerror.png`);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1100, height: 2200 },
    deviceScaleFactor: 2,
  });

  // Blindaje: evitar que Playwright caiga a 30s por defecto
  page.setDefaultTimeout(WAIT_READY_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    // --- DEBUG: captura logs/errores de la página (quedan en el log de Actions) ---
    page.on("console", (msg) =>
      console.log("[PAGE CONSOLE]", msg.type(), msg.text())
    );
    page.on("pageerror", (err) =>
      console.log("[PAGE ERROR]", err?.message || String(err))
    );
    page.on("requestfailed", (req) =>
      console.log(
        "[REQ FAILED]",
        req.url(),
        req.failure()?.errorText || "(no errorText)"
      )
    );
    // Log de HTTP >=400 con URL exacta (clave para cazar los 404)
    page.on("response", (res) => {
      const s = res.status();
      if (s >= 400) console.log("[HTTP]", s, res.url());
    });

    // Fuerza no-cache
    await page.route("**/*", (route) => {
      const headers = {
        ...route.request().headers(),
        "Cache-Control": "no-cache",
      };
      route.continue({ headers });
    });

    // Carga inicial (más estable que networkidle en mapas con tiles)
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    console.log("Waiting for data-pdf-ready with", WAIT_READY_MS, "ms...");

    // Espera a que tu mapa marque listo
    try {
      await page.waitForFunction(
        () => document.documentElement.getAttribute("data-pdf-ready") === "1",
        { timeout: WAIT_READY_MS }
      );
    } catch (e) {
      // Diagnóstico: screenshot + valor actual del atributo
      await page.screenshot({ path: outPageError, fullPage: true }).catch(() => {});
      const attr = await page
        .evaluate(() => document.documentElement.getAttribute("data-pdf-ready"))
        .catch(() => null);

      console.log("data-pdf-ready attribute:", attr);
      console.log("Saved diagnostic screenshot:", outPageError);

      // Fallback: si no se setea el flag, espera Leaflet (más tiempo que antes)
      try {
        console.log("Fallback: waiting for Leaflet panes with", LEAFLET_FALLBACK_MS, "ms...");
        await page.waitForSelector(".leaflet-pane", { timeout: LEAFLET_FALLBACK_MS });
        await page.waitForTimeout(2500);
      } catch (_) {
        // no-op: mantenemos el error original
      }

      const attr2 = await page
        .evaluate(() => document.documentElement.getAttribute("data-pdf-ready"))
        .catch(() => null);

      // Si sigue sin estar listo, aborta (para no generar PNG vacío)
      if (attr2 !== "1") throw e;
    }

    // Oculta UI / fuerza fondo blanco
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

    // Reflow Leaflet
    await page.evaluate(() => {
      try {
        window.map?.invalidateSize?.(true);
      } catch (e) {}
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      try {
        window.map?.invalidateSize?.(true);
      } catch (e) {}
    });

    const mapEl = await page.$("#map");
    if (!mapEl) {
      await page.screenshot({ path: outPageError, fullPage: true }).catch(() => {});
      throw new Error(`No encontré #map en la página del mapa. Ver screenshot: ${outPageError}`);
    }

    // 1) Screenshot del #map completo (con aire)
    await mapEl.screenshot({ path: outRaw, type: "png" });

    // 2) Auto-crop (quita aire blanco)
    await autoCropPngByContent(outRaw, outCrop, {
      margin: 14,
      whiteThreshold: 252,
      alphaThreshold: 5,
    });

    // 3) Escala a altura final fija
    const buf = await fs.readFile(outCrop);
    const png = PNG.sync.read(buf);
    const resized = resizePngToHeight(png, MAP_TARGET_HEIGHT_PX);
    await fs.writeFile(outPng, PNG.sync.write(resized));

    // Limpieza
    await fs.remove(outRaw).catch(() => {});
    await fs.remove(outCrop).catch(() => {});

    return outPng;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Recorta un PNG detectando bounding box de píxeles no-blancos.
 */
async function autoCropPngByContent(inPath, outPath, opts = {}) {
  const margin = Number(opts.margin ?? 12);
  const whiteThreshold = Number(opts.whiteThreshold ?? 252);
  const alphaThreshold = Number(opts.alphaThreshold ?? 5);

  const buf = await fs.readFile(inPath);
  const png = PNG.sync.read(buf);

  const { width, height, data } = png;

  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2],
        a = data[i + 3];

      if (a <= alphaThreshold) continue;

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

  // Fallback si no detecta nada
  if (maxX < 0 || maxY < 0) {
    await fs.copy(inPath, outPath);
    return;
  }

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

  await fs.writeFile(outPath, PNG.sync.write(out));
}

/**
 * Escala un PNG a una altura objetivo (px) manteniendo proporción.
 * (Interpolación bilineal simple)
 */
function resizePngToHeight(png, targetH) {
  const srcW = png.width;
  const srcH = png.height;
  const scale = targetH / srcH;

  const dstH = Math.max(1, Math.round(srcH * scale));
  const dstW = Math.max(1, Math.round(srcW * scale));

  const src = png.data;
  const out = new PNG({ width: dstW, height: dstH });

  for (let y = 0; y < dstH; y++) {
    const sy = (y + 0.5) / scale - 0.5;
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcH - 1, Math.max(0, y0 + 1));
    const wy = sy - y0;
    const yy0 = Math.min(srcH - 1, Math.max(0, y0));

    for (let x = 0; x < dstW; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcW - 1, Math.max(0, x0 + 1));
      const wx = sx - x0;
      const xx0 = Math.min(srcW - 1, Math.max(0, x0));

      const i00 = ((yy0 * srcW + xx0) << 2);
      const i10 = ((yy0 * srcW + x1) << 2);
      const i01 = ((y1 * srcW + xx0) << 2);
      const i11 = ((y1 * srcW + x1) << 2);

      const o = ((y * dstW + x) << 2);

      for (let c = 0; c < 4; c++) {
        const v00 = src[i00 + c];
        const v10 = src[i10 + c];
        const v01 = src[i01 + c];
        const v11 = src[i11 + c];

        const v0 = v00 + (v10 - v00) * wx;
        const v1 = v01 + (v11 - v01) * wx;
        out.data[o + c] = Math.round(v0 + (v1 - v0) * wy);
      }
    }
  }

  return out;
}

/**
 * HTML del reporte (usa el PNG ya “listo”)
 * Objetivo: que quepa en 1 hoja (footer fijo + reserva de espacio).
 */
async function buildHtmlReport({ slug, summary }) {
  await fs.ensureDir(OUT_REPORTS_DIR);

  // IMPORTANTE: en Pages, el PNG está público aquí:
  const mapUrl = `${RAW_BASE_URL}pdf_maps/${slug}.png?v=${Date.now()}`;


  const regionesRows = (summary.top_regiones || [])
    .map((r) =>
      tableRow([r.rank, cleanRegionLabel(r.region), `${formatPct(r.pct_region)}%`])
    )
    .join("");

  const provinciasRows = (summary.top_provincias || [])
    .map((r) =>
      tableRow([
        r.rank,
        r.provincia,
        cleanRegionLabel(r.region),
        `${formatPct(r.pct_provincia)}%`,
      ])
    )
    .join("");

  const comunasRows = (summary.top_comunas || [])
    .map((r) =>
      tableRow([
        r.rank,
        r.comuna,
        r.provincia,
        cleanRegionLabel(r.region),
        `${formatPct(r.pct_comuna)}%`,
      ])
    )
    .join("");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Informe ${htmlEscape(summary.apellido)}</title>
  <style>
    @page { size: A4; margin: 10mm; }
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
      padding-bottom: 16mm; /* reserva espacio para el footer fijo */
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
      grid-template-columns: calc(40% - 2mm) calc(60% - 2mm);
      gap:3mm;
      align-items:stretch;
    }

    .rightCol{
      display:flex;
      flex-direction:column;
      gap:3mm;
    }

    .card{
      border:1px solid #e6e6e6;
      border-radius:10px;
      padding:3mm;
      background:#fff;
    }

    .card.below{
      margin-top:4mm;
    }

    .mapWrap{
      width:100%;
      height:${MAP_TARGET_HEIGHT_MM}mm;
      display:flex;
      align-items:stretch;
      justify-content:center;
      overflow:hidden;
    }
    .mapImg{
      height:100%;
      width:auto;
      max-width:100%;
      display:block;
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
      height:9mm;
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

    .foot{
      position: fixed;
      left: 10mm;
      right: 10mm;
      bottom: 8mm;
      font-size: 10px;
      color:#666;
      margin:0;
      background:#fff;
    }

    .card, table{ break-inside:avoid; page-break-inside:avoid; }

    .cta{ margin-top:4mm; }
    .ctaRow{
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:6mm;
    }
    .ctaTitle{
      font-size:12.5px;
      font-weight:700;
      margin:0 0 1mm;
    }
    .ctaBtns{ display:flex; gap:2mm; flex-wrap:wrap; }

    .btn{
      display:inline-block;
      padding:2.2mm 3.2mm;
      border-radius:8px;
      font-size:11px;
      text-decoration:none;
      border:1px solid #ddd;
      color:#111;
    }
    .btnPrimary{ background:#111; color:#fff; border-color:#111; }
    .btnGhost{ background:#fff; color:#111; }
  </style>
</head>

<body>
  <div class="page">
    <div class="header">
      <div class="brand">
        <a href="https://www.apellidos.cl" target="_blank" rel="noopener noreferrer">
          <img class="logo" src="${LOGO_URL}" alt="Apellidos.cl"/>
        </a>
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

    <div class="card cta">
      <div class="ctaRow">
        <div class="ctaText">
          <div class="ctaTitle">¿Quieres tu Diploma del Apellido o un Estudio Genealógico?</div>
        </div>
        <div class="ctaBtns">
          <a class="btn btnPrimary" href="https://www.apellidos.cl/diploma" target="_blank" rel="noopener noreferrer">
            Solicitar diploma
          </a>
          <a class="btn btnGhost" href="https://www.apellidos.cl/investigacion-genealogica" target="_blank" rel="noopener noreferrer">
            Solicitar estudio
          </a>
        </div>
      </div>
    </div>

    <div class="foot">
      Fuente:
      <a href="https://www.apellidos.cl/mapa-de-apellidos"
         target="_blank"
         rel="noopener noreferrer">
        https://www.apellidos.cl/mapa-de-apellidos
      </a>
      en Chile. Este reporte presenta las regiones, provincias y comunas donde hay mayor
      frecuencia relativa del apellido, lo que en muchos casos se explica por su antigua
      presencia en aquellos lugares.
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
