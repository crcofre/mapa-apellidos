import fs from "fs";
import path from "path";

// === CONFIG ===
// Carpeta donde están tus shards "crudos"
const INPUT_DIRS = ["data_fixed", "data"]; // intenta data_fixed primero, luego data

// Carpeta destino (se publica en Pages)
const OUT_DIR = "pdf_summaries";
const OUT_2 = path.join(OUT_DIR, "2");
const OUT_3 = path.join(OUT_DIR, "3");

// Límite seguro bajo 2MB (Make). Dejamos margen.
const MAX_BYTES = 1_900_000;

// Top N
const TOP_N = 5;

// === Helpers ===
const nowISO = () => new Date().toISOString();

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

const listShardFiles = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith("apellidos_") && f.endsWith(".json"))
    .map(f => path.join(dir, f));
};

const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const toUpper = (s) => (s || "").toString().trim().toUpperCase();

const slugFromKey = (slug) => (slug || "").toString().trim().toLowerCase();

const pref2 = (slug) => slugFromKey(slug).slice(0, 2) || "__";
const pref3 = (slug) => slugFromKey(slug).slice(0, 3) || "___";

function buildSummaryForApellido(slug, apellidoObj) {
  const rows = Array.isArray(apellidoObj?.comunas) ? apellidoObj.comunas : [];
  if (!rows.length) return null;

  const total_personas = rows.reduce((acc, r) => acc + safeNum(r.totalapellido), 0);
  const n_comunas = rows.length;

  // Top comunas por prct_apellido
  const topComunas = [...rows]
    .map(r => ({
      comuna: toUpper(r.comuna),
      provincia: toUpper(r.provincia),
      region: toUpper(r.region),
      personas: safeNum(r.totalapellido),
      pct_comuna: safeNum(r.prct_apellido),
    }))
    .sort((a,b) => b.pct_comuna - a.pct_comuna)
    .slice(0, TOP_N)
    .map((r, i) => ({ rank: i+1, ...r }));

  // Provincias: máximo freq_prov por provincia
  const provMap = new Map();
  for (const r of rows) {
    const key = `${toUpper(r.provincia)}||${toUpper(r.region)}`;
    const val = safeNum(r.freq_prov);
    const prev = provMap.get(key);
    if (!prev || val > prev.pct_provincia) {
      provMap.set(key, { provincia: toUpper(r.provincia), region: toUpper(r.region), pct_provincia: val });
    }
  }
  const topProvincias = [...provMap.values()]
    .sort((a,b) => b.pct_provincia - a.pct_provincia)
    .slice(0, TOP_N)
    .map((r, i) => ({ rank: i+1, ...r }));

  // Regiones: máximo freq_reg por región
  const regMap = new Map();
  for (const r of rows) {
    const key = toUpper(r.region);
    const val = safeNum(r.freq_reg);
    const prev = regMap.get(key);
    if (!prev || val > prev.pct_region) {
      regMap.set(key, { region: toUpper(r.region), pct_region: val });
    }
  }
  const topRegiones = [...regMap.values()]
    .sort((a,b) => b.pct_region - a.pct_region)
    .slice(0, TOP_N)
    .map((r, i) => ({ rank: i+1, ...r }));

  // “Apellido” para mostrar
  const apellido = toUpper(apellidoObj?.apellido) || toUpper(slug);

  return {
    apellido,
    slug: slugFromKey(slug),
    total_personas,
    n_comunas,
    top_comunas: topComunas,
    top_provincias: topProvincias,
    top_regiones: topRegiones,
    updated_at: nowISO(),
  };
}

function bytesOfJSON(obj) {
  return Buffer.byteLength(JSON.stringify(obj), "utf8");
}

function writePrettyJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

function main() {
  // Elegir directorio de entrada existente (prioriza data_fixed)
  let inputDir = null;
  for (const d of INPUT_DIRS) {
    if (fs.existsSync(d)) { inputDir = d; break; }
  }
  if (!inputDir) {
    throw new Error(`No encuentro data_fixed/ ni data/ en el repo.`);
  }

  console.log(`Usando shards desde: ${inputDir}`);

  // Preparar salidas
  ensureDir(OUT_2);
  ensureDir(OUT_3);

  // 1) Construir resúmenes en memoria agrupados por pref2
  const grouped2 = new Map(); // pref2 -> { slug: summary }
  const shardFiles = listShardFiles(inputDir);

  console.log(`Shards encontrados: ${shardFiles.length}`);

  for (const file of shardFiles) {
    const shard = readJSON(file);
    for (const [slug, apellidoObj] of Object.entries(shard)) {
      const s = buildSummaryForApellido(slug, apellidoObj);
      if (!s) continue;

      const p2 = pref2(slug);
      if (!grouped2.has(p2)) grouped2.set(p2, {});
      grouped2.get(p2)[slugFromKey(slug)] = s;
    }
  }

  // 2) Escribir por pref2 y “partir” si supera tamaño
  const splitPrefixes = []; // pref2 que fueron divididos a pref3

  // Limpia output previo
  fs.rmSync(OUT_2, { recursive: true, force: true });
  fs.rmSync(OUT_3, { recursive: true, force: true });
  ensureDir(OUT_2);
  ensureDir(OUT_3);

  for (const [p2, obj] of grouped2.entries()) {
    const outFile2 = path.join(OUT_2, `apellidos_${p2}.json`);
    const size = bytesOfJSON(obj);

    if (size <= MAX_BYTES) {
      writePrettyJSON(outFile2, obj);
      continue;
    }

    // Si es muy grande, lo dividimos por pref3
    splitPrefixes.push(p2);

    const grouped3 = new Map(); // pref3 -> { slug: summary }
    for (const [slug, summary] of Object.entries(obj)) {
      const p3 = pref3(slug);
      if (!grouped3.has(p3)) grouped3.set(p3, {});
      grouped3.get(p3)[slug] = summary;
    }

    for (const [p3, obj3] of grouped3.entries()) {
      const outFile3 = path.join(OUT_3, `apellidos_${p3}.json`);
      writePrettyJSON(outFile3, obj3);
    }
  }

  // 3) Guardar lista de prefijos divididos
  ensureDir(OUT_DIR);
  const splitFile = path.join(OUT_DIR, "split_prefixes.json");
  writePrettyJSON(splitFile, { split_prefixes: splitPrefixes.sort(), max_bytes: MAX_BYTES });

  console.log(`Listo. Prefijos partidos (a 3 letras): ${splitPrefixes.length}`);
  console.log(`Salida: ${OUT_DIR}/`);
}

main();
