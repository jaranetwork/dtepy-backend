/**
 * POST /api/facturar/crear — respuesta HTTP según el resultado de crearFactura
 * (node --test, sin Express, Mongo ni Redis).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function stub(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

let resultadoCrear = null;
let llamadas = [];
stub('../services/facturaService', {
  crearFactura: async (...args) => {
    llamadas.push(args);
    if (resultadoCrear instanceof Error) throw resultadoCrear;
    return resultadoCrear;
  }
});
stub('../services/empresaService', { buscarEmpresaPorRUC: async () => ({ _id: 'empresa-kingston' }) });
stub('../services/cotizacionService', { resolverCambioParaEmision: async () => ({ aplicado: false }) });

const { crear } = require('../controllers/facturaController');

/** req mínimo de Express: req.get() no distingue mayúsculas, como el real. */
function pedido(headers = {}) {
  const porNombre = Object.fromEntries(
    Object.entries({ host: 'dte.example', ...headers }).map(([nombre, valor]) => [nombre.toLowerCase(), valor])
  );
  return {
    body: { param: { ruc: '80055783-2' }, data: { items: [] } },
    protocol: 'https',
    get: (nombre) => porNombre[String(nombre).toLowerCase()]
  };
}

function respuesta() {
  const res = { statusCode: null, cuerpo: null };
  res.status = (codigo) => { res.statusCode = codigo; return res; };
  res.json = (cuerpo) => { res.cuerpo = cuerpo; return res; };
  return res;
}

beforeEach(() => {
  llamadas = [];
});

test('el header Idempotency-Key llega a crearFactura', async () => {
  resultadoCrear = { tipo: 'nueva', facturaId: 'f1', correlativo: '001-002-0000008', estado: 'encolado', proceso: null, jobId: 'job-1', cdc: null };
  await crear(pedido({ 'idempotency-key': 'compras-aqui:order:123' }), respuesta());

  assert.equal(llamadas.length, 1);
  assert.deepEqual(llamadas[0][1], { claveIdempotencia: 'compras-aqui:order:123' });
});

test('clave repetida: 200 con la factura existente y el mismo shape de data', async () => {
  resultadoCrear = {
    tipo: 'idempotente',
    facturaId: 'f7',
    correlativo: '001-002-0000007',
    estado: 'aceptado',
    proceso: 'Completado',
    cdc: '01800557832001002000000712026092811234567895'
  };
  const res = respuesta();
  await crear(pedido({ 'Idempotency-Key': 'compras-aqui:order:123' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.cuerpo.success, true);
  assert.match(res.cuerpo.message, /ya existía/);
  assert.deepEqual(res.cuerpo.data, {
    facturaId: 'f7',
    correlativo: '001-002-0000007',
    estado: 'aceptado',
    proceso: 'Completado',
    cdc: '01800557832001002000000712026092811234567895',
    xmlLink: 'https://dte.example/api/invoices/f7/download-xml',
    kudeLink: 'https://dte.example/api/invoices/f7/download-pdf',
    urls: { estado: '/api/factura/estado/f7', consulta: '/api/invoices/f7' },
    idempotente: true
  });
});

test('sin header: se llama como siempre y una factura nueva sigue respondiendo 202', async () => {
  resultadoCrear = { tipo: 'nueva', facturaId: 'f8', correlativo: '001-002-0000008', estado: 'encolado', proceso: null, jobId: 'job-8', cdc: null };
  const res = respuesta();
  await crear(pedido(), res);

  assert.equal(llamadas[0][1].claveIdempotencia, undefined);
  assert.equal(res.statusCode, 202);
  assert.equal(res.cuerpo.data.jobId, 'job-8');
  assert.equal('idempotente' in res.cuerpo.data, false);
});

test('una clave inválida responde el 400 con su código', async () => {
  resultadoCrear = Object.assign(new Error('El header Idempotency-Key admite hasta 200 caracteres (llegaron 201)'), {
    statusCode: 400, errorCode: 'IDEMPOTENCY_KEY_INVALIDA'
  });
  const res = respuesta();
  await crear(pedido({ 'Idempotency-Key': 'x'.repeat(201) }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.cuerpo.error, 'IDEMPOTENCY_KEY_INVALIDA');
});
