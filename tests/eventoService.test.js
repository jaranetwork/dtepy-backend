/**
 * Eventos SIFEN (node --test, sin Mongo, SET ni certificado).
 *
 * El caso: al registrarse una cancelación en SET la factura pasaba a
 * 'cancelado' pero no salía el webhook, y la integración seguía viendo la
 * factura vigente. enviarEvento es el único camino que cancela: lo usan
 * POST /api/eventos/enviar y POST /api/eventos/bulk/cancelar.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

function stub(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

// El aviso falso nunca termina (así se nota si enviarEvento lo espera): con
// límite, esperarlo hace fallar el test en vez de colgarlo.
const LIMITE = { timeout: 5000 };

console.log = () => {};

let eventosGuardados = [];
stub('../models/Evento', class EventoFalso {
  constructor(campos) { Object.assign(this, campos); this._id = `evento-${eventosGuardados.length + 1}`; }
  async save() { eventosGuardados.push(this); return this; }
});

let factura = null;
stub('../models/Invoice', { findById: async () => factura });

const empresa = {
  _id: 'empresa-kingston',
  ruc: '80055783-2',
  activo: true,
  nombreFantasia: 'Kingston Center',
  configuracionSifen: { modo: 'test' },
  certificado: { contrasena: 'cifrada' },
  obtenerRutaCertificado: () => '/sin/certificado.p12'
};
stub('../models/Empresa', { findById: async () => empresa });
stub('../services/certificadoService', { descifrarContrasena: () => 'clave' });

let respuestaSet = null;
stub('../services/setapi-wrapper', { evento: async () => respuestaSet });

let notificaciones = [];
stub('../services/notificacionService', {
  notificarFacturaFinal: (id) => {
    notificaciones.push({ id, estado: factura?.estadoSifen, guardados: factura?.guardados });
    return new Promise(() => {});  // fire-and-forget: enviarEvento no la espera
  }
});

// El XML del evento y su firma no son lo que se prueba acá.
const xmlgen = require('facturacionelectronicapy-xmlgen').default;
xmlgen.generateXMLEventoCancelacion = async () => '<rEve Id="1"/>';
xmlgen.generateXMLEventoConformidad = async () => '<rEve Id="1"/>';
require('facturacionelectronicapy-xmlsign').default.signXMLEvento = async (xml) => xml;

const { enviarEvento } = require('../services/eventoService');

/** Respuesta de SET a un evento, como la devuelve setapi (objeto parseado). */
const respuestaEvento = (codigo, estado, mensaje) => ({
  'ns2:rRetEnviEventoDe': {
    'ns2:dFecProc': '2026-09-28T11:00:00-03:00',
    'ns2:gResProcEVe': {
      'ns2:dEstRes': estado,
      'ns2:dProtAut': '1234567890',
      'ns2:id': '1',
      'ns2:gResProc': { 'ns2:dCodRes': codigo, 'ns2:dMsgRes': mensaje }
    }
  }
});

function facturaAprobada() {
  return {
    _id: new mongoose.Types.ObjectId(),
    cdc: '01800557832001002000000122026092811234567890',
    correlativo: '001-002-0000001',
    estadoSifen: 'aceptado',
    empresaId: empresa._id,
    rucEmpresa: empresa.ruc,
    cliente: { ruc: '4123456' },
    guardados: 0,
    async save() { this.guardados++; return this; }
  };
}

const cancelar = () => enviarEvento({
  invoiceId: String(factura._id),
  tipoEvento: 'cancelacion',
  descripcion: 'Venta anulada por el cliente',
  usuario: { documentoNumero: '0', nombre: 'Sistema' }
});

beforeEach(() => {
  eventosGuardados = [];
  notificaciones = [];
});

test('cancelación registrada en SET: la factura queda cancelada y sale el webhook', LIMITE, async () => {
  factura = facturaAprobada();
  respuestaSet = respuestaEvento('0600', 'Aprobado', 'Evento registrado correctamente');

  const resultado = await cancelar();

  assert.equal(resultado.estadoEvento, 'registrado');
  assert.equal(factura.estadoSifen, 'cancelado');
  assert.equal(notificaciones.length, 1);
  assert.equal(notificaciones[0].id, factura._id.toString());
  // El aviso sale con la cancelación ya guardada.
  assert.equal(notificaciones[0].estado, 'cancelado');
  assert.equal(notificaciones[0].guardados, 1);
});

test('"ya estaba cancelada" en SET (4003) también se refleja y se avisa', LIMITE, async () => {
  factura = facturaAprobada();
  respuestaSet = respuestaEvento('4003', 'Rechazado', 'CDC ya se encuentra con el mismo evento solicitado');

  const resultado = await cancelar();

  assert.equal(resultado.estadoEvento, 'registrado');
  assert.equal(factura.estadoSifen, 'cancelado');
  assert.equal(notificaciones.length, 1);
});

test('cancelación rechazada por SET: la factura sigue vigente y no se avisa nada', LIMITE, async () => {
  factura = facturaAprobada();
  respuestaSet = respuestaEvento('4001', 'Rechazado', 'Plazo de cancelación vencido');

  const resultado = await cancelar();

  assert.equal(resultado.estadoEvento, 'rechazado');
  assert.equal(factura.estadoSifen, 'aceptado');
  assert.equal(factura.guardados, 0);
  assert.equal(notificaciones.length, 0);
});

test('otros eventos (conformidad) no cambian el estado ni avisan', LIMITE, async () => {
  factura = facturaAprobada();
  respuestaSet = respuestaEvento('0600', 'Aprobado', 'Evento registrado correctamente');

  const resultado = await enviarEvento({
    invoiceId: String(factura._id),
    tipoEvento: 'conformidad',
    descripcion: 'Conformidad con la operación',
    datosEvento: { tipoConformidad: 1 },
    usuario: { documentoNumero: '0', nombre: 'Sistema' }
  });

  assert.equal(resultado.estadoEvento, 'registrado');
  assert.equal(factura.estadoSifen, 'aceptado');
  assert.equal(notificaciones.length, 0);
});
