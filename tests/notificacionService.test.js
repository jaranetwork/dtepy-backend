/**
 * notificarFacturaFinal (node --test, sin Mongo, SMTP ni red).
 *
 * El webhook sale para todo estado final; el email del KUDE solo para
 * aceptado/observado. Acá se verifica para los dos estados que empezaron a
 * notificarse: 'error' (falla del worker) y 'cancelado' (evento de SET).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function stub(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

console.log = () => {};

let factura = null;
let empresa = null;
stub('../models/Invoice', { findById: async () => factura });
stub('../models/Empresa', { findById: async () => empresa });

// SMTP del entorno con un transporter falso: si el servicio decidiera mandar
// el email, se ve acá.
let correos = [];
stub('nodemailer', { createTransport: () => ({ sendMail: async (mensaje) => { correos.push(mensaje); } }) });
process.env.SMTP_HOST = 'smtp.invalid';
process.env.SMTP_USER = 'usuario';
process.env.SMTP_PASS = 'clave';

let webhooks = [];
global.fetch = async (url, opciones) => {
  webhooks.push({ url, cuerpo: JSON.parse(opciones.body), headers: opciones.headers });
  return { ok: true, status: 200 };
};

const { notificarFacturaFinal } = require('../services/notificacionService');

function datos(estadoSifen) {
  factura = {
    _id: 'factura-1',
    empresaId: 'empresa-1',
    correlativo: '001-002-0000001',
    estadoSifen,
    cdc: '01800557832001002000000122026092811234567890',
    total: 5931791,
    cliente: { nombre: 'Juan Perez', documentoNumero: '4123456', email: 'juan@example.com' },
    kudePath: __filename,  // un archivo que existe: el email no espera al PDF
    xmlContent: '<rDE/>'
  };
  empresa = {
    _id: 'empresa-1',
    ruc: '80055783-2',
    razonSocial: 'Kingston Center S.A.',
    nombreFantasia: 'Kingston Center',
    notificaciones: { webhookUrl: 'https://tienda.example/api/webhooks/dte', webhookSecret: 'secreto', emailAutomatico: true }
  };
}

beforeEach(() => {
  correos = [];
  webhooks = [];
});

test('cancelado: sale el webhook con el estado y no el email del KUDE', async () => {
  datos('cancelado');
  await notificarFacturaFinal('factura-1');

  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0].url, 'https://tienda.example/api/webhooks/dte');
  assert.equal(webhooks[0].cuerpo.evento, 'factura.estado_final');
  assert.equal(webhooks[0].cuerpo.factura.estado, 'cancelado');
  assert.ok(webhooks[0].headers['X-DTE-Firma'], 'firmado');
  assert.equal(correos.length, 0);
});

test('error (falla del worker): webhook sin email', async () => {
  datos('error');
  await notificarFacturaFinal('factura-1');

  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0].cuerpo.factura.estado, 'error');
  assert.equal(correos.length, 0);
});

test('control: aceptado manda webhook y email (el email está bien configurado)', async () => {
  datos('aceptado');
  await notificarFacturaFinal('factura-1');

  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0].cuerpo.factura.total, 5931791);
  assert.equal(correos.length, 1);
  assert.equal(correos[0].to, 'juan@example.com');
});
