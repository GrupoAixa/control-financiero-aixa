// Funciones compartidas por las funciones de servidor de /api.
// Los archivos que empiezan con "_" no se publican como rutas en Vercel.
import Anthropic from "@anthropic-ai/sdk";

const FIREBASE_API_KEY = (process.env.FIREBASE_API_KEY || "").trim();
const EMAILS_AUTORIZADOS = (process.env.EMAILS_AUTORIZADOS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// Valida el token de sesión de Firebase con la API de Identity Toolkit (no hace falta cuenta de servicio)
// y que el email esté en EMAILS_AUTORIZADOS. Devuelve el usuario de Firebase.
export async function verificarSesion(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) throw httpError(401, "Falta iniciar sesión.");
  if (!FIREBASE_API_KEY) throw httpError(500, "Falta configurar FIREBASE_API_KEY en Vercel.");
  if (!EMAILS_AUTORIZADOS.length) throw httpError(500, "Falta configurar EMAILS_AUTORIZADOS en Vercel.");
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_API_KEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }),
  });
  const d = await r.json().catch(() => ({}));
  const u = d.users?.[0];
  if (!r.ok || !u?.email) throw httpError(401, "Sesión inválida o vencida. Volvé a iniciar sesión.");
  if (u.disabled) throw httpError(403, "Tu cuenta está deshabilitada.");
  if (!EMAILS_AUTORIZADOS.includes(u.email.toLowerCase())) throw httpError(403, "Tu cuenta no tiene permiso para usar la IA.");
  return u;
}

export async function leerJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const partes = [];
  for await (const c of req) partes.push(c);
  return JSON.parse(Buffer.concat(partes).toString("utf8") || "{}");
}

export function exigirClave() {
  if (!process.env.ANTHROPIC_API_KEY) throw httpError(500, "Falta configurar ANTHROPIC_API_KEY en Vercel.");
}

export function hoyArgentina() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
}

// Traduce los errores a un mensaje claro para la pantalla
export function responderError(res, e) {
  if (e instanceof Anthropic.APIError) {
    console.error("Anthropic API error", e.status, e.message);
    const msg = e.status === 401 ? "La clave de Anthropic es inválida."
      : e.status === 429 ? "Claude está saturado o se agotó el crédito. Probá en un rato."
      : e.status === 400 ? `Claude rechazó el pedido: ${e.message}`
      : "Error al consultar a Claude. Probá de nuevo.";
    return res.status(502).json({ error: msg });
  }
  const status = e.status || 500;
  if (status >= 500) console.error(e);
  res.status(status).json({ error: e.message || "Error interno" });
}
