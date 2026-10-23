// Lee una factura de proveedor (foto o PDF) con Claude y devuelve sus datos para cargarla como costo.
// No guarda nada: la app muestra el formulario completo para revisarlo antes de guardar.
//   POST /api/extraer-factura  { archivo: base64, tipo: "image/jpeg" | "application/pdf" | ..., obras: [{id, nombre, cliente}] }
import Anthropic from "@anthropic-ai/sdk";
import { verificarSesion, leerJson, exigirClave, httpError, responderError, hoyArgentina } from "./_auth.js";

// Vercel acepta hasta 4,5 MB por pedido; en base64 el archivo ocupa un tercio más
const MAX_BASE64 = 4_200_000;
const TIPOS = { "application/pdf": "document", "image/jpeg": "image", "image/png": "image", "image/webp": "image", "image/gif": "image" };
// Las mismas categorías de costo que usa la app
const CATEGORIAS = ["Materiales", "Mano de obra", "Subcontratos", "Combustible", "Fletes", "Herramientas", "Alquiler equipos", "Impuestos", "Otros"];

const T = { type: "string" };
const N = { type: "number" };
function esquema(idsObras) {
  return {
    type: "object",
    properties: {
      es_comprobante: { type: "boolean" },
      proveedor: T, cuit: T, tipo_comprobante: T, numero: T,
      fecha: T, vencimiento: T,
      neto: N, iva: N, total: N, moneda: { type: "string", enum: ["ARS", "USD", "EUR", "otra"] },
      concepto: T,
      categoria: { type: "string", enum: CATEGORIAS },
      obra_id: { type: "string", enum: ["", ...idsObras] },
      confianza: { type: "string", enum: ["alta", "media", "baja"] },
      observaciones: T,
    },
    required: ["es_comprobante", "proveedor", "cuit", "tipo_comprobante", "numero", "fecha", "vencimiento", "neto", "iva", "total", "moneda",
      "concepto", "categoria", "obra_id", "confianza", "observaciones"],
    additionalProperties: false,
  };
}

const INSTRUCCIONES = `Sos el asistente administrativo de Grupo AIXA, una empresa argentina que ejecuta obras. Te paso la foto o el PDF de un comprobante de un proveedor (factura, ticket, remito valorizado o recibo) y tenés que extraer sus datos para cargarlo como costo.

Reglas:
- Usá solo lo que se lee en el comprobante. No inventes datos: si algo no está o no se lee, dejá el texto vacío ("") o el número en 0.
- "fecha" y "vencimiento": formato AAAA-MM-DD. Las fechas argentinas vienen como día/mes/año.
- "total": el importe total a pagar. "neto" e "iva": si están discriminados (factura A); si no, neto = total e iva = 0.
- Montos como números, sin separadores de miles (12345.67).
- "tipo_comprobante": por ejemplo "Factura A", "Factura B", "Factura C", "Ticket", "Remito", "Recibo".
- "concepto": descripción corta de lo que se compró (ej. "Hierro del 8 y malla sima", "Alquiler de retroexcavadora").
- "categoria": la que mejor describa el gasto entre las permitidas.
- "obra_id": si el comprobante menciona una obra, dirección o cliente que coincida claramente con una de la lista, poné su id; si no, "".
- "confianza": alta si todo se lee bien; media si algún dato es dudoso; baja si la imagen es mala o no parece un comprobante.
- "es_comprobante": false si el archivo no es un comprobante de compra.
- "observaciones": lo que convenga revisar (datos dudosos, montos en otra moneda, etc.). Si no hay nada, "".`;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Método no permitido" }); }
    await verificarSesion(req);
    exigirClave();
    const { archivo, tipo, obras } = await leerJson(req);
    if (typeof archivo !== "string" || !archivo) throw httpError(400, "Falta el archivo.");
    if (archivo.length > MAX_BASE64) throw httpError(413, "El archivo es demasiado grande (máximo 3 MB). Probá con una foto más liviana.");
    if (!/^[A-Za-z0-9+/=]+$/.test(archivo)) throw httpError(400, "El archivo no se pudo leer.");
    const clase = TIPOS[tipo];
    if (!clase) throw httpError(400, "Formato no soportado. Usá una foto (JPG o PNG) o un PDF.");

    const lista = (Array.isArray(obras) ? obras : []).slice(0, 300)
      .filter(o => o && typeof o.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(o.id))
      .map(o => ({ id: o.id, nombre: String(o.nombre || "").slice(0, 120), cliente: String(o.cliente || "").slice(0, 120) }));

    const adjunto = clase === "document"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: archivo } }
      : { type: "image", source: { type: "base64", media_type: tipo, data: archivo } };

    const client = new Anthropic();
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: esquema(lista.map(o => o.id)) } },
      system: INSTRUCCIONES,
      messages: [{ role: "user", content: [
        adjunto,
        { type: "text", text: `Hoy es ${hoyArgentina()}.\nObras de la empresa (JSON):\n${JSON.stringify(lista)}\n\nExtraé los datos de este comprobante.` },
      ] }],
    });
    const respuesta = await stream.finalMessage();
    if (respuesta.stop_reason === "refusal") throw httpError(422, "Claude no pudo leer este comprobante.");
    if (respuesta.stop_reason === "max_tokens") throw httpError(422, "No se pudo terminar de leer el comprobante. Probá de nuevo.");
    const texto = respuesta.content.filter(b => b.type === "text").map(b => b.text).join("");
    let datos;
    try { datos = JSON.parse(texto); } catch { throw httpError(502, "La respuesta de Claude no tuvo el formato esperado. Probá de nuevo."); }
    res.status(200).json({ factura: datos });
  } catch (e) {
    responderError(res, e);
  }
}
