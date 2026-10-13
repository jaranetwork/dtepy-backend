/**
 * Notificaciones al integrador cuando una factura llega a estado final:
 *
 * 1. WEBHOOK: POST a empresa.notificaciones.webhookUrl con el resultado y
 *    los links de descarga, firmado con HMAC-SHA256 (header X-DTE-Firma)
 *    usando empresa.notificaciones.webhookSecret. 3 intentos (0s/10s/60s).
 *
 * 2. EMAIL AUTOMÁTICO: si empresa.notificaciones.emailAutomatico está activo
 *    y la factura fue aprobada, se envía el KUDE (PDF) + XML al email del
 *    cliente. Usa el proveedor SMTP seleccionado en la empresa
 *    (notificaciones.smtpProviderId, colección smtpproviders); si la empresa
 *    no tiene proveedor asignado, cae a las variables de entorno:
 *    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *    (SMTP_SEGURO=true para puerto 465).
 *
 * Ambas son fire-and-forget: un fallo se loguea y JAMÁS afecta el
 * procesamiento de la factura.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_URL_PUBLICA = process.env.API_URL_PUBLICA || 'https://dte-api.xplusapp.org';
const REINTENTOS_WEBHOOK_MS = [0, 10000, 60000];

let transporterEnvCache = null;
// transporters por proveedor SMTP, invalidados cuando cambia updatedAt
const transportersProvider = new Map(); // providerId -> { version, transporter, from }

function obtenerTransporterEnv() {
  if (transporterEnvCache !== null) return transporterEnvCache;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    transporterEnvCache = false; // marcado como "no configurado"
    return false;
  }
  const nodemailer = require('nodemailer');
  transporterEnvCache = {
    transporter: nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SEGURO === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    }),
    from: process.env.SMTP_FROM || process.env.SMTP_USER
  };
  return transporterEnvCache;
}

/**
 * Resuelve el transporter para una empresa: su proveedor SMTP seleccionado
 * (notificaciones.smtpProviderId) o, si no tiene, las variables de entorno.
 * Devuelve { transporter, from } o false si no hay SMTP disponible.
 */
async function obtenerTransporter(empresa) {
  const providerId = empresa.notificaciones?.smtpProviderId;
  if (providerId) {
    try {
      const SmtpProvider = require('../models/SmtpProvider');
      const provider = await SmtpProvider.findById(providerId);
      if (provider && provider.activo) {
        const version = provider.updatedAt ? provider.updatedAt.getTime() : 0;
        const clave = provider._id.toString();
        const cacheado = transportersProvider.get(clave);
        if (cacheado && cacheado.version === version) return cacheado;

        const nodemailer = require('nodemailer');
        const { descifrarContrasena } = require('./certificadoService');
        const entrada = {
          version,
          transporter: nodemailer.createTransport(
            provider.opcionesTransporte(descifrarContrasena(provider.contrasena))
          ),
          from: provider.remitente || provider.usuario
        };
        transportersProvider.set(clave, entrada);
        return entrada;
      }
      console.warn(`⚠️ [EMAIL] Proveedor SMTP ${providerId} inexistente o inactivo, usando SMTP del entorno`);
    } catch (err) {
      console.error(`❌ [EMAIL] Error cargando proveedor SMTP ${providerId}: ${String(err.message).slice(0, 120)}`);
    }
  }
  return obtenerTransporterEnv();
}

/**
 * Dispara el webhook de estado final. No lanza errores.
 */
async function enviarWebhook(invoice, empresa) {
  const url = empresa.notificaciones?.webhookUrl;
  if (!url) return;

  const cuerpo = JSON.stringify({
    evento: 'factura.estado_final',
    timestamp: new Date().toISOString(),
    factura: {
      id: invoice._id.toString(),
      correlativo: invoice.correlativo,
      estado: invoice.estadoSifen,
      cdc: invoice.cdc || null,
      codigoRetorno: invoice.codigoRetorno || null,
      mensajeRetorno: invoice.mensajeRetorno || null,
      total: invoice.total ?? null,
      cliente: {
        nombre: invoice.cliente?.nombre || null,
        documentoNumero: invoice.cliente?.documentoNumero || null,
        email: invoice.cliente?.email || null
      }
    },
    links: {
      pdf: `${API_URL_PUBLICA}/api/invoices/${invoice._id}/download-pdf`,
      xml: `${API_URL_PUBLICA}/api/invoices/${invoice._id}/download-xml`
    }
  });

  const firma = empresa.notificaciones?.webhookSecret
    ? crypto.createHmac('sha256', empresa.notificaciones.webhookSecret).update(cuerpo).digest('hex')
    : null;

  for (let intento = 0; intento < REINTENTOS_WEBHOOK_MS.length; intento++) {
    if (REINTENTOS_WEBHOOK_MS[intento] > 0) {
      await new Promise((r) => setTimeout(r, REINTENTOS_WEBHOOK_MS[intento]));
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'dtepy-webhook/1.0',
          'X-DTE-Evento': 'factura.estado_final',
          ...(firma ? { 'X-DTE-Firma': firma } : {})
        },
        body: cuerpo,
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        console.log(`🔔 [WEBHOOK] Entregado (${res.status}) factura ${invoice.correlativo} -> ${url}`);
        return;
      }
      console.warn(`⚠️ [WEBHOOK] HTTP ${res.status} intento ${intento + 1}/${REINTENTOS_WEBHOOK_MS.length} factura ${invoice.correlativo}`);
    } catch (err) {
      console.warn(`⚠️ [WEBHOOK] ${String(err.message).slice(0, 80)} intento ${intento + 1}/${REINTENTOS_WEBHOOK_MS.length} factura ${invoice.correlativo}`);
    }
  }
  console.error(`❌ [WEBHOOK] Agotados los reintentos para factura ${invoice.correlativo} -> ${url}`);
}

/**
 * Envía el KUDE por email al cliente (solo facturas aprobadas). El PDF se
 * genera en paralelo: si aún no está, espera hasta ~60s. No lanza errores.
 */
async function enviarKudePorEmail(invoiceId, empresa) {
  if (!empresa.notificaciones?.emailAutomatico) return;

  const smtp = await obtenerTransporter(empresa);
  if (!smtp) {
    console.warn('⚠️ [EMAIL] emailAutomatico activo pero sin SMTP: la empresa no tiene proveedor asignado y el entorno no define SMTP_HOST/SMTP_USER/SMTP_PASS');
    return;
  }

  // misma resolución de ruta que GET /api/invoices/:id/download-pdf
  const resolverKude = (kudePath) => {
    if (!kudePath) return null;
    const ruta = path.isAbsolute(kudePath) ? kudePath : path.join(__dirname, '../de_output', kudePath);
    return fs.existsSync(ruta) ? ruta : null;
  };

  const Invoice = require('../models/Invoice');
  let invoice = null;
  let rutaKude = null;
  // el KUDE se genera asíncrono: esperar hasta 6 x 10s a que exista
  for (let i = 0; i < 6; i++) {
    invoice = await Invoice.findById(invoiceId);
    rutaKude = resolverKude(invoice?.kudePath);
    if (rutaKude) break;
    await new Promise((r) => setTimeout(r, 10000));
  }
  if (!invoice) return;

  const destinatario = invoice.cliente?.email;
  if (!destinatario) {
    console.warn(`⚠️ [EMAIL] Factura ${invoice.correlativo} sin email de cliente, no se envía`);
    return;
  }

  const adjuntos = [];
  if (rutaKude) {
    adjuntos.push({ filename: `Factura-${invoice.correlativo}.pdf`, path: rutaKude });
  }
  if (invoice.xmlContent) {
    adjuntos.push({ filename: `Factura-${invoice.correlativo}.xml`, content: invoice.xmlContent });
  }
  if (adjuntos.length === 0) {
    console.warn(`⚠️ [EMAIL] Factura ${invoice.correlativo} sin PDF ni XML disponibles, no se envía`);
    return;
  }

  try {
    await smtp.transporter.sendMail({
      from: smtp.from,
      to: destinatario,
      subject: `Factura electrónica ${invoice.correlativo} - ${empresa.nombreFantasia}`,
      text: `Estimado/a ${invoice.cliente?.nombre || 'cliente'}:\n\n` +
        `Adjuntamos su factura electrónica ${invoice.correlativo}` +
        (invoice.cdc ? `\nCDC: ${invoice.cdc}` : '') +
        `\n\nPuede verificar el documento escaneando el código QR del PDF en https://ekuatia.set.gov.py/consultas\n\n` +
        `${empresa.razonSocial}\nRUC: ${empresa.ruc}`,
      attachments: adjuntos
    });
    console.log(`📧 [EMAIL] KUDE de ${invoice.correlativo} enviado a ${destinatario}`);
  } catch (err) {
    console.error(`❌ [EMAIL] Fallo enviando ${invoice.correlativo} a ${destinatario}: ${String(err.message).slice(0, 120)}`);
  }
}

/**
 * Punto de entrada único: notificar que una factura llegó a estado final.
 * Carga los datos frescos y dispara webhook + email según la configuración
 * de la empresa. Fire-and-forget (usar sin await).
 */
async function notificarFacturaFinal(invoiceId) {
  try {
    const Invoice = require('../models/Invoice');
    const Empresa = require('../models/Empresa');
    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) return;
    const empresa = await Empresa.findById(invoice.empresaId);
    if (!empresa) return;

    const tareas = [enviarWebhook(invoice, empresa)];
    if (['aceptado', 'observado'].includes(invoice.estadoSifen)) {
      tareas.push(enviarKudePorEmail(invoice._id, empresa));
    }
    await Promise.allSettled(tareas);
  } catch (err) {
    console.error('❌ [NOTIFICACIONES] Error:', String(err.message).slice(0, 120));
  }
}

module.exports = { notificarFacturaFinal, enviarWebhook, enviarKudePorEmail };
