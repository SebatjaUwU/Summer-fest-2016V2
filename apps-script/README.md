# Repositorio de QR (Wompi → Gmail)

`Code.gs` revisa periódicamente la bandeja de Gmail buscando los correos
**"Transacción APROBADA"** que Wompi manda automáticamente por cada
venta (directos, o reenviados a mano desde otra cuenta como
sebatja1234@gmail.com), asigna un ticket numerado por tipo
(`EOS-GEN-004`, `S16-VIP-002`, etc.), lo guarda en una Google Sheet y
envía el QR por Gmail al comprador.

No usa webhook de Wompi — no hace falta configurar nada en el dashboard
de Wompi (ni "Eventos/Webhooks" ni un secreto). Todo se dispara desde un
**trigger de tiempo** que llama a `checkWompiSales` cada cierto número
de minutos.

## Setup (una vez, o en un computador nuevo)

1. Entra a [script.google.com](https://script.google.com) con la cuenta
   `fantributeco@gmail.com` (Gmail siempre envía/lee como la cuenta
   dueña del script).
2. Crea una Google Sheet nueva, ej. "Repositorio QR - Fan Tribute".
   Desde esa hoja: **Extensiones → Apps Script**, para que el proyecto
   quede vinculado a ella.
3. Pega el contenido de [`Code.gs`](./Code.gs) reemplazando lo que haya.
4. Icono de reloj **"Activadores"** (Triggers) en el panel izquierdo →
   **Añadir activador**:
   - Función a ejecutar: `checkWompiSales`
   - Origen del evento: **Basado en tiempo**
   - Tipo de activador: **Temporizador por minutos**
   - Cada **5 minutos** (o el intervalo que prefieras — entre más corto,
     más rápido llega el QR, pero gasta más cuota de ejecuciones).
5. (Para `confirmacion.html` y `escanear.html`, que llaman al script
   desde el navegador) **Implementar → Nueva implementación →
   Aplicación web**:
   - Ejecutar como: **Yo** (fantributeco@gmail.com)
   - Quién tiene acceso: **Cualquier usuario**
   - Copia la URL que termina en `/exec` y pégala en `APPS_SCRIPT_URL`
     dentro de `eventos/confirmacion.html` **y** `eventos/escanear.html`
     (debe ser la misma URL en los dos archivos).

**Importante — cada vez que cambies `Code.gs`:** guardar (`Ctrl+S`) no
actualiza la URL `/exec` ya publicada. Para que `confirmacion.html` y
`escanear.html` usen el código nuevo, tienes que **Implementar →
Administrar implementaciones → ícono de lápiz en la implementación
activa → Versión: Nueva versión → Implementar**. Si no haces esto, el
navegador sigue hablando con el código viejo aunque en el editor ya
esté actualizado — es la causa más común de "no me funciona" después
de pegar un `Code.gs` nuevo.

No hace falta agregar ningún "Servicio avanzado" en Apps Script — el
código solo usa clases integradas (`GmailApp`, `SpreadsheetApp`,
`UrlFetchApp`, `ContentService`, `Session`, `SlidesApp`, `DriveApp`,
`ScriptApp`). Como ahora usa `SlidesApp`/`DriveApp` (para generar el
PNG del ticket, ver más abajo), la primera vez que corras
`checkWompiSales` te va a pedir autorizar permisos nuevos — es normal,
dale "Permitir" igual que la primera vez.

## Cómo detecta la venta

Wompi manda un correo con asunto como:

```
Transacción APROBADA en Fantributecol - ref. URc8lu_1786120306_HdIE5sB4K
```

El identificador del Payment Link va al inicio de la referencia
(`URc8lu` en el ejemplo). `checkWompiSales` busca esos correos sin
procesar, saca el `link_id` de ahí, y del cuerpo del correo saca:
nombre del comprador, correo, teléfono, monto y número de transacción.

## Mapa de links de pago → tipo de entrada

Definido en `LINK_MAP` dentro de `Code.gs`:

| Evento         | Tipo                | link_id  | cantidad |
|----------------|---------------------|----------|----------|
| End of Summer  | Preventa 2          | YZhBL1   | 1        |
| End of Summer  | General             | w69y3w   | 1        |
| End of Summer  | VIP                 | eW6ari   | 1        |
| End of Summer  | Backstage           | Oophjg   | 1        |
| End of Summer  | Preventa 2 (combo)  | J4Mtm3   | 2        |
| End of Summer  | Preventa 2 (combo)  | 3ZjQTK   | 3        |
| End of Summer  | General (combo)     | 1nkW4O   | 2        |
| End of Summer  | General (combo)     | H9xF4f   | 3        |
| Summer 2016    | Preventa            | 1oKPkP   | 1        |
| Summer 2016    | General             | URc8lu   | 1        |
| Summer 2016    | VIP                 | djWZHo   | 1        |

Si se crea un nuevo Payment Link en Wompi, hay que agregar su `link_id`
aquí para que el ticket quede bien clasificado.

## El ticket llega también como imagen PNG adjunta

Además del QR embebido en el cuerpo del correo, cada ticket se manda
como una **imagen PNG adjunta** con la tarjeta completa (nombre,
insignia, QR, código, fecha y venue) — así el comprador puede
guardarla o reenviarla suelta (ej. por WhatsApp) sin depender de cómo
se vea el correo en su cliente de email.

`generateTicketPng_` arma la tarjeta usando Google Slides como lienzo
(crea una presentación temporal, dibuja el diseño, la exporta como PNG,
y borra la presentación), porque Apps Script no tiene un generador de
imágenes propio. `SlidesApp` no permite fijar un tamaño de página
personalizado (no hay `setPageSize`), así que el diseño usa el tamaño
horizontal por defecto de una diapositiva nueva — por eso el ticket
queda en formato horizontal (QR a la izquierda, datos a la derecha),
no vertical como una boleta de celular. Si por algún motivo falla la
generación del PNG (ej. un límite de cuota), el correo se manda igual
con el QR en el HTML — solo faltaría el adjunto, no se pierde el
ticket. Revisa "Ejecuciones" si ves ese caso.

**Cuota:** cada ticket generado crea y borra un archivo de Slides en tu
Drive — queda en la papelera (Drive la vacía sola con el tiempo). No
debería ser un problema salvo que vendas cientos de tickets en un
mismo día.

## Combos: varios tickets/QR en una sola compra

`J4Mtm3`/`3ZjQTK` son los combos de 2 y 3 boletas de Preventa 2, e
`1nkW4O`/`H9xF4f` son lo mismo para General. Como son **una sola
transacción de Wompi** por varias boletas, `LINK_MAP` les puso
`cantidad: 2` / `cantidad: 3` — el script genera esa cantidad de
tickets (mismo prefijo `EOS-PV2`/`EOS-GEN`, se mezclan en la misma
numeración que las boletas individuales), una fila por ticket en la
Sheet, y
**un solo correo con varios códigos QR adentro** (uno por persona). El
monto que trae el correo de Wompi es el total del combo — se reparte
entre los tickets generados para que la columna "Monto COP" siga
representando el valor de cada ticket individual.

## Escanear entradas en la puerta (eventos/escanear.html)

Página para el staff de la entrada: abre la cámara del celular, lee el
QR de cada ticket, y le pregunta a `doPost` del script si es válido.

- **Primera vez que se escanea un código** → lo marca `Escaneado = true`
  con la fecha/hora en la Sheet, y muestra en verde el nombre y tipo de
  entrada.
- **Ya estaba escaneado** → lo avisa en naranja con la hora del primer
  ingreso (para detectar a alguien tratando de reusar el mismo QR).
- **Código que no existe** → lo avisa en rojo.

**PIN de staff (opcional pero recomendado):** sin PIN, cualquiera que
tenga el link de `escanear.html` podría marcar tickets como usados
antes de que lleguen los compradores reales. Para evitarlo, en Apps
Script → **Configuración del proyecto ⚙️ → Propiedades de secuencia de
comandos** agrega:
  - `STAFF_PIN` = el PIN que le vas a dar al staff de la puerta.

Si no configuras `STAFF_PIN`, la página funciona igual pero sin pedir
PIN (útil para probar). Recuerda: como `doPost` es nuevo, después de
pegar el `Code.gs` actualizado hay que **redesplegar** (ver la nota de
arriba) para que `escanear.html` deje de fallar.

## Solo estos tipos se procesan automáticamente

`AUTO_LINK_IDS` (al inicio de `Code.gs`) limita el flujo automático a
`YZhBL1`, `w69y3w`, `J4Mtm3`, `3ZjQTK`, `eW6ari`, `Oophjg`, `1nkW4O` y
`H9xF4f` — o sea, **todo End of Summer** (Preventa 2, General, VIP,
Backstage, y los combos x2/x3 de Preventa 2 y de General). Cada tipo
manda su QR con un color de acento distinto (`accentColorForTipo_` en
`Code.gs`): verde para Preventa/General, dorado para VIP, cyan para
Backstage.

Los links de **Summer 2016** (`1oKPkP`, `URc8lu`, `djWZHo`) siguen
fuera del flujo automático — quedan etiquetados `QR-Manual` en Gmail.
Si más adelante también los quieres automatizar, agrega su `link_id` a
`AUTO_LINK_IDS`.

## Si una venta no se pudo procesar sola

Si el correo no tiene el formato esperado (referencia rara, comprador
sin correo visible, o `link_id` que no está en `LINK_MAP`), el script
**no adivina** — te manda un correo a ti mismo avisando el motivo, y le
pone al hilo la etiqueta de Gmail `QR-Revisar` para que no lo vuelva a
intentar solo. Revísalo a mano y agrega la fila en la Sheet si
corresponde.

Los correos que sí se procesaron bien quedan etiquetados `QR-Procesado`
en Gmail — así el trigger no los vuelve a leer en la siguiente pasada.

## Correos de ventas viejas (antes de activar esto)

`checkWompiSales` **ignora cualquier correo de Wompi anterior a la fecha
`IGNORE_BEFORE`** (definida al inicio de `Code.gs`) — los etiqueta
`QR-Anterior` y no los toca. Así, al activar el sistema, no reprocesa de
golpe todas las ventas viejas que ya estaban en la bandeja. Si algún día
necesitas que sí las procese, cambia esa fecha hacia atrás en el código.

## Página de confirmación dinámica (eventos/confirmacion.html)

Al terminar el pago, Wompi redirige al comprador a la "URL de
redirección" configurada en cada Payment Link, agregando
`?id=<transaction_id>` automáticamente (esto lo hace Wompi directo,
no depende del script). `confirmacion.html` lee ese `id` y le pregunta
a `doGet` de este mismo script si ya se generó el ticket.

**Importante:** como ahora el ticket se genera cuando el trigger de
Gmail procesa el correo (no al instante del pago como antes con el
webhook), es normal que `confirmacion.html` no lo encuentre a tiempo
dentro de sus reintentos (20 segundos) y caiga al mensaje genérico de
"revisa tu correo" — no es un error, el correo con el QR real igual
llega minutos después. Si quieres que la página dinámica funcione más
seguido, baja el intervalo del trigger a 1–2 minutos.

Si cambias la URL del despliegue de Apps Script (nueva implementación
con otra URL `/exec`), hay que actualizar la constante
`APPS_SCRIPT_URL` dentro del `<script>` al final de
`eventos/confirmacion.html`.

## Validar

1. Haz una compra real (o de prueba) por uno de los links de `LINK_MAP`.
2. Espera a que llegue el correo "Transacción APROBADA..." de Wompi a
   `fantributeco@gmail.com`.
3. En Apps Script, abre `checkWompiSales` y dale a **Ejecutar** manualmente
   (no hace falta esperar el trigger) — o espera al siguiente disparo
   automático.
4. Revisa:
   - Apps Script → ícono de reloj **"Ejecuciones"**: ahí se ve cada
     corrida, errores y los `Logger.log`.
   - La Sheet debe tener una fila nueva.
   - El correo con el QR debe llegar a la casilla del comprador.
   - Si algo falló, debe haberte llegado un correo de "Revisar venta no
     procesada" con el motivo.

## Notas

- Idempotencia: si el mismo correo se vuelve a escanear (no debería,
  por la etiqueta `QR-Procesado`), el script detecta la transacción ya
  guardada en la Sheet y no reenvía el correo.
- El parseo del cuerpo del correo depende del formato actual de la
  plantilla de Wompi. Si Wompi cambia el diseño de ese correo en el
  futuro, `extractTableValue_`/`extractAfterPhrase_` en `Code.gs`
  podrían necesitar ajuste — si empiezan a llegar avisos de "Revisar
  venta no procesada" de golpe, es la primera señal de que esto pasó.
- Límite de envío: `GmailApp` respeta el cupo diario de la cuenta Gmail
  gratuita (~100 destinatarios/día). Si el volumen de ventas crece
  mucho en un solo día, considerar Google Workspace o un proveedor SMTP
  dedicado.
