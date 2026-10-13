const { test } = require('node:test');
const assert = require('node:assert/strict');

// El módulo carga los modelos de mongoose (sin abrir conexión), así que se
// puede requerir tal cual; acá se prueba la parte pura.
const { claveSecuenciaDeFactura, ESTADOS_NUNCA_EN_SET } = require('../services/numeracionService');

const empresa = { configuracionSifen: { timbrado: '18646542' } };
const factura = (correlativo, datosFactura) => ({ empresaId: 'emp1', correlativo, datosFactura });

test('la clave sale del correlativo firmado, no del payload', () => {
  const r = claveSecuenciaDeFactura(
    // el payload dice punto 007, pero lo que se firmó fue 001-002-0000001
    factura('001-002-0000001', { data: { tipoDocumento: 5, punto: '007' } }),
    empresa
  );
  assert.deepEqual(r.clave, {
    empresaId: 'emp1', timbrado: '18646542', tipoDocumento: 5,
    establecimiento: '001', punto: '002'
  });
  assert.equal(r.numero, 1);
});

test('el timbrado del payload gana sobre el de la empresa', () => {
  const r = claveSecuenciaDeFactura(
    factura('001-002-0000010', { param: { timbradoNumero: '99999999' }, data: { tipoDocumento: 1 } }),
    empresa
  );
  assert.equal(r.clave.timbrado, '99999999');
  assert.equal(r.numero, 10);
});

test('sin tipoDocumento se asume factura electrónica', () => {
  assert.equal(claveSecuenciaDeFactura(factura('001-001-0000003', { data: {} }), empresa).clave.tipoDocumento, 1);
});

test('un correlativo que no se puede interpretar devuelve null', () => {
  for (const correlativo of ['', '001-002', 'basura', '001-002-0000000', '001-002-abcdefg', undefined]) {
    assert.equal(claveSecuenciaDeFactura(factura(correlativo, { data: {} }), empresa), null, `correlativo: ${correlativo}`);
  }
  assert.equal(claveSecuenciaDeFactura(null, empresa), null);
});

test('solo rechazado y error cuentan como "nunca llegó a SET"', () => {
  assert.deepEqual(ESTADOS_NUNCA_EN_SET, ['rechazado', 'error']);
  for (const estado of ['aceptado', 'observado', 'cancelado', 'encolado']) {
    assert.ok(!ESTADOS_NUNCA_EN_SET.includes(estado), estado);
  }
});
