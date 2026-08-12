# Repositorio de QR (Wompi → Gmail)

`Code.gs` recibe el webhook de Wompi cuando una transacción se aprueba,
asigna un ticket numerado por tipo (`EOS-GEN-004`, `S16-VIP-002`, etc.),
lo guarda en una Google Sheet y envía el QR por Gmail al comprador.

Este archivo no contiene llaves ni secretos — todo vive en **Script
Properties** dentro del proyecto de Apps Script, nunca en el repo.

## Setup (una vez, o en un computador nuevo)

1. Entra a [script.google.com](https://script.google.com) con la cuenta
   `fantributeco@gmail.com` (Gmail siempre envía como la cuenta dueña del
   script).
2. Crea una Google Sheet nueva, ej. "Repositorio QR - Fan Tribute".
   Desde esa hoja: **Extensiones → Apps Script**, para que el proyecto
   quede vinculado a ella.
3. Pega el contenido de [`Code.gs`](./Code.gs) reemplazando lo que haya.
4. **Configuración del proyecto ⚙️ → Propiedades de secuencia de
   comandos** → agrega:
   - `WOMPI_EVENTS_SECRET` = secreto de eventos de Wompi (dashboard Wompi
     → Desarrolladores/API Keys → Eventos).
5. **Implementar → Nueva implementación → Aplicación web**:
   - Ejecutar como: **Yo** (fantributeco@gmail.com)
   - Quién tiene acceso: **Cualquier usuario**
   - Copia la URL que termina en `/exec`.
6. Verifica que responde: abre esa URL en el navegador, debe mostrar
   solo `OK`.
7. Dashboard Wompi → **Eventos/Webhooks** → pega esa URL `/exec`.

No hace falta agregar ningún "Servicio avanzado" en Apps Script — el
código solo usa clases integradas (`GmailApp`, `SpreadsheetApp`,
`UrlFetchApp`, `PropertiesService`, `Utilities`, `ContentService`).

## Mapa de links de pago → tipo de entrada

Definido en `LINK_MAP` dentro de `Code.gs`:

| Evento         | Tipo        | link_id  |
|----------------|-------------|----------|
| End of Summer  | Preventa 2  | 4VUCiA   |
| End of Summer  | General     | R2amMy   |
| End of Summer  | VIP         | eW6ari   |
| End of Summer  | Backstage   | Oophjg   |
| Summer 2016    | Preventa    | 1oKPkP   |
| Summer 2016    | General     | URc8lu   |
| Summer 2016    | VIP         | djWZHo   |

Si se crea un nuevo Payment Link en Wompi, hay que agregar su `link_id`
aquí para que el ticket quede bien clasificado.

## Página de confirmación dinámica (eventos/confirmacion.html)

Al terminar el pago, Wompi redirige al comprador a la "URL de
redirección" configurada en cada Payment Link, agregando
`?id=<transaction_id>` automáticamente. `confirmacion.html` lee ese
`id`, le pregunta a `doGet` de este mismo script si ya se generó el
ticket (`GET /exec?id=<transaction_id>`) y, si lo encuentra, muestra el
**mismo** nombre, tipo de entrada y código QR que se envió por Gmail —
un solo código válido por compra, no uno distinto en pantalla.

Si la respuesta aún no está lista (el webhook puede tardar unos
segundos más que la redirección), reintenta cada 2s hasta 10 veces; si
sigue sin encontrarla, cae de vuelta al mensaje genérico de "revisa tu
correo" que ya existía.

**Falta configurar en Wompi:** en cada Payment Link (dashboard Wompi →
editar el link) hay un campo de **URL de redirección** — apúntalo a
`https://<tu-dominio>/eventos/confirmacion.html`. Sin este paso, la
página siempre cae al mensaje genérico porque no recibe el `id`.

Si cambias la URL del despliegue de Apps Script (nueva implementación
con otra URL `/exec`), hay que actualizar la constante
`APPS_SCRIPT_URL` dentro del `<script>` al final de
`eventos/confirmacion.html`.

## Validar (sandbox, recomendado — no gasta dinero real)

1. En Wompi, activa modo **Sandbox/Pruebas** (llaves `pub_test_...` /
   `prv_test_...` / `test_events_...`, distintas a las de producción).
2. Crea un Payment Link de prueba con cualquier precio bajo.
3. Agrega temporalmente su `link_id` a `LINK_MAP` (cualquier tipo) y
   cambia `WOMPI_EVENTS_SECRET` en Script Properties al secreto de
   eventos de **test** mientras pruebas.
4. Paga con una [tarjeta de prueba de
   Wompi](https://docs.wompi.co/docs/colombia/pruebas/).
5. Revisa el resultado:
   - Apps Script → panel izquierdo, ícono de reloj **"Ejecuciones"**:
     ahí se ve cada llamada a `doPost`, errores y los `Logger.log`.
   - Dashboard Wompi → sección **Eventos/Webhooks**: confirma que la
     entrega devolvió `200`.
   - La Sheet debe tener una fila nueva.
   - El correo con el QR debe llegar a la casilla usada como
     `customer_email` en la compra de prueba.
6. Cuando todo funcione, quita el link de prueba de `LINK_MAP` y vuelve
   a poner `WOMPI_EVENTS_SECRET` de producción.

## Notas

- Idempotencia: si Wompi reintenta el mismo webhook, el script detecta
  el `transaction.id` ya guardado en la Sheet y no reenvía el correo.
- Límite de envío: `GmailApp` respeta el cupo diario de la cuenta Gmail
  gratuita (~100 destinatarios/día). Si el volumen de ventas crece
  mucho en un solo día, considerar Google Workspace o un proveedor SMTP
  dedicado.
