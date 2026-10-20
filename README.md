# Control financiero AIXA — puesta en marcha

Es **un solo archivo**: `docs/index.html`. No hay que compilar nada ni usar Vercel.

Ya está publicado en:

**https://grupoaixa.github.io/control-financiero-aixa/**

En el celular, abrí esa dirección y usá "Agregar a pantalla de inicio". Queda como una app.

---

## 1. Cómo actualizarlo

1. Editá `docs/index.html` (o reemplazalo por una versión nueva).
2. Subí el cambio a la rama `main` (commit + push).
3. En 1–2 minutos el sitio publicado se actualiza solo — GitHub Pages sirve el contenido de la carpeta `/docs`.

No hace falta tocar nada en **Settings → Pages**: ya quedó configurado con *Source* = rama `main`, carpeta `/docs`.

---

## 2. Ingreso y nube (obligatorio)

La app **pide email y contraseña siempre** y no muestra nada hasta que se inicia sesión. Los datos viven en la nube de Firebase: se ven iguales desde la compu, el celular y la tablet, y quedan respaldados aunque se rompa el equipo. Hace falta conexión a internet para trabajar.

Usamos **Firebase** (de Google). El plan gratuito alcanza de sobra para esto.

> **Importante para el uso entre varios:** todos comparten el mismo proyecto de Firebase y el mismo **código de empresa**, pero cada uno entra con su email y contraseña. Los cambios se ven en vivo: si uno carga un costo, a los otros les aparece solo, sin recargar.

### Crear el proyecto

1. Entrá a <https://console.firebase.google.com> y **Agregar proyecto**. Poné el nombre que quieras y desactivá Google Analytics (no hace falta).
2. Dentro del proyecto, ícono **`</>`** (Web) para registrar una app. Ponele un apodo y **Registrar app**.
3. Firebase te muestra un bloque `firebaseConfig`. De ahí copiá tres valores:
   - `apiKey`
   - `projectId`
   - `appId`
4. En el menú **Compilación → Authentication → Comenzar**, habilitá el proveedor **Correo electrónico/contraseña**. Después:
   - En **Authentication → Users → Agregar usuario**, creá una cuenta por cada persona (email y una contraseña inicial). La app **no** crea cuentas: solo inicia sesión.
   - En **Authentication → Settings → Acciones del usuario**, destildá **Habilitar creación (registro)**. Así nadie puede registrarse por su cuenta, aunque consiga la API key.
   - Cada usuario puede cambiar su contraseña desde la app con el botón **Olvidé mi contraseña** (le llega un mail).
5. En **Compilación → Firestore Database → Crear base de datos**, elegí modo producción y la región `southamerica-east1` (São Paulo, la más cercana).
6. En Firestore, pestaña **Reglas**, pegá esto y publicá:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function autorizado() {
      return request.auth != null
        && request.auth.token.email in [
             'vos@tuempresa.com',
             'socio@tuempresa.com',
             'administracion@tuempresa.com'
           ];
    }
    match /empresas/{empresa} {
      allow read: if autorizado();
      // Solo se aceptan documentos con la forma que guarda la app
      allow create, update: if autorizado()
        && request.resource.data.payload is string
        && request.resource.data.updatedAt is number;
      allow delete: if false;
    }
  }
}
```

Cambiá esos tres mails por los reales (en minúsculas, tal como figuran en **Authentication → Users**). La regla también impide borrar el documento de la empresa desde afuera de la consola. **Solo esas direcciones pueden leer o escribir los datos**, aunque el repositorio de GitHub sea público y cualquiera vea el código. Si mañana entra alguien más al equipo, agregás su mail a esa lista y publicás de nuevo las reglas; si alguien se va, lo sacás y pierde el acceso al instante.

7. En **Authentication → Settings → Dominios autorizados**, agregá `grupoaixa.github.io`.

### Conectar la app

La primera vez que se abre el sitio en un equipo, la pantalla de ingreso pide también los datos de conexión:

1. Pegá `apiKey`, `projectId` y `appId`.
2. En **Código de empresa** dejá `principal` (o el que quieras, pero **todos tienen que escribir exactamente el mismo**).
3. Poné tu email y la contraseña de la cuenta que se creó en Firebase (paso 4 de arriba) y tocá **Entrar**.

Desde la segunda vez en ese equipo solo se piden email y contraseña. Para corregir los datos de conexión, en la pantalla de ingreso está **Cambiar conexión**.

> Para que nadie tenga que cargar los datos de conexión, se pueden escribir una sola vez en `docs/index.html`, en el bloque `const CONEXION = {...}`. No son secretos (Firebase los muestra en cualquier app web); lo que protege los datos son las cuentas y las reglas de Firestore.

**Sesión:** queda abierta en el equipo hasta que se toca **Salir** (abajo en el menú) o **Cerrar sesión** (en Ajustes). Al cerrar sesión se borran los datos de ese equipo: quedan solo en la nube. Si se olvida la contraseña, en la pantalla de ingreso está **Olvidé mi contraseña**.

**Al entrar, manda la nube:** si el equipo tenía datos viejos de antes (por ejemplo, cargados antes de usar la nube), se reemplazan por los de la nube y antes se descarga un respaldo de esos datos viejos (archivo terminado en `-previo-al-ingreso.json`). Si la nube está vacía, se suben los datos del equipo.

**Cómo se resuelven los choques:** cada cambio viaja al instante y les aparece a los demás sin recargar. Si dos personas editan exactamente al mismo tiempo, queda la versión que se guardó último. Los botones **Subir ahora** y **Bajar de la nube** de Ajustes fuerzan la dirección si hace falta.

---

## 3. Respaldos

Aun con la nube activada, conviene bajar de vez en cuando el respaldo `.json` desde **Ajustes y datos → Descargar respaldo** y guardarlo en Drive. Es el archivo que te permite restaurar todo en cualquier momento.

Al **restaurar** un respaldo o **borrar todos los datos**, la app descarga primero, automáticamente, un respaldo de lo que había (archivo terminado en `-previo-a-restaurar.json` o `-previo-a-borrar.json`). Ojo: con la nube conectada, esos cambios se aplican también para los demás usuarios.

La nube guarda todo en un único documento, que Firebase limita a 1 MB. La app avisa cuando los datos pasan los 800 KB; si se llega al límite, conviene archivar las obras viejas en un respaldo y sacarlas del sistema.

En una computadora compartida, al terminar usá **Cerrar sesión** y, si no la vas a volver a usar, **Desvincular este equipo**.

También podés exportar a CSV para abrir los movimientos en Excel.

---

## 4. Cómo está pensado el sistema

- **Obra**: la unidad de análisis. Tiene presupuesto, fechas (aceptación / entrega prevista / entrega real), sus ingresos y sus costos.
- **Ingresos**: cada cobro con su fecha real. De acá salen el plazo de cobro, el VAN y la TIR.
- **Costos**: cada gasto con fecha de factura y fecha de pago. La diferencia entre ambas es el plazo de pago a proveedores.
- **Vehículos**: cargas de combustible (con odómetro) y gastos de mantenimiento. Si imputás una carga a una obra, el gasto se suma también a esa obra.
- **Gastos fijos**: todo lo que se paga aunque no haya obra. Se lleva a valor mensual para saber cuánto cuesta abrir la persiana.
- **Presupuesto vs real**: dentro de cada obra, cuánto pensabas gastar por rubro contra lo que gastaste. Es donde aparece de dónde se escapó el margen.
- **Proyección de caja**: 90 días hacia adelante, semana por semana. Toma los saldos por cobrar de las obras, los costos impagos, los gastos fijos de cada mes y lo que cargues a mano, y te avisa en qué semana te quedás corto.
- **Salud financiera**: consolida todo y calcula el punto de equilibrio, el ciclo de caja y el capital de trabajo necesario.

### Sobre los pesos nominales

Como cargás todo en pesos nominales, tené presente que comparar una obra de hace un año contra una de ahora no es comparación directa: los números viejos valen menos de lo que aparentan. Dos recaudos prácticos: mirá siempre los porcentajes (rentabilidad, ROI, desvío por rubro) más que los montos absolutos cuando compares obras de distintas épocas, y actualizá la tasa de descuento de Ajustes cada tanto para que el VAN siga teniendo sentido.

### Sobre la tasa de descuento

En **Ajustes** cargás la tasa anual que le exigís a tu plata. Es la referencia del VAN y contra la que se compara la TIR. En un contexto inflacionario, si cargás pesos nominales, usá una tasa que incluya la inflación esperada (por ejemplo el rendimiento de un plazo fijo o el costo de tu descubierto). La alternativa más limpia es cargar todos los montos en dólares y usar una tasa real del 8–15 %.
