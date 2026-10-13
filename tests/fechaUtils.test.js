const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizarDatetime,
  normalizarFechasEnObjeto,
  convertirFechasASIFEN,
  formatoFechaSIFEN,
  horaLocal
} = require('../utils/fechaUtils');

// Los resultados no deben depender del TZ del proceso: se corren igual con
// TZ=UTC o TZ=America/Asuncion (ver package.json → test).

test('datetime sin zona se respeta literal (hora local paraguaya)', () => {
  assert.equal(normalizarDatetime('2026-08-31T09:00:00'), '2026-08-31T09:00:00.000');
  assert.equal(normalizarDatetime('2026-08-31T09:00:00', true), '2026-08-31T09:00:00');
  assert.equal(normalizarDatetime('2026-08-31T22:30:00', true), '2026-08-31T22:30:00');
  assert.equal(normalizarDatetime('2026-08-31 22:30:00', true), '2026-08-31T22:30:00');
  assert.equal(normalizarDatetime('2026-08-31T22:30', true), '2026-08-31T22:30:00');
});

test('microsegundos de ERPNext se recortan a milisegundos sin cambiar la hora', () => {
  assert.equal(normalizarDatetime('2026-02-24T15:12:58.715809'), '2026-02-24T15:12:58.715');
  assert.equal(normalizarDatetime('2026-02-24T15:12:58.715809', true), '2026-02-24T15:12:58');
  assert.equal(normalizarDatetime('2026-02-24T15:12:58.7'), '2026-02-24T15:12:58.700');
});

test('fecha sola se preserva', () => {
  assert.equal(normalizarDatetime('2026-08-31'), '2026-08-31');
  assert.equal(normalizarDatetime('2026-08-31', true), '2026-08-31');
});

test('datetime con zona, Date y timestamp se convierten a hora de Asunción', () => {
  // 2026-08-31T12:00:00Z = 09:00 en Asunción (UTC-3, sin horario de verano desde 2024)
  assert.equal(normalizarDatetime('2026-08-31T12:00:00Z', true), '2026-08-31T09:00:00');
  assert.equal(normalizarDatetime('2026-08-31T12:00:00.250Z'), '2026-08-31T09:00:00.250');
  assert.equal(normalizarDatetime('2026-08-31T09:00:00-03:00', true), '2026-08-31T09:00:00');
  assert.equal(normalizarDatetime('2026-08-31T10:00:00-02:00', true), '2026-08-31T09:00:00');
  assert.equal(normalizarDatetime(new Date('2026-08-31T12:00:00Z'), true), '2026-08-31T09:00:00');
  assert.equal(normalizarDatetime(Date.UTC(2026, 7, 31, 12, 0, 0), true), '2026-08-31T09:00:00');
  // Cruce de día: 01:30Z del 1/9 es 22:30 del 31/8 en Asunción
  assert.equal(normalizarDatetime('2026-09-01T01:30:00Z', true), '2026-08-31T22:30:00');
});

test('horaLocal respeta la zona pedida', () => {
  const d = new Date('2026-08-31T12:00:00Z');
  assert.equal(horaLocal(d, 'UTC'), '2026-08-31T12:00:00');
  assert.equal(horaLocal(d, 'America/Asuncion'), '2026-08-31T09:00:00');
  assert.equal(horaLocal(new Date('2026-08-31T00:30:00-03:00'), 'America/Asuncion'), '2026-08-31T00:30:00');
});

test('valores inválidos caen a la hora actual en formato local', () => {
  for (const v of [null, undefined, '', 'fecha-invalida', new Date('x')]) {
    const r = normalizarDatetime(v, true);
    assert.match(r, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, `valor ${String(v)}`);
  }
});

test('pipeline crearFactura → procesarFactura conserva la hora del payload', () => {
  const data = {
    fecha: '2026-08-31T09:00:00',
    cliente: { fecha_nacimiento: '1990-05-15' },
    factura: { fechaEnvio: '2026-08-31T12:00:00Z' },
    items: [{ descripcion: 'x' }]
  };
  normalizarFechasEnObjeto(data);
  assert.equal(data.fecha, '2026-08-31T09:00:00.000');
  assert.equal(data.cliente.fecha_nacimiento, '1990-05-15');
  assert.equal(data.factura.fechaEnvio, '2026-08-31T09:00:00.000');

  convertirFechasASIFEN(data);
  assert.equal(data.fecha, '2026-08-31T09:00:00');
  assert.equal(data.cliente.fecha_nacimiento, '1990-05-15');
  assert.equal(data.factura.fechaEnvio, '2026-08-31T09:00:00');
  assert.equal(formatoFechaSIFEN('2026-08-31T09:00:00.000'), '2026-08-31T09:00:00');
});
