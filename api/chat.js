// Asistente: responde preguntas en lenguaje natural sobre los datos de la empresa.
//   POST /api/chat  { datos: string (JSON), mensajes: [{role: "user"|"assistant", content: string}] }
// La respuesta se transmite como texto a medida que Claude la escribe.
// Los datos van en un bloque del sistema con caché: en una misma conversación,
// las preguntas siguientes reutilizan ese bloque y cuestan mucho menos.
import Anthropic from "@anthropic-ai/sdk";
import { verificarSesion, leerJson, exigirClave, httpError, responderError, hoyArgentina } from "./_auth.js";

const MAX_DATOS = 1_500_000;     // caracteres del JSON de datos
const MAX_MENSAJES = 40;         // turnos de la conversación que se aceptan
const MAX_PREGUNTA = 4000;       // caracteres por mensaje

const INSTRUCCIONES = `Sos el asistente financiero de Grupo AIXA, una empresa que ejecuta obras. Respondés preguntas de los dueños y gerentes sobre los datos del sistema "Control financiero AIXA", que te paso en JSON.

Qué hay en los datos:
- "resumen": los indicadores que ya calcula el sistema (consolidado, punto de equilibrio, plazos, caja proyectada, obras con su rentabilidad, estructura, vehículos).
- "movimientos": el detalle de cada registro: ingresos (cobros), costos (con categoría, proveedor, fecha de factura, si está pagado y cuándo), gastos fijos, gastos y cargas de combustible de vehículos, y movimientos previstos. Cada movimiento indica su obra o vehículo.

Cómo responder:
- Usá solo estos datos. Si algo no está cargado, decilo y explicá qué haría falta cargar. No inventes cifras.
- Cuando tengas que sumar, filtrar o comparar, hacelo con cuidado sobre los movimientos y mostrá el resultado con el criterio usado (por ejemplo, "por fecha de factura" o "por fecha de cobro").
- Montos en pesos con separador de miles ($ 1.234.567), porcentajes con un decimal, fechas dd/mm/aaaa.
- Respuestas cortas y directas: primero la respuesta, después el detalle si hace falta. Podés usar listas con "- " y negritas con **texto**. Para comparar varias cosas podés usar una tabla en formato markdown.
- Si la pregunta es de análisis o de decisión, da tu lectura y una recomendación concreta, con el marco de la contabilidad gerencial (margen, punto de equilibrio, margen de seguridad, ciclo de caja).
- Español rioplatense, claro y sin relleno.`;

function validarMensajes(m) {
  if (!Array.isArray(m) || !m.length) throw httpError(400, "Falta la pregunta.");
  if (m.length > MAX_MENSAJES) throw httpError(400, "La conversación es muy larga. Empezá una nueva.");
  const limpios = m.map(x => ({ role: x?.role, content: typeof x?.content === "string" ? x.content.slice(0, MAX_PREGUNTA) : "" }));
  limpios.forEach((x, i) => {
    if (!["user", "assistant"].includes(x.role) || !x.content.trim()) throw httpError(400, "La conversación no tiene un formato válido.");
    if ((i % 2 === 0) !== (x.role === "user")) throw httpError(400, "La conversación no tiene un formato válido.");
  });
  if (limpios[limpios.length - 1].role !== "user") throw httpError(400, "Falta la pregunta.");
  return limpios;
}

export default async function handler(req, res) {
  let enviando = false;
  try {
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Método no permitido" }); }
    await verificarSesion(req);
    exigirClave();
    const { datos, mensajes } = await leerJson(req);
    if (typeof datos !== "string" || !datos) throw httpError(400, "Faltan los datos de la empresa.");
    if (datos.length > MAX_DATOS) throw httpError(413, "Hay demasiados datos para el asistente.");
    const conversacion = validarMensajes(mensajes);

    const client = new Anthropic();
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [
        { type: "text", text: INSTRUCCIONES },
        // Mismo texto en toda la conversación: queda en caché y las preguntas siguientes lo leen a menor costo
        { type: "text", text: `Datos de la empresa (JSON):\n${datos}`, cache_control: { type: "ephemeral" } },
        { type: "text", text: `Hoy es ${hoyArgentina()}.` },
      ],
      messages: conversacion,
    });

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    enviando = true;
    stream.on("text", t => res.write(t));
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") res.write("\n\n_No puedo responder esa pregunta._");
    if (final.stop_reason === "max_tokens") res.write("\n\n_La respuesta quedó cortada por largo. Pedí un resumen más corto._");
    res.end();
  } catch (e) {
    if (!enviando) return responderError(res, e);
    // Si el error llega con la respuesta ya empezada, se avisa al final del texto
    console.error(e);
    res.write("\n\n_Se cortó la respuesta por un error. Probá de nuevo._");
    res.end();
  }
}
