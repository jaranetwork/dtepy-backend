/**
 * Utilidades para integradores.
 *
 * Webhook echo: receptor de prueba para verificar la integración de
 * webhooks sin salir del sistema. Configurá
 * notificaciones.webhookUrl = <API>/api/utils/webhook-echo, emití una
 * factura y consultá acá lo recibido (payload + headers de firma).
 */

const express = require('express');
const router = express.Router();
const { verificarToken, verificarPermiso } = require('../middleware/auth');

// buffer en memoria: suficiente para probar, sin persistencia
const recibidos = [];
const MAX_RECIBIDOS = 10;

// El POST es público a propósito: el emisor de webhooks no se autentica
// (como cualquier receptor de webhooks del mundo real). Solo guarda una
// copia acotada en memoria.
router.post('/webhook-echo', express.json({ limit: '100kb' }), (req, res) => {
  recibidos.unshift({
    recibidoEn: new Date().toISOString(),
    headers: {
      'x-dte-evento': req.headers['x-dte-evento'] || null,
      'x-dte-firma': req.headers['x-dte-firma'] || null,
      'user-agent': req.headers['user-agent'] || null
    },
    body: req.body
  });
  if (recibidos.length > MAX_RECIBIDOS) recibidos.pop();
  res.json({ success: true, message: 'Webhook recibido por el echo de prueba' });
});

// Leer lo recibido requiere autenticación normal
router.get('/webhook-echo', verificarToken, verificarPermiso('facturas:leer'), (req, res) => {
  res.json({ success: true, count: recibidos.length, recibidos });
});

module.exports = router;
