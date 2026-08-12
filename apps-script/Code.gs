/**
 * Repositorio de QR — recibe el webhook de Wompi cuando una transacción se
 * aprueba, genera un ticket numerado por tipo, lo guarda en esta Sheet y
 * envía el QR por Gmail al comprador.
 *
 * Configuración requerida (Extensiones > Apps Script > Configuración del
 * proyecto > Propiedades de secuencia de comandos), NUNCA en este archivo:
 *   WOMPI_EVENTS_SECRET   -> Secreto de eventos (dashboard Wompi > API Keys)
 *   WOMPI_PRIVATE_KEY     -> Llave privada (por si se necesita consultar la API)
 *   SENDER_EMAIL          -> Cuenta Gmail que envía (debe ser la cuenta dueña
 *                             de este script para que GmailApp la use)
 */

// payment_link_id (Wompi) -> { evento, tipo, prefijo }
const LINK_MAP = {
  '4VUCiA': { evento: 'End of Summer', tipo: 'Preventa 2', prefijo: 'EOS-PV2' },
  'R2amMy': { evento: 'End of Summer', tipo: 'General',    prefijo: 'EOS-GEN' },
  'eW6ari': { evento: 'End of Summer', tipo: 'VIP',        prefijo: 'EOS-VIP' },
  'Oophjg': { evento: 'End of Summer', tipo: 'Backstage',  prefijo: 'EOS-BKS' },
  '1oKPkP': { evento: 'Summer 2016',   tipo: 'Preventa',   prefijo: 'S16-PRE' },
  'URc8lu': { evento: 'Summer 2016',   tipo: 'General',    prefijo: 'S16-GEN' },
  'djWZHo': { evento: 'Summer 2016',   tipo: 'VIP',        prefijo: 'S16-VIP' },
};

const SHEET_NAME = 'Repositorio QR';
const HEADERS = [
  'Fecha', 'Evento', 'Tipo de entrada', 'Numero', 'Ticket ID',
  'Transaccion ID', 'Referencia', 'Nombre', 'Email', 'Telefono',
  'Monto COP', 'Estado', 'Email enviado', 'Escaneado', 'Fecha escaneo'
];

/**
 * Sin parametros: healthcheck ("OK").
 * Con ?id=<transaction_id de Wompi>: consulta si ya se genero el ticket
 * para esa transaccion, para que confirmacion.html muestre el mismo
 * nombre/codigo que se envio por Gmail. Se usa desde el navegador
 * (fetch), por eso responde solo GET y solo datos no sensibles.
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

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (!verifyWompiSignature_(body)) {
      Logger.log('Firma invalida, evento ignorado');
      return jsonResponse_({ ok: false, reason: 'invalid_signature' });
    }

    const tx = body.data && body.data.transaction;
    if (!tx || tx.status !== 'APPROVED') {
      return jsonResponse_({ ok: true, ignored: true, reason: 'not_approved' });
    }

    const sheet = getSheet_();
    if (findRowByTransactionId_(sheet, tx.id)) {
      return jsonResponse_({ ok: true, ignored: true, reason: 'already_processed' });
    }

    const linkInfo = LINK_MAP[tx.payment_link_id] || {
      evento: 'Desconocido', tipo: 'General', prefijo: 'GEN'
    };

    const numero = getNextTicketNumber_(sheet, linkInfo.prefijo);
    const ticketId = linkInfo.prefijo + '-' + String(numero).padStart(3, '0');

    const nombre = (tx.customer_data && tx.customer_data.full_name) || 'Sin nombre';
    const telefono = (tx.customer_data && tx.customer_data.phone_number) || '';
    const email = tx.customer_email || '';
    const montoCOP = Math.round((tx.amount_in_cents || 0) / 100);

    appendRow_(sheet, {
      evento: linkInfo.evento,
      tipo: linkInfo.tipo,
      numero: numero,
      ticketId: ticketId,
      txId: tx.id,
      referencia: tx.reference,
      nombre: nombre,
      email: email,
      telefono: telefono,
      montoCOP: montoCOP,
      estado: tx.status
    });

    let enviado = false;
    if (email) {
      try {
        sendTicketEmail_({
          email: email,
          nombre: nombre,
          evento: linkInfo.evento,
          tipo: linkInfo.tipo,
          numero: numero,
          ticketId: ticketId
        });
        enviado = true;
      } catch (mailErr) {
        Logger.log('Error enviando email: ' + mailErr);
      }
    }
    setEmailSentFlag_(sheet, tx.id, enviado);

    return jsonResponse_({ ok: true, ticketId: ticketId, emailEnviado: enviado });
  } catch (err) {
    Logger.log('Error en doPost: ' + err);
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Verifica el checksum de Wompi: SHA256( valores de signature.properties
 * concatenados + timestamp + secreto de eventos ).
 */
function verifyWompiSignature_(body) {
  const secret = PropertiesService.getScriptProperties().getProperty('WOMPI_EVENTS_SECRET');
  if (!secret) throw new Error('Falta WOMPI_EVENTS_SECRET en Script Properties');

  const sig = body.signature;
  if (!sig || !sig.properties || !sig.checksum) return false;

  let concatenated = '';
  sig.properties.forEach(function (path) {
    concatenated += getByPath_(body.data, path.replace(/^data\./, ''));
  });
  concatenated += body.timestamp;
  concatenated += secret;

  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, concatenated);
  const hex = digest.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');

  return hex.toLowerCase() === String(sig.checksum).toLowerCase();
}

function getByPath_(obj, path) {
  return path.split('.').reduce(function (acc, key) {
    return acc && acc[key] !== undefined ? acc[key] : '';
  }, obj);
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
  const row = findRowByTransactionId_(sheet, txId);
  if (row) sheet.getRange(row, 13).setValue(sent);
}

function generateQrBlob_(ticketId) {
  const url = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=' + encodeURIComponent(ticketId);
  const resp = UrlFetchApp.fetch(url);
  return resp.getBlob().setName('qr-' + ticketId + '.png');
}

function sendTicketEmail_(d) {
  const qrBlob = generateQrBlob_(d.ticketId);
  const cid = 'qrcode';

  const html = buildEmailHtml_(d, cid);

  GmailApp.sendEmail(d.email, 'Tu entrada para ' + d.evento + ' — ' + d.tipo, '', {
    htmlBody: html,
    inlineImages: { qrcode: qrBlob },
    name: 'Fan Tribute'
  });
}

function buildEmailHtml_(d, cid) {
  const night = '#070E17', night2 = '#0E1E30', sun = '#FF6A2B',
        dusk = '#E8368F', cream = '#F7F1E4', creamDim = '#C9C2B2',
        line = 'rgba(247,241,228,0.14)';

  return '' +
'<div style="background:' + night + ';padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">' +
  '<div style="max-width:440px;margin:0 auto;background:' + night2 + ';border:1px solid ' + line + ';border-radius:22px;padding:34px 28px;text-align:center;color:' + cream + ';">' +
    '<div style="display:inline-block;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;padding:6px 14px;border-radius:100px;border:1px solid ' + line + ';color:' + sun + ';margin-bottom:20px;">' + escapeHtml_(d.tipo) + ' &middot; #' + d.numero + '</div>' +
    '<h1 style="font-size:22px;font-weight:800;margin:0 0 8px;">&iexcl;Ya tienes tu entrada!</h1>' +
    '<p style="font-size:14px;line-height:1.6;color:' + creamDim + ';margin:0 0 24px;">Hola <strong style="color:' + cream + ';">' + escapeHtml_(d.nombre) + '</strong>, este es tu QR de acceso para <strong style="color:' + cream + ';">' + escapeHtml_(d.evento) + '</strong>. Presentalo en la entrada.</p>' +
    '<div style="background:#fff;padding:16px;border-radius:16px;display:inline-block;margin-bottom:18px;">' +
      '<img src="cid:' + cid + '" width="240" height="240" style="display:block;" alt="QR ' + escapeHtml_(d.ticketId) + '">' +
    '</div>' +
    '<div style="font-family:monospace;font-size:13px;color:' + creamDim + ';margin-bottom:26px;">' + escapeHtml_(d.ticketId) + '</div>' +
    '<div style="border:1px solid ' + line + ';border-radius:14px;padding:16px 18px;background:rgba(247,241,228,0.04);text-align:left;">' +
      '<p style="font-size:13px;line-height:1.7;margin:0;">Guarda este correo, es tu comprobante de entrada.</p>' +
    '</div>' +
    '<p style="margin-top:24px;font-size:12px;line-height:1.6;color:' + creamDim + ';opacity:0.75;">Si tienes alguna duda, contactanos por Instagram <strong>@fantribute_col</strong>.</p>' +
  '</div>' +
'</div>';
}

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
