// Informe de situación financiera hecho con Claude, a partir de los indicadores que calcula la app.
//   POST /api/informe-financiero  { datos, foco? }  ->  { informe, generado }
// La clave de Anthropic vive solo acá (variable de entorno en Vercel); el navegador nunca la ve.
// Solo responde a usuarios con sesión de Firebase válida y email en EMAILS_AUTORIZADOS.
import Anthropic from "@anthropic-ai/sdk";
import { verificarSesion, leerJson, exigirClave, httpError, responderError } from "./_auth.js";

const MAX_DATOS = 600_000; // caracteres de JSON; un informe normal usa una fracción de esto

const TEXTO = { type: "string" };
const LISTA = { type: "array", items: TEXTO };
const objetos = (props, enums = {}) => ({
  type: "array",
  items: {
    type: "object",
    properties: Object.fromEntries(props.map(p => [p, enums[p] ? { type: "string", enum: enums[p] } : TEXTO])),
    required: props, additionalProperties: false,
  },
});
const SCHEMA = {
  type: "object",
  properties: {
    titulo: TEXTO,
    semaforo: { type: "string", enum: ["verde", "amarillo", "rojo", "gris"] },
    resumen_ejecutivo: TEXTO,
    indicadores: objetos(["nombre", "valor", "lectura", "estado"], { estado: ["bien", "atencion", "mal", "sin_datos"] }),
    rentabilidad: TEXTO,
    obras: objetos(["obra", "situacion", "comentario"], { situacion: ["bien", "atencion", "mal", "sin_datos"] }),
    liquidez_y_caja: TEXTO,
    estructura_y_costos: TEXTO,
    riesgos: LISTA,
    oportunidades: LISTA,
    recomendaciones: objetos(["accion", "por_que", "prioridad"], { prioridad: ["alta", "media", "baja"] }),
    datos_faltantes: LISTA,
  },
  required: ["titulo", "semaforo", "resumen_ejecutivo", "indicadores", "rentabilidad", "obras", "liquidez_y_caja",
    "estructura_y_costos", "riesgos", "oportunidades", "recomendaciones", "datos_faltantes"],
  additionalProperties: false,
};

const INSTRUCCIONES = `Sos el analista financiero de Grupo AIXA, una empresa que ejecuta obras. Escribís informes de gestión para los dueños y gerentes: gente que decide, no contadores. Te paso en JSON lo que calcula el sistema "Control financiero AIXA" y tenés que escribir un informe detallado de la situación financiera de la empresa.

Qué hay en los datos:
- "empresa": tasa de descuento anual exigida, margen neto objetivo, saldo de caja cargado y, si el usuario lo informó, la inflación del período.
- "consolidado": ingresos cobrados, costos directos, gastos fijos de estructura del período, margen bruto, resultado operativo, VAN y TIR consolidados (con la estructura incluida), capital de trabajo requerido (peor momento de la caja acumulada).
- "economicos": punto de equilibrio mensual (facturación necesaria para cubrir la estructura), facturación mensual promedio, margen de seguridad, coeficiente de variabilidad (costos directos por cada peso facturado) y margen de contribución.
- "financieros": plazo medio de cobro (desde la aceptación de la obra y desde la entrega), plazo medio de pago a proveedores (desde la factura), ciclo de caja (cobro − pago), cobertura de costos (ingresos ÷ costos directos), costos impagos.
- "mensual": ingresos y costos por mes, para ver tendencias.
- "obras": una por obra con presupuesto, cobrado, costo, margen, rentabilidad sobre venta, ROI, meta de ROI, VAN, TIR, desvíos de plazo y de facturación, adelanto, saldos por cobrar y por pagar, y presupuesto vs real por rubro.
- "estructura": gastos fijos mensualizados por categoría.
- "vehiculos": gasto total, costo por km y consumo de cada vehículo.
- "caja_proyectada": proyección a 90 días por semana (cobros esperados, pagos, saldo acumulado) y la primera semana en rojo si la hay.

Marco de análisis (contabilidad gerencial):
- Lectura económica: margen sobre ventas (dos dígitos es sano), punto de equilibrio y margen de seguridad. Margen de seguridad negativo = problema de ventas (no se cubre la estructura); si el margen de seguridad está bien pero el resultado no, el problema es de costos. Coeficiente de variabilidad alto = poco margen de contribución por cada peso vendido.
- Lectura financiera: plazo de cobro vs plazo de pago. Si se cobra más tarde de lo que se paga, la empresa financia el ciclo con capital propio; si es al revés, la financian clientes (adelantos) y proveedores. Es más fácil acortar el plazo de cobro (adelantos, certificaciones más frecuentes) que estirar el de pago.
- Rentabilidad vs costo de oportunidad: compará TIR y rentabilidad con la tasa exigida. Si hay inflación informada, compará rentabilidad con inflación (rentabilidad ÷ inflación: más de 3 muy bueno, 2 bueno, 1 regular, menos de 1 malo).
- Los montos están en pesos nominales: con inflación, comparar montos de meses lejanos distorsiona; preferí porcentajes y tendencias.
- No hay balance (activos, pasivos, patrimonio neto, deudas financieras ni stock): no inventes indicadores que los requieran (RPN, ROA, endeudamiento, liquidez corriente). Si hacen falta para una conclusión, mencionalo en "datos_faltantes".

Reglas:
- Usá solo los datos que te paso. No inventes obras, montos, fechas ni porcentajes. Citá las cifras del JSON con su formato (pesos con separador de miles, porcentajes con un decimal).
- "indicadores": entre 6 y 10, los más relevantes para decidir, cada uno con su valor, una lectura de una frase y su estado.
- "obras": las que más pesan o preocupan (hasta 8), con una explicación concreta de por qué.
- "recomendaciones": acciones concretas y priorizadas que la dirección pueda ejecutar (ej. "pedir 40 % de adelanto en las obras nuevas"), cada una con el porqué basado en los datos.
- "semaforo": verde = rentable y con caja sana; amarillo = alguna alerta relevante; rojo = pérdidas, caja en rojo proyectada o problema serio; gris = datos insuficientes para opinar.
- Si el usuario pidió un foco, priorizalo en el resumen y las recomendaciones.
- Español rioplatense, claro y directo, sin relleno ni jerga innecesaria. Fechas en dd/mm/aaaa.`;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Método no permitido" }); }
    await verificarSesion(req);
    const { datos, foco } = await leerJson(req);
    if (!datos || typeof datos !== "object" || Array.isArray(datos)) throw httpError(400, "Faltan los datos para el informe.");
    const json = JSON.stringify(datos);
    if (json.length > MAX_DATOS) throw httpError(413, "Hay demasiados datos para un solo informe. Elegí un período más corto.");
    exigirClave();
    const pedido = typeof foco === "string" && foco.trim() ? `\n\nFoco pedido por el usuario: ${foco.trim().slice(0, 500)}` : "";

    const client = new Anthropic();
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      system: INSTRUCCIONES,
      messages: [{ role: "user", content: `Datos de la empresa (JSON):\n\n${json}${pedido}\n\nEscribí el informe de situación financiera.` }],
    });
    const respuesta = await stream.finalMessage();
    if (respuesta.stop_reason === "refusal") throw httpError(422, "Claude no pudo armar este informe. Probá de nuevo.");
    if (respuesta.stop_reason === "max_tokens") throw httpError(422, "El informe quedó demasiado largo. Probá con un período más corto.");
    const texto = respuesta.content.filter(b => b.type === "text").map(b => b.text).join("");
    let informe;
    try { informe = JSON.parse(texto); } catch { throw httpError(502, "La respuesta de Claude no tuvo el formato esperado. Probá de nuevo."); }

    const generado = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    res.status(200).json({ informe, generado });
  } catch (e) {
    responderError(res, e);
  }
}
