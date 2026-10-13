const { test } = require('node:test');
const assert = require('node:assert/strict');

// El servicio carga modelos de mongoose y (vía facturaService) las colas de
// Bull: se stubea la cola para que el require no abra Redis.
const rutaColas = require.resolve('../queues/facturaQueue');
require.cache[rutaColas] = { id: rutaColas, filename: rutaColas, loaded: true, exports: { facturaQueue: {}, kudeQueue: {} } };

const {
  elegibleReintento, elegibleCancelacion, elegibleEliminacion, elegibilidad,
  nombreArchivo, filaCsv, aCsv
} = require('../services/facturaAccionesService');

const hace = (horas) => new Date(Date.now() - horas * 3600000);

test('reintento: solo documentos que no existen en SET y con datos guardados', () => {
  assert.equal(elegibleReintento({ estadoSifen: 'rechazado', datosFactura: { data: { x: 1 } } }).ok, true);
  assert.equal(elegibleReintento({ estadoSifen: 'error', datosFactura: { data: { x: 1 } } }).ok, true);
  assert.equal(elegibleReintento({ estadoSifen: 'aceptado', cdc: 'x', datosFactura: { data: { x: 1 } } }).ok, false);
  assert.equal(elegibleReintento({ estadoSifen: 'cancelado', cdc: 'x', datosFactura: { data: { x: 1 } } }).ok, false);
  assert.equal(elegibleReintento({ estadoSifen: 'encolado', datosFactura: { data: { x: 1 } } }).ok, false);
  assert.match(elegibleReintento({ estadoSifen: 'rechazado', datosFactura: {} }).motivo, /Sin datos/);
});

test('cancelación: aprobado y dentro del plazo (48 h factura, 168 h el resto)', () => {
  assert.equal(elegibleCancelacion({ estadoSifen: 'aceptado', cdc: 'x', de: 'Factura electrónica', fechaProceso: hace(10) }).ok, true);
  const fueraFE = elegibleCancelacion({ estadoSifen: 'aceptado', cdc: 'x', de: 'Factura electrónica', fechaProceso: hace(60) });
  assert.equal(fueraFE.ok, false);
  assert.equal(fueraFE.horasLimite, 48);
  assert.equal(elegibleCancelacion({ estadoSifen: 'aceptado', cdc: 'x', de: 'Nota de crédito electrónica', fechaProceso: hace(60) }).ok, true);
  assert.equal(elegibleCancelacion({ estadoSifen: 'rechazado', de: 'Factura electrónica' }).ok, false);
  assert.equal(elegibleCancelacion({ estadoSifen: 'cancelado', cdc: 'x', de: 'Factura electrónica', fechaProceso: hace(1) }).ok, false);
});

test('eliminación: nunca un documento que existe en SET', () => {
  assert.equal(elegibleEliminacion({ estadoSifen: 'rechazado' }).ok, true);
  assert.equal(elegibleEliminacion({ estadoSifen: 'error' }).ok, true);
  assert.equal(elegibleEliminacion({ estadoSifen: 'recibido' }).ok, true);
  for (const estado of ['aceptado', 'observado', 'cancelado']) {
    const r = elegibleEliminacion({ estadoSifen: estado });
    assert.equal(r.ok, false, estado);
    assert.match(r.motivo, /5 años/);
  }
  assert.equal(elegibleEliminacion({ estadoSifen: 'encolado' }).ok, false);
});

test('elegibilidad agrupa las cuatro acciones', () => {
  const e = elegibilidad({ estadoSifen: 'rechazado', datosFactura: { data: { x: 1 } } });
  assert.deepEqual(Object.keys(e), ['reintento', 'cancelacion', 'eliminacion', 'consultaEstado']);
  assert.equal(e.consultaEstado.ok, false);
});

test('nombreArchivo sin acentos ni espacios', () => {
  assert.equal(nombreArchivo({ de: 'Nota de crédito electrónica', correlativo: '001-002-0000001' }, 'xml'), 'Nota_de_credito_electronica_001-002-0000001.xml');
  assert.equal(nombreArchivo({ correlativo: '001-001-0000108' }, 'pdf'), 'Factura_electronica_001-001-0000108.pdf');
});

test('CSV: separador ; con BOM, comillas escapadas y el CDC protegido de Excel', () => {
  const fila = filaCsv({
    fechaCreacion: new Date('2026-09-10T12:18:00Z'), correlativo: '001-002-0000001', de: 'Nota de crédito electrónica',
    estadoSifen: 'aceptado', codigoRetorno: '0260', mensajeRetorno: 'Aprobado', cdc: '05800557832001002000000122026083112601724007',
    cliente: { ruc: '80097313-5', nombre: 'INTERPROD "PY" S.A.' }, total: 532750, rucEmpresa: '80055783-2', tipoEmision: 1,
    datosFactura: { data: { moneda: 'USD', cambio: 6000 } }, proceso: 'Completado',
    respuestaSifen: { codigo: '0260', estado: 'Aprobado', protocolo: '3556326022' }
  });
  const csv = aCsv([fila]);
  assert.ok(csv.startsWith('﻿"Fecha";"Número"'));
  const linea = csv.split('\r\n')[1];
  assert.ok(linea.includes('"INTERPROD ""PY"" S.A."'), 'comillas escapadas');
  assert.ok(linea.includes(`"'05800557832001002000000122026083112601724007"`), 'CDC con apóstrofo');
  assert.ok(linea.includes('"USD";"532750";"6000"'));
  assert.ok(linea.startsWith('"2026-09-10 09:18:00"'), 'fecha en hora de Paraguay (UTC-3), no UTC');
  assert.ok(csv.split('\r\n')[0].includes('"Protocolo SET"'), 'columna de protocolo');
  assert.ok(linea.includes('"0260";"Aprobado";"3556326022"'), 'protocolo de autorización de SET en la fila');
});
