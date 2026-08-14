/**
 * Repositorio de QR — revisa periódicamente la bandeja de Gmail buscando
 * los correos "Transacción APROBADA" que Wompi manda automáticamente,
 * genera un ticket numerado por tipo, lo guarda en esta Sheet y envía el
 * QR por Gmail al comprador.
 *
 * No usa webhook de Wompi (no hace falta configurar nada en el dashboard
 * de Wompi ni guardar WOMPI_EVENTS_SECRET). Todo se dispara desde un
 * trigger de tiempo que corre esta función:
 *
 *   checkWompiSales
 *
 * Configuración requerida (una sola vez):
 *   1. Extensiones > Apps Script > icono de reloj "Activadores" (Triggers)
 *      > Añadir activador:
 *        - Función a ejecutar: checkWompiSales
 *        - Origen del evento: Basado en tiempo
 *        - Tipo de activador: Temporizador por minutos
 *        - Cada 5 minutos (o el intervalo que prefieras)
 *   2. Nada más — no se necesitan Propiedades de secuencia de comandos.
 */

// payment_link_id (Wompi) -> { evento, tipo, prefijo, cantidad }
// "cantidad" = cuantos tickets/QR genera UNA transaccion de ese link.
// Si no se pone, se asume 1. Los combos generan varios tickets del mismo
// tipo base (misma numeracion que Preventa 2 individual) en una sola
// compra, y el correo trae un QR por cada uno.
const LINK_MAP = {
  '4VUCiA': { evento: 'End of Summer', tipo: 'Preventa 2', prefijo: 'EOS-PV2' },
  'R2amMy': { evento: 'End of Summer', tipo: 'General',    prefijo: 'EOS-GEN' },
  'eW6ari': { evento: 'End of Summer', tipo: 'VIP',        prefijo: 'EOS-VIP' },
  'Oophjg': { evento: 'End of Summer', tipo: 'Backstage',  prefijo: 'EOS-BKS' },
  '1oKPkP': { evento: 'Summer 2016',   tipo: 'Preventa',   prefijo: 'S16-PRE' },
  'URc8lu': { evento: 'Summer 2016',   tipo: 'General',    prefijo: 'S16-GEN' },
  'djWZHo': { evento: 'Summer 2016',   tipo: 'VIP',        prefijo: 'S16-VIP' },
  'DaFT0V': { evento: 'End of Summer', tipo: 'Preventa 2', prefijo: 'EOS-PV2', cantidad: 2 },
  'WgEtRz': { evento: 'End of Summer', tipo: 'Preventa 2', prefijo: 'EOS-PV2', cantidad: 3 },
};

const SHEET_NAME = 'Repositorio QR';
const HEADERS = [
  'Fecha', 'Evento', 'Tipo de entrada', 'Numero', 'Ticket ID',
  'Transaccion ID', 'Referencia', 'Nombre', 'Email', 'Telefono',
  'Monto COP', 'Estado', 'Email enviado', 'Escaneado', 'Fecha escaneo'
];

// Solo estos link_id se procesan automaticamente (Preventa 2, General,
// VIP, Backstage, y los combos x2/x3 de Preventa 2, todos de End of
// Summer). Si algun dia quieres sumar otro tipo al flujo automatico
// (ej. los de Summer 2016), agrega su link_id aqui.
const AUTO_LINK_IDS = ['4VUCiA', 'R2amMy', 'DaFT0V', 'WgEtRz', 'eW6ari', 'Oophjg'];

const LABEL_OK = 'QR-Procesado';
const LABEL_REVIEW = 'QR-Revisar';
const LABEL_OLD = 'QR-Anterior';
const LABEL_MANUAL = 'QR-Manual';
const GMAIL_SEARCH = 'from:(no-reply@wompi.co) "APROBADA" -label:' + LABEL_OK + ' -label:' + LABEL_REVIEW + ' -label:' + LABEL_OLD + ' -label:' + LABEL_MANUAL;

/**
 * Ignora cualquier correo de Wompi anterior a esta fecha/hora — asi no
 * reprocesa ventas viejas que ya estaban en la bandeja antes de activar
 * este sistema. Si alguna vez quieres reprocesar correos de antes,
 * cambia esta fecha hacia atras.
 */
const IGNORE_BEFORE = new Date('2026-08-12T00:00:00');

/**
 * Sin parametros: healthcheck ("OK").
 * Con ?id=<transaction_id de Wompi>: consulta si ya se genero el ticket
 * para esa transaccion, para que confirmacion.html muestre el mismo
 * nombre/codigo que se envio por Gmail. Se usa desde el navegador
 * (fetch), por eso responde solo GET y solo datos no sensibles.
 *
 * Nota: como ahora el ticket se genera cuando el trigger de Gmail
 * procesa el correo (no al instante del pago), confirmacion.html puede
 * no encontrarlo todavia dentro de sus reintentos y caer al mensaje
 * generico de "revisa tu correo" — eso es esperado, el correo con el QR
 * real igual llega poco despues.
 */
function doGet(e) {
  const id = e && e.parameter && e.parameter.id;
  if (!id) {
    return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
  }

  const sheet = getSheet_();
  const row = findRowByTransactionId_(sheet, id);
  if (!row) {
    return jsonResponse_({ found: false });
  }

  const values = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  return jsonResponse_({
    found: true,
    evento: values[1],
    tipo: values[2],
    numero: values[3],
    ticketId: values[4],
    nombre: values[7],
    estado: values[11]
  });
}

/**
 * Usado por eventos/escanear.html (el escaner de la entrada). Recibe
 * { action: 'scan', ticketId, pin } por POST y marca el ticket como
 * escaneado en la Sheet.
 *
 * Si STAFF_PIN esta configurado en Propiedades de secuencia de comandos,
 * hay que mandarlo igual — asi nadie que solo vea el codigo QR (ej. en
 * una foto) puede marcar tickets como usados sin estar en la puerta.
 * Si no esta configurado, no se exige PIN (mas simple para probar).
 */
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ ok: false, status: 'peticion_invalida' });
  }

  if (body.action !== 'scan') {
    return jsonResponse_({ ok: false, status: 'accion_desconocida' });
  }

  const staffPin = PropertiesService.getScriptProperties().getProperty('STAFF_PIN');
  if (staffPin && body.pin !== staffPin) {
    return jsonResponse_({ ok: false, status: 'pin_invalido' });
  }

  const ticketId = String(body.ticketId || '').trim();
  if (!ticketId) {
    return jsonResponse_({ ok: false, status: 'sin_codigo' });
  }

  const sheet = getSheet_();
  const row = findRowByTicketId_(sheet, ticketId);
  if (!row) {
    return jsonResponse_({ ok: true, status: 'no_encontrado', ticketId: ticketId });
  }

  const values = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  const yaEscaneado = values[13];

  if (yaEscaneado) {
    return jsonResponse_({
      ok: true, status: 'ya_escaneado',
      ticketId: ticketId, tipo: values[2], numero: values[3], nombre: values[7],
      fechaEscaneo: values[14] ? new Date(values[14]).toISOString() : ''
    });
  }

  sheet.getRange(row, 14).setValue(true);
  sheet.getRange(row, 15).setValue(new Date());

  return jsonResponse_({
    ok: true, status: 'valido',
    ticketId: ticketId, tipo: values[2], numero: values[3], nombre: values[7]
  });
}

/**
 * Punto de entrada del trigger de tiempo. Busca correos de Wompi sin
 * procesar, genera el ticket + fila en la Sheet + email con QR por cada
 * uno, y los marca con una etiqueta de Gmail para no repetirlos.
 */
function checkWompiSales() {
  const labelOk = getOrCreateLabel_(LABEL_OK);
  const labelReview = getOrCreateLabel_(LABEL_REVIEW);
  const labelOld = getOrCreateLabel_(LABEL_OLD);
  const labelManual = getOrCreateLabel_(LABEL_MANUAL);

  const threads = GmailApp.search(GMAIL_SEARCH, 0, 20);

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (message.getDate() < IGNORE_BEFORE) {
        thread.addLabel(labelOld);
        return;
      }
      try {
        processWompiMessage_(message, thread, labelOk, labelReview, labelManual);
      } catch (err) {
        Logger.log('Error procesando correo "' + message.getSubject() + '": ' + err);
        notifyReview_(message, String(err));
        thread.addLabel(labelReview);
      }
    });
  });
}

function processWompiMessage_(message, thread, labelOk, labelReview, labelManual) {
  const parsed = parseWompiEmail_(message);

  if (!parsed) {
    notifyReview_(message, 'No se encontro "ref." en el asunto — formato de correo inesperado.');
    thread.addLabel(labelReview);
    return;
  }

  const linkInfo = LINK_MAP[parsed.linkId];
  if (!linkInfo) {
    notifyReview_(message, 'El identificador de link "' + parsed.linkId + '" no esta en LINK_MAP.');
    thread.addLabel(labelReview);
    return;
  }

  if (AUTO_LINK_IDS.indexOf(parsed.linkId) === -1) {
    // Tipo fuera del flujo automatico (ej. los de Summer 2016): no es
    // un error, simplemente se coordina a mano. No se guarda en la
    // Sheet ni se manda correo.
    thread.addLabel(labelManual);
    return;
  }

  if (!parsed.email) {
    notifyReview_(message, 'No se pudo extraer el correo del comprador (referencia ' + parsed.referencia + ').');
    thread.addLabel(labelReview);
    return;
  }

  const sheet = getSheet_();
  const txKey = parsed.txId || parsed.referencia;

  if (findRowByTransactionId_(sheet, txKey)) {
    thread.addLabel(labelOk);
    return;
  }

  const nombre = parsed.nombre || 'Sin nombre';
  const cantidad = linkInfo.cantidad || 1;
  // El monto que trae el correo es el total de la transaccion (ej. el
  // combo completo) — se reparte entre los tickets generados para que la
  // columna "Monto COP" siga representando el valor de cada ticket.
  const montoPorTicket = Math.round((parsed.montoCOP || 0) / cantidad);

  const tickets = [];
  for (let i = 0; i < cantidad; i++) {
    const numero = getNextTicketNumber_(sheet, linkInfo.prefijo);
    const ticketId = linkInfo.prefijo + '-' + String(numero).padStart(3, '0');

    appendRow_(sheet, {
      evento: linkInfo.evento,
      tipo: linkInfo.tipo,
      numero: numero,
      ticketId: ticketId,
      txId: txKey,
      referencia: parsed.referencia,
      nombre: nombre,
      email: parsed.email,
      telefono: parsed.telefono,
      montoCOP: montoPorTicket,
      estado: 'APPROVED'
    });

    tickets.push({ numero: numero, ticketId: ticketId });
  }

  let enviado = false;
  try {
    sendTicketEmail_({
      email: parsed.email,
      nombre: nombre,
      evento: linkInfo.evento,
      tipo: linkInfo.tipo,
      tickets: tickets
    });
    enviado = true;
  } catch (mailErr) {
    Logger.log('Error enviando email: ' + mailErr);
  }
  setEmailSentFlag_(sheet, txKey, enviado);

  thread.addLabel(labelOk);
}

/**
 * Extrae del correo de Wompi: identificador de link (de la referencia
 * en el asunto), referencia completa, monto, nombre del comprador,
 * transaccion #, correo y telefono del comprador.
 *
 * El asunto trae "...ref. <link_id>_<timestamp>_<random>", ej.
 * "ref. URc8lu_1786120306_HdIE5sB4K" -> link_id = "URc8lu".
 */
function parseWompiEmail_(message) {
  const subject = message.getSubject() || '';
  const refMatch = subject.match(/ref\.\s*(\S+)/i);
  if (!refMatch) return null;

  const referencia = refMatch[1];
  const linkId = referencia.split('_')[0];
  const body = message.getPlainBody() || '';

  return {
    linkId: linkId,
    referencia: referencia,
    montoCOP: parseAmount_(body),
    nombre: extractTableValue_(body, 'Comprador'),
    txId: extractTableValue_(body, 'Transacción #') || extractTableValue_(body, 'Transaccion #'),
    email: extractBuyerEmail_(body),
    telefono: extractBuyerPhone_(body)
  };
}

/**
 * El cuerpo trae: "...escribiendo a <email> o llamando al <telefono>",
 * los dos en la misma linea/parrafo.
 */
function extractBuyerEmail_(body) {
  const m = body.match(/escribiendo a\s*([^\s@]+@[^\s]+?)\s+o llamando al/i);
  return m ? m[1].trim() : '';
}

function extractBuyerPhone_(body) {
  const m = body.match(/o llamando al\s*(\+?\d[\d ]*)/i);
  return m ? m[1].trim() : '';
}

function parseAmount_(body) {
  const m = body.match(/COP\s*\$\s*([\d.,]+)/);
  if (!m) return 0;
  return Math.round(parseFloat(m[1].replace(/\./g, '').replace(/,/g, '')));
}

/**
 * Busca "Label<tab/espacios>valor" en la misma linea; si no lo
 * encuentra, busca una linea que sea exactamente el label y toma la
 * primera linea no vacia que venga despues (hasta 3 lineas mas abajo).
 */
function extractTableValue_(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const sameLine = body.match(new RegExp(escaped + '[ \\t]+([^\\r\\n]+)'));
  if (sameLine && sameLine[1].trim()) return sameLine[1].trim();

  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === label) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const val = lines[j].trim();
        if (val) return val;
      }
    }
  }
  return '';
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/**
 * Avisa al dueño de la cuenta (por correo) cuando una venta no se pudo
 * procesar sola, para que la revise y la agregue manualmente si hace
 * falta.
 */
function notifyReview_(message, motivo) {
  try {
    GmailApp.sendEmail(
      Session.getEffectiveUser().getEmail(),
      'Revisar venta no procesada — Repositorio QR',
      'No se pudo generar el ticket automaticamente.\n\n' +
      'Motivo: ' + motivo + '\n\n' +
      'Asunto del correo original: ' + message.getSubject() + '\n' +
      'Fecha: ' + message.getDate() + '\n\n' +
      'Revisalo manualmente (etiqueta "' + LABEL_REVIEW + '" en Gmail) y agrega la fila en la Sheet si corresponde.'
    );
  } catch (e) {
    Logger.log('No se pudo enviar la alerta de revision: ' + e);
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findRowByTransactionId_(sheet, txId) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][5] === txId) return i + 1;
  }
  return null;
}

function findRowByTicketId_(sheet, ticketId) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][4] === ticketId) return i + 1;
  }
  return null;
}

function getNextTicketNumber_(sheet, prefijo) {
  const data = sheet.getDataRange().getValues();
  let max = 0;
  for (let i = 1; i < data.length; i++) {
    const ticketId = data[i][4];
    if (typeof ticketId === 'string' && ticketId.indexOf(prefijo + '-') === 0) {
      const n = parseInt(ticketId.split('-').pop(), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return max + 1;
}

function appendRow_(sheet, d) {
  sheet.appendRow([
    new Date(), d.evento, d.tipo, d.numero, d.ticketId,
    d.txId, d.referencia, d.nombre, d.email, d.telefono,
    d.montoCOP, d.estado, false, false, ''
  ]);
}

function setEmailSentFlag_(sheet, txId, sent) {
  // Un combo genera varias filas con el mismo txId — se marcan todas.
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][5] === txId) sheet.getRange(i + 1, 13).setValue(sent);
  }
}

function generateQrBlob_(ticketId) {
  const url = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=' + encodeURIComponent(ticketId);
  const resp = UrlFetchApp.fetch(url);
  return resp.getBlob().setName('qr-' + ticketId + '.png');
}

/**
 * Color de acento por tipo de entrada — verde para Pista (Preventa/
 * General), dorado para VIP, cyan para Backstage. Se usa tanto en el
 * PNG (Slides) como en el HTML del correo.
 */
function accentColorForTipo_(tipo) {
  if (tipo === 'VIP') return '#F2B84B';
  if (tipo === 'Backstage') return '#2DD9F0';
  return '#3DFF8B';
}

function hexToRgba_(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

/**
 * Arma la tarjeta completa del ticket (fondo, insignia, nombre, QR,
 * codigo, fecha/venue) como una diapositiva de Google Slides y la
 * exporta como PNG — asi el comprador puede guardar/reenviar el ticket
 * como una sola imagen, no solo verlo dentro del correo.
 *
 * d: { evento, sub, tipo, nombre, entradaLabel, ticketId, footer, qrBlob }
 */
function generateTicketPng_(d) {
  const NIGHT = '#0B1F14', NEON = accentColorForTipo_(d.tipo), CREAM = '#F5EFE0', DIM = '#8FA79B';

  const pres = SlidesApp.create('tmp-ticket-' + Utilities.getUuid());
  const presId = pres.getId();

  try {
    // SlidesApp no permite cambiar el tamaño de pagina (no hay
    // setPageSize) — se usa el tamaño real de la diapositiva (horizontal
    // por defecto) y el diseño se acomoda a eso en vez de forzar un
    // formato vertical.
    const WIDTH = pres.getPageWidth();
    const HEIGHT = pres.getPageHeight();
    const PAD = 36;

    const slide = pres.getSlides()[0];
    slide.getShapes().forEach(function (s) {
      try { s.remove(); } catch (e) { /* placeholder sin contenido, ignorar */ }
    });

    const bg = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, 0, 0, WIDTH, HEIGHT);
    bg.getFill().setSolidFill(NIGHT);
    bg.getBorder().setTransparent();

    const bar = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, 0, 0, WIDTH, 6);
    bar.getFill().setSolidFill(NEON);
    bar.getBorder().setTransparent();

    function addText(text, x, y, w, size, color, bold, align) {
      const tb = slide.insertTextBox(text, x, y, w, size + 14);
      tb.getFill().setTransparent();
      tb.getBorder().setTransparent();
      const tr = tb.getText();
      tr.getTextStyle().setFontFamily('Arial').setFontSize(size).setBold(!!bold).setForegroundColor(color);
      tr.getParagraphStyle().setParagraphAlignment(align || SlidesApp.ParagraphAlignment.START);
      return tb;
    }

    // Columna izquierda: QR grande centrado.
    const qrColW = WIDTH * 0.4;
    const qrSize = Math.min(qrColW - PAD * 2, HEIGHT - PAD * 2 - 30);
    const qrX = (qrColW - qrSize) / 2;
    const qrY = (HEIGHT - qrSize) / 2;
    const pad = 14;
    const qrBg = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, qrX - pad, qrY - pad, qrSize + pad * 2, qrSize + pad * 2);
    qrBg.getFill().setSolidFill('#FFFFFF');
    qrBg.getBorder().setTransparent();
    slide.insertImage(d.qrBlob, qrX, qrY, qrSize, qrSize);

    const div = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, qrColW, PAD, 1, HEIGHT - PAD * 2);
    div.getFill().setSolidFill(NEON);
    div.getBorder().setTransparent();

    // Columna derecha: info del ticket.
    const rx = qrColW + 40;
    const rw = WIDTH - rx - PAD;
    const LEFT = SlidesApp.ParagraphAlignment.START;

    let y = PAD + 6;
    addText('FAN TRIBUTE · ' + d.evento.toUpperCase(), rx, y, rw, 12, NEON, true, LEFT);
    y += 22;
    if (d.sub) { addText(d.sub, rx, y, rw, 10, DIM, false, LEFT); y += 22; }

    const badgeW = Math.min(rw, 170), badgeH = 28;
    const badge = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, rx, y, badgeW, badgeH);
    badge.getFill().setTransparent();
    badge.getBorder().getLineFill().setSolidFill(NEON);
    badge.getBorder().setWeight(1);
    const badgeText = badge.getText();
    badgeText.setText(d.tipo.toUpperCase());
    badgeText.getTextStyle().setFontFamily('Arial').setFontSize(10).setBold(true).setForegroundColor(NEON);
    badgeText.getParagraphStyle().setParagraphAlignment(SlidesApp.ParagraphAlignment.CENTER);
    y += badgeH + 18;

    addText(d.nombre, rx, y, rw, 19, CREAM, true, LEFT);
    y += 40;

    addText(d.entradaLabel, rx, y, rw, 10, DIM, false, LEFT);
    y += 26;

    addText(d.ticketId, rx, y, rw, 17, CREAM, true, LEFT);
    y += 28;
    addText('CÓDIGO ÚNICO — PRESENTA ESTE QR EN LA ENTRADA', rx, y, rw, 8, DIM, false, LEFT);

    if (d.footer) addText(d.footer, rx, HEIGHT - PAD - 20, rw, 9, DIM, false, LEFT);

    pres.saveAndClose();

    const slideId = slide.getObjectId();
    const exportUrl = 'https://docs.google.com/presentation/d/' + presId + '/export/png?id=' + presId + '&pageid=' + slideId;
    const resp = UrlFetchApp.fetch(exportUrl, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() !== 200) {
      throw new Error('Export de Slides devolvio ' + resp.getResponseCode());
    }

    return resp.getBlob().setName(d.ticketId + '.png');
  } finally {
    DriveApp.getFileById(presId).setTrashed(true);
  }
}

/**
 * d.tickets es un array de { numero, ticketId } — 1 elemento en una
 * compra normal, 2 o 3 en un combo. Cada uno trae su propio QR dentro
 * del correo (HTML) y, ademas, su propia tarjeta completa como imagen
 * PNG adjunta (para que se pueda guardar/reenviar suelta).
 */
function sendTicketEmail_(d) {
  const info = EVENT_INFO[d.evento] || { sub: '', footer: '' };
  const cantidad = d.tickets.length;
  const inlineImages = {};
  const attachments = [];

  const ticketsConCid = d.tickets.map(function (t, i) {
    const cid = 'qrcode' + i;
    const qrBlob = generateQrBlob_(t.ticketId);
    inlineImages[cid] = qrBlob;

    const entradaLabel = cantidad > 1 ? 'Entrada ' + (i + 1) + ' de ' + cantidad : 'Entrada individual';

    try {
      attachments.push(generateTicketPng_({
        evento: d.evento,
        sub: info.sub,
        tipo: d.tipo,
        nombre: d.nombre,
        entradaLabel: entradaLabel,
        ticketId: t.ticketId,
        footer: info.footer,
        qrBlob: qrBlob
      }));
    } catch (pngErr) {
      // Si falla el PNG, el correo sigue saliendo igual con el QR en el
      // HTML — no se pierde el ticket, solo falta el adjunto.
      Logger.log('No se pudo generar el PNG del ticket ' + t.ticketId + ': ' + pngErr);
    }

    return { numero: t.numero, ticketId: t.ticketId, cid: cid, entradaLabel: entradaLabel };
  });

  const html = buildEmailHtml_({
    nombre: d.nombre,
    evento: d.evento,
    tipo: d.tipo,
    tickets: ticketsConCid
  });

  GmailApp.sendEmail(d.email, buildEmailSubject_(d), '', {
    htmlBody: html,
    inlineImages: inlineImages,
    attachments: attachments,
    name: 'Fan Tribute'
  });
}

/**
 * Los tipos de End of Summer (la segunda fecha) usan el asunto nuevo.
 * El resto de eventos (ej. Summer 2016) conserva el asunto anterior.
 */
function buildEmailSubject_(d) {
  if (d.evento === 'End of Summer') {
    return 'QR ' + d.tipo.toUpperCase() + ' SEGUNDA FECHA';
  }
  return 'Tu entrada para ' + d.evento + ' — ' + d.tipo;
}

// Info fija del evento (fecha/venue), la misma que ya esta publicada en
// end-of-summer-2.html / summer-2016.html. Texto plano (UTF-8) — se usa
// tanto en el HTML del correo como en la imagen PNG del ticket.
const EVENT_INFO = {
  'End of Summer': { sub: 'Segunda fecha · Viernes 4 de septiembre', footer: 'Teatro Republik, Bogotá · 9:00 p.m. — 3:00 a.m.' },
  'Summer 2016':   { sub: 'Primera fecha · 5 de septiembre',         footer: 'Teatro Republik, Bogotá · 10:00 p.m. — 3:00 a.m.' }
};

function buildEmailHtml_(d) {
  const neon = accentColorForTipo_(d.tipo);
  const bg = '#040E08', neonDim = hexToRgba_(neon, 0.35),
        cream = '#F5EFE0', dim = '#8FA79B';

  const info = EVENT_INFO[d.evento] || { sub: '', footer: '' };
  const cantidad = d.tickets.length;

  const qrBlocks = d.tickets.map(function (t) {
    return '' +
    '<p style="font-size:13px; color:' + dim + '; margin:0 0 14px;">' + escapeHtml_(t.entradaLabel) + '</p>' +
    '<div style="background:#fff; padding:18px; border-radius:18px; display:inline-block; margin-bottom:20px; box-shadow:0 0 0 1px ' + neonDim + ', 0 0 34px ' + neonDim + ';">' +
      '<img src="cid:' + t.cid + '" width="220" height="220" style="display:block;" alt="QR ' + escapeHtml_(t.ticketId) + '">' +
    '</div>' +
    '<div style="font-family:\'Courier New\',monospace; font-weight:700; font-size:24px; letter-spacing:0.04em; color:' + cream + '; margin-bottom:6px;">' + escapeHtml_(t.ticketId) + '</div>' +
    '<p style="font-size:10.5px; letter-spacing:0.1em; text-transform:uppercase; color:' + dim + '; margin:0 0 36px;">C&oacute;digo &uacute;nico &mdash; presenta este QR en la entrada</p>';
  }).join('');

  return '' +
'<div style="background:' + bg + '; padding:0 0 32px;">' +
  '<div style="height:6px; background:' + neon + ';"></div>' +
  '<div style="max-width:440px; margin:0 auto; padding:40px 24px 8px; text-align:center; font-family:Arial,Helvetica,sans-serif;">' +

    '<p style="font-size:12px; letter-spacing:0.16em; text-transform:uppercase; color:' + neon + '; font-weight:700; margin:0 0 6px;">Fan Tribute &middot; ' + escapeHtml_(d.evento).toUpperCase() + '</p>' +
    (info.sub ? '<p style="font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:' + dim + '; margin:0 0 24px;">' + info.sub + '</p>' : '') +

    '<div style="display:inline-block; padding:8px 20px; border:1px solid ' + neon + '; border-radius:100px; color:' + neon + '; font-size:12px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; margin-bottom:22px;">' + escapeHtml_(d.tipo) + '</div>' +

    '<h1 style="font-size:26px; font-weight:800; color:' + cream + '; margin:0 0 28px; font-family:Georgia,\'Times New Roman\',serif;">' + escapeHtml_(d.nombre) + '</h1>' +

    qrBlocks +

    (cantidad > 1
      ? '<p style="font-size:12px; line-height:1.7; color:' + dim + '; margin:0 0 28px;">Este correo trae ' + cantidad + ' c&oacute;digos QR &mdash; uno por persona. Cada uno se presenta por separado en la entrada.</p>'
      : '') +

    '<div style="height:1px; background:' + neonDim + '; margin:8px 0 20px;"></div>' +
    (info.footer ? '<p style="font-size:12px; color:' + dim + '; margin:0;">' + info.footer + '</p>' : '') +
    '<p style="font-size:11px; color:' + dim + '; opacity:0.7; margin-top:18px;">Dudas por Instagram <strong style="color:' + cream + ';">@fantribute_col</strong>.</p>' +
  '</div>' +
'</div>';
}

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
