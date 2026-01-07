import fs from "fs-extra";
import path from "path";
import { chromium } from "playwright";

function slugArg() {
  const idx = process.argv.indexOf("--slug");
  if (idx === -1 || !process.argv[idx + 1]) {
    throw new Error("Falta --slug (ej: node scripts/render_leaflet_png.mjs --slug lucero)");
  }
  return process.argv[idx + 1].trim().toLowerCase();
}

async function main(){
  const slug = slugArg();

  const OUT_MAPS_DIR = "pdf_maps";
  await fs.ensureDir(OUT_MAPS_DIR);

  // URL de exportación (sin UI) + tamaño fijo
  const url = `https://crcofre.github.io/mapa-apellidos/?export=1&apellido=${encodeURIComponent(slug)}&nivel=region&w=900&h=1100`;

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 980, height: 1250 } });

  // Carga
  await page.goto(url, { waitUntil: "networkidle" });

  // Espera a que el mapa pinte (un poco de margen)
  await page.waitForTimeout(1200);

  // Screenshot SOLO del div #map
  const mapEl = await page.$("#map");
  if (!mapEl) throw new Error("No encontré #map en la página.");

  const outPath = path.join(OUT_MAPS_DIR, `${slug}.png`);
  await mapEl.screenshot({ path: outPath });

  await browser.close();
  console.log("OK PNG:", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
