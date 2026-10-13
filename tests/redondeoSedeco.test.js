const { test } = require('node:test');
const assert = require('node:assert/strict');

const { aplicaRedondeoSedeco, TIPO_PAGO_EFECTIVO } = require('../utils/redondeoSedeco');

// Formas de pago del catálogo SIFEN (iTiPago) que usan las integraciones.
const EFECTIVO = 1;
const TARJETA_CREDITO = 3;
const TARJETA_DEBITO = 4;
const TRANSFERENCIA = 5;
const PAGO_ELECTRONICO = 21;

const conEntregas = (moneda, ...tipos) => ({
  moneda,
  condicion: { tipo: 1, entregas: tipos.map((tipo) => ({ tipo, monto: '1000', moneda })) }
});

test('efectivo es el tipo 1 del catálogo de formas de pago', () => {
  assert.equal(TIPO_PAGO_EFECTIVO, EFECTIVO);
});

test('PYG pagado todo en efectivo: se redondea (Res. SEDECO 347/2014)', () => {
  assert.equal(aplicaRedondeoSedeco(conEntregas('PYG', EFECTIVO)), true);
  assert.equal(aplicaRedondeoSedeco(conEntregas('PYG', EFECTIVO, EFECTIVO)), true);
});

test('PYG con tarjeta, transferencia o pago electrónico: no se redondea (se cobró el monto exacto)', () => {
  for (const tipo of [TARJETA_CREDITO, TARJETA_DEBITO, TRANSFERENCIA, PAGO_ELECTRONICO]) {
    assert.equal(aplicaRedondeoSedeco(conEntregas('PYG', tipo)), false, `tipo ${tipo}`);
  }
});

test('pago mixto (efectivo + tarjeta): no se redondea, tienen que ser TODAS efectivo', () => {
  assert.equal(aplicaRedondeoSedeco(conEntregas('PYG', EFECTIVO, TARJETA_CREDITO)), false);
  assert.equal(aplicaRedondeoSedeco(conEntregas('PYG', TRANSFERENCIA, EFECTIVO)), false);
});

test('sin entregas no hay pago en efectivo declarado: no se redondea (NC/ND no llevan condición)', () => {
  assert.equal(aplicaRedondeoSedeco({ moneda: 'PYG' }), false);
  assert.equal(aplicaRedondeoSedeco({ moneda: 'PYG', condicion: { tipo: 1 } }), false);
  assert.equal(aplicaRedondeoSedeco({ moneda: 'PYG', condicion: { tipo: 1, entregas: [] } }), false);
  assert.equal(aplicaRedondeoSedeco({ moneda: 'PYG', condicion: { tipo: 1, entregas: 'efectivo' } }), false);
});

test('moneda extranjera nunca se redondea, aunque se pague en efectivo', () => {
  assert.equal(aplicaRedondeoSedeco(conEntregas('USD', EFECTIVO)), false);
  assert.equal(aplicaRedondeoSedeco(conEntregas('BRL', EFECTIVO)), false);
});

test('sin moneda se asume PYG, como hace xmlgen; la moneda y el tipo se normalizan', () => {
  assert.equal(aplicaRedondeoSedeco({ condicion: { tipo: 1, entregas: [{ tipo: EFECTIVO }] } }), true);
  assert.equal(aplicaRedondeoSedeco(conEntregas(' pyg ', EFECTIVO)), true);
  assert.equal(aplicaRedondeoSedeco(conEntregas('PYG', '1')), true, 'tipo como string');
  assert.equal(aplicaRedondeoSedeco(conEntregas('PYG', '3')), false, 'tipo como string');
});

test('entrega sin tipo o payload vacío: no se redondea', () => {
  assert.equal(aplicaRedondeoSedeco({ moneda: 'PYG', condicion: { entregas: [{ monto: '1000' }] } }), false);
  assert.equal(aplicaRedondeoSedeco({ moneda: 'PYG', condicion: { entregas: [null] } }), false);
  assert.equal(aplicaRedondeoSedeco(undefined), false);
  assert.equal(aplicaRedondeoSedeco({}), false);
});
