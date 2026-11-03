// Índices oficiales del INDEC (Catálogo API-INDEC) para pasar los montos a términos reales.
//   GET /api/indices  ->  { actualizado, ipc:{etiqueta, regiones:{Nacional:{'2025-01':valor,…},…}}, icc:{general:{…}, materiales, mano_obra, gastos_generales}, avisos }
// El token del INDEC vive solo acá (variable de entorno INDEC_TOKEN en Vercel); el navegador nunca lo ve.
// Solo responde a usuarios con sesión de Firebase válida.
//
// La API todavía está en BETA y no publica ejemplos de sus valores, así que las series no se piden por
// rótulos fijos: primero se miran las filas más recientes, se elige la que corresponde (nivel general,
// tipo "índice") y después se baja la serie completa filtrando por todas las columnas de esa fila.
import { verificarSesion, httpError, responderError, hoyArgentina } from "./_auth.js";

const BASE = "https://api.indec.gob.ar/v1/";
const POR_PAGINA = 1000;   // la API devuelve como máximo 1000 filas por pedido
const MAX_PAGINAS = 12;
const VIGENCIA = 6 * 3600 * 1000;   // los índices salen una vez por mes: alcanza con consultar cada 6 horas

// Columnas que no identifican la serie (cambian mes a mes o son el dato)
const NO_CLAVE = new Set(["periodo", "anio", "mes", "valor", "observaciones"]);

let cache = null;   // {t, datos}: dura mientras la instancia de Vercel siga viva

const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

async function pedir(tabla, params) {
  const token = (process.env.INDEC_TOKEN || "").trim();
  if (!token) throw httpError(500, "Falta configurar INDEC_TOKEN en Vercel (el token se genera en api.indec.gob.ar).");
  const url = BASE + tabla + "?" + new URLSearchParams(params).toString();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (r.status === 401) throw httpError(502, "El INDEC rechazó el token: generá uno nuevo en api.indec.gob.ar y actualizá INDEC_TOKEN en Vercel.");
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw httpError(502, `El INDEC respondió ${r.status} en ${tabla}: ${d.message || "error"}`);
  }
  return r.json();
}

async function todas(tabla, params) {
  const filas = [];
  for (let p = 0; p < MAX_PAGINAS; p++) {
    const parte = await pedir(tabla, { ...params, limit: String(POR_PAGINA), offset: String(p * POR_PAGINA) });
    filas.push(...parte);
    if (parte.length < POR_PAGINA) break;
  }
  return filas;
}

// ¿La fila es el índice (y no una variación, incidencia o precio)?
function esIndice(f) {
  const t = norm(`${f.tipo_de_indicador} ${f.tipo_de_indicador_descripcion} ${f.unidad_de_medida}`);
  return /indice|base/.test(t) && !/varia|incid|precio|ponder/.test(t);
}
function esVarMensual(f) {
  const t = norm(`${f.tipo_de_indicador} ${f.tipo_de_indicador_descripcion}`);
  return /varia/.test(t) && /mensual|intermensual/.test(t) && !/inter ?anual|acum/.test(t);
}

// Filtros PostgREST "eq" con todas las columnas que identifican la serie de la fila modelo
function filtroSerie(modelo, sin = []) {
  const p = {};
  for (const [k, v] of Object.entries(modelo)) {
    if (NO_CLAVE.has(k) || sin.includes(k)) continue;
    p[k] = v == null ? "is.null" : "eq." + v;
  }
  return p;
}

const aMes = periodo => { const s = String(periodo); return s.length >= 6 ? `${s.slice(0, 4)}-${s.slice(4, 6)}` : null; };

// Arma {AAAA-MM: valor}. Si solo hay variación mensual, encadena un índice con base 100 en el primer mes.
function serie(filas, encadenar) {
  const out = {};
  const ord = filas.filter(f => f.valor != null && aMes(f.periodo)).sort((a, b) => String(a.periodo) < String(b.periodo) ? -1 : 1);
  let acc = 100;
  for (const f of ord) {
    const m = aMes(f.periodo);
    if (m in out) continue;
    if (encadenar) { acc *= 1 + Number(f.valor) / 100; out[m] = Math.round(acc * 1e4) / 1e4; }
    else out[m] = Number(f.valor);
  }
  return out;
}

// Entre filas candidatas elige la mejor coincidencia de descripción: igual > empieza con > contiene; la más corta
function mejor(filas, buscado, extra = () => true) {
  const b = norm(buscado);
  const puntaje = f => { const d = norm(f.descripcion); return d === b ? 3 : d.startsWith(b) ? 2 : d.includes(b) ? 1 : 0; };
  const c = filas.filter(f => puntaje(f) > 0 && extra(f));
  c.sort((x, y) => puntaje(y) - puntaje(x) || norm(x.descripcion).length - norm(y.descripcion).length);
  return c[0] || null;
}

async function leerIPC() {
  const recientes = await pedir("ipc_nacional", { descripcion: "ilike.*nivel general*", order: "periodo.desc", limit: "1000" });
  if (!recientes.length) throw new Error("no se encontró el nivel general del IPC");
  let modelo = mejor(recientes, "nivel general", esIndice);
  let encadenar = false;
  if (!modelo) { modelo = mejor(recientes, "nivel general", esVarMensual); encadenar = true; }
  if (!modelo) throw new Error("no se encontró la serie de índice del IPC");
  const filas = await todas("ipc_nacional", { ...filtroSerie(modelo, ["region"]), order: "region,periodo" });
  const porRegion = {};
  for (const f of filas) (porRegion[f.region || "Nacional"] ||= []).push(f);
  const regiones = Object.fromEntries(Object.entries(porRegion).map(([r, fs]) => [r, serie(fs, encadenar)]));
  return { etiqueta: modelo.descripcion, base: encadenar ? "encadenado desde la variación mensual" : modelo.unidad_de_medida || "", regiones };
}

const CAPITULOS_ICC = { general: "nivel general", materiales: "materiales", mano_obra: "mano de obra", gastos_generales: "gastos generales" };

async function leerICC() {
  const recientes = await pedir("icc_precios_construccion", {
    or: "(descripcion.ilike.*nivel general*,descripcion.ilike.*materiales*,descripcion.ilike.*mano de obra*,descripcion.ilike.*gastos generales*)",
    order: "periodo.desc", limit: "1000",
  });
  const out = {}, etiquetas = {}, faltan = [];
  for (const [clave, buscado] of Object.entries(CAPITULOS_ICC)) {
    let modelo = mejor(recientes, buscado, esIndice), encadenar = false;
    if (!modelo) { modelo = mejor(recientes, buscado, esVarMensual); encadenar = true; }
    if (!modelo) { faltan.push(buscado); continue; }
    const filas = await todas("icc_precios_construccion", { ...filtroSerie(modelo), order: "periodo" });
    out[clave] = serie(filas, encadenar);
    etiquetas[clave] = modelo.descripcion;
  }
  if (!out.general) throw new Error("no se encontró el nivel general del ICC");
  return { ...out, etiquetas, faltan };
}

async function leerTodo() {
  const avisos = [];
  const [ipc, icc] = await Promise.all([
    leerIPC().catch(e => { if (e.status) throw e; avisos.push("IPC: " + e.message); return null; }),
    leerICC().catch(e => { if (e.status) throw e; avisos.push("ICC: " + e.message); return null; }),
  ]);
  if (icc?.faltan?.length) avisos.push("ICC sin apertura para: " + icc.faltan.join(", ") + " (se usa el nivel general)");
  if (!ipc && !icc) throw httpError(502, "No se pudieron leer los índices del INDEC. " + avisos.join(" · "));
  return { actualizado: hoyArgentina(), fuente: "INDEC — Catálogo API-INDEC", ipc, icc, avisos };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Método no permitido" }); }
    await verificarSesion(req, { soloSesion: true });
    const forzar = req.query?.forzar === "1";
    if (!cache || forzar || Date.now() - cache.t > VIGENCIA) cache = { t: Date.now(), datos: await leerTodo() };
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.status(200).json(cache.datos);
  } catch (e) {
    responderError(res, e);
  }
}
