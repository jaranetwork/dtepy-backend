/**
 * procesarFactura con el xmlgen REAL (node --test, sin Mongo, SET ni
 * certificado): el XML se genera de verdad; la firma, el QR, el envío a SET,
 * la escritura en de_output y la base se reemplazan por dobles.
 *
 * Cubre dos arreglos:
 *  - Redondeo SEDECO solo con pago 100 % en efectivo: con tarjeta, una factura
 *    de 5.931.791 Gs salía por 5.931.750 (dRedon 41).
 *  - El total guardado es el dTotGralOpe del XML (el que se factura).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function stub(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

// procesarFactura loguea cada paso; acá solo interesan las aserciones.
console.log = () => {};
console.warn = () => {};

// ── Emisor ficticio con datos válidos para xmlgen ────────────────────
const empresa = {
  _id: 'empresa-kingston',
  ruc: '80055783-2',
  razonSocial: 'Kingston Center S.A.',
  nombreFantasia: 'Kingston Center',
  activo: true,
  tipoContribuyente: 2,
  tipoRegimen: 8,
  actividadesEconomicas: [{ codigo: '47411', descripcion: 'Comercio al por menor de equipos informáticos' }],
  establecimientos: [{
    codigo: '001',
    denominacion: 'Casa matriz',
    direccion: 'Avda. Mariscal López',
    numeroCasa: '1000',
    departamento: 1,
    departamentoDescripcion: 'CAPITAL',
    distrito: 1,
    distritoDescripcion: 'ASUNCION (DISTRITO)',
    ciudad: 1,
    ciudadDescripcion: 'ASUNCION (DISTRITO)',
    telefono: '021000000',
    email: 'ventas@example.com'
  }],
  configuracionSifen: {
    timbrado: '18646542',
    timbradoFecha: '2025-01-01',
    idCSC: '0001',
    csc: 'ABCD0000000000000000000000000000',
    modo: 'test',
    envioFacturas: 'normal'
  },
  certificado: { contrasena: 'cifrada' },
  tieneCertificadoValido: () => true,
  obtenerRutaCertificado: () => '/sin/certificado.p12'
};

// ── Dobles ──────────────────────────────────────────────────────────
let actualizaciones = [];  // Invoice.findByIdAndUpdate
let enviadosASet = [];     // XML que llegó a setApi.recibe

stub('../models/Empresa', { findById: async () => empresa });
stub('../models/Invoice', {
  findByIdAndUpdate: async (id, cambios) => { actualizaciones.push({ id, cambios }); return null; }
});
stub('../services/certificadoService', { descifrarContrasena: () => 'clave' });
stub('../services/envioLoteService', {
  agregarFacturaALote: async () => { throw new Error('esta empresa envía en modo normal, no por lote'); }
});
stub('../services/setapi-wrapper', {
  recibe: async (idDocumento, xml) => {
    enviadosASet.push(xml);
    return {
      'ns2:rRetEnviDe': {
        'ns2:rProtDe': {
          'ns2:dFecProc': '2026-09-28T10:00:05-03:00',
          'ns2:dEstRes': 'Aprobado',
          'ns2:gResProc': { 'ns2:dCodRes': '0260', 'ns2:dMsgRes': 'Autorización del DE satisfactoria' }
        }
      }
    };
  }
});

// Sin certificado no hay firma ni QR reales: el XML sigue igual.
require('facturacionelectronicapy-xmlsign').default.signXML = async (xml) => xml;
require('facturacionelectronicapy-qrgen').default.generateQR = async (xml) => xml;

// Lo que iría a de_output/ queda en memoria (el test no escribe archivos).
const DE_OUTPUT = path.join(__dirname, '..', 'de_output');
const enDeOutput = (ruta) => path.resolve(String(ruta)).startsWith(DE_OUTPUT);
const { writeFileSync, mkdirSync } = fs;
let archivos = [];
fs.writeFileSync = function (ruta, ...resto) {
  if (enDeOutput(ruta)) { archivos.push(String(ruta)); return undefined; }
  return writeFileSync.call(this, ruta, ...resto);
};
fs.mkdirSync = function (ruta, ...resto) {
  if (enDeOutput(ruta)) return undefined;
  return mkdirSync.call(this, ruta, ...resto);
};

const FacturaElectronicaPY = require('facturacionelectronicapy-xmlgen').default;
const { procesarFactura, extraerTotalGeneral } = require('../services/procesarFacturaService');

// ── Documento ───────────────────────────────────────────────────────
const EFECTIVO = 1;
const TARJETA_CREDITO = 3;
const TRANSFERENCIA = 5;

/** Una venta de 5.931.791 Gs (no múltiplo de 50), como la manda la tienda. */
function venta({ tipoPago, descuentoGlobal = 0 }) {
  const total = 5931791 - descuentoGlobal;
  const entrega = { tipo: tipoPago, monto: String(total), moneda: 'PYG' };
  if (tipoPago === TARJETA_CREDITO) {
    entrega.infoTarjeta = { tipo: 99, tipoDescripcion: 'Tarjeta online', medioPago: 2 };
  }
  return {
    param: { ruc: empresa.ruc },
    data: {
      tipoDocumento: 1,
      establecimiento: '001',
      punto: '002',
      numero: '0000001',
      codigoSeguridadAleatorio: '123456789',
      fecha: '2026-09-28T10:00:00',
      tipoEmision: 1,
      tipoTransaccion: 1,
      tipoImpuesto: 1,
      moneda: 'PYG',
      factura: { presencia: 2 },
      cliente: {
        contribuyente: false,
        tipoOperacion: 2,
        pais: 'PRY',
        documentoTipo: 1,
        documentoNumero: '4123456',
        razonSocial: 'Juan Perez'
      },
      condicion: { tipo: 1, entregas: [entrega] },
      items: [{
        codigo: 'SKU-1',
        descripcion: 'Notebook',
        unidadMedida: 77,
        cantidad: 1,
        precioUnitario: 5931791,
        ivaTipo: 1,
        ivaBase: 100,
        iva: 10
      }],
      ...(descuentoGlobal ? { descuentoGlobal } : {})
    }
  };
}

const campo = (xml, nombre) => (String(xml).match(new RegExp(`<${nombre}>([^<]*)</${nombre}>`)) || [])[1];

beforeEach(() => {
  actualizaciones = [];
  enviadosASet = [];
  archivos = [];
});

test('xmlgen por defecto redondea aunque se pague con tarjeta (el bug)', async () => {
  const params = {
    version: 150,
    ruc: empresa.ruc,
    razonSocial: empresa.razonSocial,
    nombreFantasia: empresa.nombreFantasia,
    actividadesEconomicas: empresa.actividadesEconomicas,
    timbradoNumero: empresa.configuracionSifen.timbrado,
    timbradoFecha: empresa.configuracionSifen.timbradoFecha,
    tipoContribuyente: empresa.tipoContribuyente,
    tipoRegimen: empresa.tipoRegimen,
    establecimientos: empresa.establecimientos
  };
  const xml = await FacturaElectronicaPY.generateXMLDE(params, venta({ tipoPago: TARJETA_CREDITO }).data, {});
  assert.equal(campo(xml, 'dRedon'), '41');
  assert.equal(campo(xml, 'dTotGralOpe'), '5931750', '41 Gs menos que lo cobrado');
});

test('tarjeta: el XML que llega a SET factura el monto exacto (dRedon 0) y ese es el total guardado', async () => {
  const resultado = await procesarFactura(venta({ tipoPago: TARJETA_CREDITO }), empresa._id, null, 'factura-1');

  assert.equal(resultado.estado, 'aceptado');
  assert.equal(enviadosASet.length, 1);
  const xml = enviadosASet[0];
  assert.equal(campo(xml, 'dTotOpe'), '5931791');
  assert.equal(campo(xml, 'dRedon'), '0');
  assert.equal(campo(xml, 'dTotGralOpe'), '5931791');

  assert.equal(actualizaciones.length, 1);
  assert.equal(actualizaciones[0].id, 'factura-1');
  assert.equal(actualizaciones[0].cambios.total, 5931791);
  assert.equal(archivos.length, 1, 'el XML se "guardó" antes de enviar');
});

test('transferencia: tampoco redondea', async () => {
  await procesarFactura(venta({ tipoPago: TRANSFERENCIA }), empresa._id, null, 'factura-2');
  assert.equal(campo(enviadosASet[0], 'dRedon'), '0');
  assert.equal(actualizaciones[0].cambios.total, 5931791);
});

test('efectivo: se aplica el redondeo SEDECO y el total guardado es el redondeado', async () => {
  await procesarFactura(venta({ tipoPago: EFECTIVO }), empresa._id, null, 'factura-3');

  const xml = enviadosASet[0];
  assert.ok(Number(campo(xml, 'dRedon')) > 0, `dRedon: ${campo(xml, 'dRedon')}`);
  assert.equal(campo(xml, 'dRedon'), '41');
  assert.equal(campo(xml, 'dTotGralOpe'), '5931750');
  assert.equal(actualizaciones[0].cambios.total, 5931750, 'el total real del documento, con el redondeo');
});

test('descuento global: el total guardado es el neto que factura el XML', async () => {
  await procesarFactura(venta({ tipoPago: TARJETA_CREDITO, descuentoGlobal: 91 }), empresa._id, null, 'factura-4');

  assert.equal(campo(enviadosASet[0], 'dTotGralOpe'), '5931700');
  assert.equal(actualizaciones[0].cambios.total, 5931700);
});

test('extraerTotalGeneral: el dTotGralOpe como número, o null si no está', () => {
  assert.equal(extraerTotalGeneral('<gTotSub><dTotGralOpe>5931791</dTotGralOpe></gTotSub>'), 5931791);
  assert.equal(extraerTotalGeneral('<dTotGralOpe>1234.56</dTotGralOpe>'), 1234.56, 'USD con decimales');
  assert.equal(extraerTotalGeneral('<ns2:dTotGralOpe> 950 </ns2:dTotGralOpe>'), 950, 'con prefijo y espacios');
  assert.equal(extraerTotalGeneral('<gTotSub><dTotOpe>100</dTotOpe></gTotSub>'), null, 'nota de remisión: sin totales');
  assert.equal(extraerTotalGeneral('<dTotGralOpe>abc</dTotGralOpe>'), null);
  assert.equal(extraerTotalGeneral(''), null);
  assert.equal(extraerTotalGeneral(null), null);
});
