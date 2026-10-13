/**
 * Tests del validador de receptor (node --test, sin dependencias).
 * Las reglas citadas son las del MT v150 + NT vigentes
 * (docs/fiscal/02-reglas-receptor-sifen.md).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validarReceptor, calcularDv, INNOMINADO_MAX_PYG } = require('../services/receptorValidator');

const codigos = (r) => r.errores.map((e) => e.codigo);

function base(cliente, extra = {}) {
  return {
    moneda: 'PYG',
    items: [{ precioUnitario: 100000, cantidad: 1 }],
    cliente,
    ...extra
  };
}

test('B2C paraguayo con CI: válido y normalizado', () => {
  const r = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    pais: 'PRY',
    documentoTipo: 1,
    documentoNumero: ' 4.123.456 ',
    razonSocial: '  Juan   Pérez  '
  }));
  assert.equal(r.errores.length, 0, JSON.stringify(r.errores));
  assert.equal(r.cliente.documentoNumero, '4123456');
  assert.equal(r.cliente.razonSocial, 'Juan Pérez');
});

test('documento faltante en no contribuyente: errores 1310 y 1314', () => {
  const r = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    razonSocial: 'Juan Pérez'
  }));
  assert.ok(codigos(r).includes('RECEPTOR_DOCUMENTO_TIPO_REQUERIDO'));
});

test('el bug del "undefined": documentoNumero ausente jamás pasa', () => {
  const r = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    documentoTipo: 1,
    razonSocial: 'Juan Pérez'
  }));
  assert.ok(codigos(r).includes('RECEPTOR_DOCUMENTO_NUMERO_REQUERIDO'));
});

test('DV del RUC: se recalcula y un DV incorrecto es error 1309', () => {
  const dv = calcularDv('80012345');
  const ok = validarReceptor(base({
    contribuyente: true,
    tipoOperacion: 1,
    ruc: `80012345-${dv}`,
    tipoContribuyente: 2,
    razonSocial: 'Empresa Ejemplo SA'
  }));
  assert.equal(ok.errores.length, 0, JSON.stringify(ok.errores));
  assert.equal(ok.cliente.ruc, `80012345-${dv}`);

  const mal = validarReceptor(base({
    contribuyente: true,
    tipoOperacion: 1,
    ruc: `80012345-${(dv + 1) % 10}`,
    tipoContribuyente: 2,
    razonSocial: 'Empresa Ejemplo SA'
  }));
  assert.ok(codigos(mal).includes('RECEPTOR_RUC_DV_INVALIDO'));
});

test('RUC sin guión: el DV se completa solo (nunca más dDVRec undefined)', () => {
  const dv = calcularDv('80012345');
  const r = validarReceptor(base({
    contribuyente: true,
    tipoOperacion: 1,
    ruc: '80012345',
    tipoContribuyente: 2,
    razonSocial: 'Empresa Ejemplo SA'
  }));
  assert.equal(r.errores.length, 0);
  assert.equal(r.cliente.ruc, `80012345-${dv}`);
});

test('contribuyente con documento de identidad: se remueve (1311/1334)', () => {
  const dv = calcularDv('80012345');
  const r = validarReceptor(base({
    contribuyente: true,
    tipoOperacion: 1,
    ruc: `80012345-${dv}`,
    tipoContribuyente: 2,
    documentoTipo: 1,
    documentoNumero: '123456',
    razonSocial: 'Empresa Ejemplo SA'
  }));
  assert.equal(r.errores.length, 0);
  assert.equal(r.cliente.documentoTipo, undefined);
  assert.equal(r.cliente.documentoNumero, undefined);
  assert.ok(r.advertencias.length > 0);
});

test('regla 1320: B2C con país extranjero es error; sin país asume PRY', () => {
  const mal = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    pais: 'BRA',
    documentoTipo: 2,
    documentoNumero: 'FP123456',
    razonSocial: 'Joao Pereira'
  }));
  assert.ok(codigos(mal).includes('RECEPTOR_PAIS_INVALIDO'));

  const sinPais = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    documentoTipo: 2,
    documentoNumero: 'FP123456',
    razonSocial: 'Joao Pereira'
  }));
  assert.equal(sinPais.errores.length, 0);
  assert.equal(sinPais.cliente.pais, 'PRY');
});

test('B2F: exige país real y dirección con número de casa (1320/1318/1330)', () => {
  const mal = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 4,
    pais: 'PRY',
    razonSocial: 'Acme Digital Ltda'
  }));
  assert.ok(codigos(mal).includes('RECEPTOR_PAIS_INVALIDO'));
  assert.ok(codigos(mal).includes('RECEPTOR_DIRECCION_REQUERIDA'));

  const ok = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 4,
    pais: 'BRA',
    direccion: 'Av Paulista 1000',
    numeroCasa: '1000',
    departamento: 11,
    razonSocial: 'Acme Digital Ltda'
  }));
  assert.equal(ok.errores.length, 0, JSON.stringify(ok.errores));
  assert.equal(ok.cliente.departamento, undefined); // no se informa en B2F
});

test('pasaporte: normaliza y valida formato ICAO', () => {
  const r = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    documentoTipo: 2,
    documentoNumero: ' fp-123.456 ',
    razonSocial: 'Joao Pereira'
  }));
  assert.equal(r.errores.length, 0, JSON.stringify(r.errores));
  assert.equal(r.cliente.documentoNumero, 'FP123456');

  const mal = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    documentoTipo: 2,
    documentoNumero: 'X#@!',
    razonSocial: 'Joao Pereira'
  }));
  assert.ok(codigos(mal).includes('RECEPTOR_PASAPORTE_FORMATO'));
});

test('innominado: fuerza "0"/"Sin Nombre", solo B2C, y respeta el tope de 7M (1321)', () => {
  const ok = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    documentoTipo: 5,
    razonSocial: 'lo que sea'
  }));
  assert.equal(ok.errores.length, 0, JSON.stringify(ok.errores));
  assert.equal(ok.cliente.documentoNumero, '0');
  assert.equal(ok.cliente.razonSocial, 'Sin Nombre');

  const caro = validarReceptor(base(
    { contribuyente: false, tipoOperacion: 2, documentoTipo: 5, razonSocial: 'x' },
    { items: [{ precioUnitario: INNOMINADO_MAX_PYG, cantidad: 1 }] }
  ));
  assert.ok(codigos(caro).includes('RECEPTOR_INNOMINADO_MONTO'));

  const enUsd = validarReceptor(base(
    { contribuyente: false, tipoOperacion: 2, documentoTipo: 5, razonSocial: 'x' },
    { moneda: 'USD', cambio: 7300, items: [{ precioUnitario: 1000, cantidad: 1 }] }
  ));
  assert.ok(codigos(enUsd).includes('RECEPTOR_INNOMINADO_MONTO')); // 7.3M Gs
});

test('documentoTipo 9 exige descripción (1312)', () => {
  const r = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    documentoTipo: 9,
    documentoNumero: 'ABC123',
    razonSocial: 'Cliente Extranjero'
  }));
  assert.ok(codigos(r).includes('RECEPTOR_DOCUMENTO_DESCRIPCION_REQUERIDA'));
});

test('razón social corta es inválida (dNomRec 4-255)', () => {
  const r = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    documentoTipo: 1,
    documentoNumero: '4123456',
    razonSocial: 'Al'
  }));
  assert.ok(codigos(r).includes('RECEPTOR_RAZON_SOCIAL_INVALIDA'));
});

test('dirección informada exige número de casa (1330)', () => {
  const r = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    documentoTipo: 1,
    documentoNumero: '4123456',
    direccion: 'Avda. San Blas 123',
    razonSocial: 'Juan Pérez'
  }));
  assert.ok(codigos(r).includes('RECEPTOR_NUMERO_CASA_REQUERIDO'));
});

test('no contribuyente con RUC: se remueve con advertencia (1305)', () => {
  const r = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    ruc: '80012345-0',
    documentoTipo: 1,
    documentoNumero: '4123456',
    razonSocial: 'Juan Pérez'
  }));
  assert.equal(r.cliente.ruc, undefined);
  assert.ok(r.advertencias.some((a) => a.includes('1305')));
});

test('contacto fuera de largo se omite sin bloquear', () => {
  const r = validarReceptor(base({
    contribuyente: false,
    tipoOperacion: 2,
    documentoTipo: 1,
    documentoNumero: '4123456',
    razonSocial: 'Juan Pérez',
    email: 'x',
    celular: '123',
    telefono: '1'
  }));
  assert.equal(r.errores.length, 0);
  assert.equal(r.cliente.email, undefined);
  assert.equal(r.cliente.celular, undefined);
  assert.equal(r.cliente.telefono, undefined);
});
