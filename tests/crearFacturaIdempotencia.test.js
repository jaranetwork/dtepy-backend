/**
 * Idempotency-Key en crearFactura (node --test, sin Mongo ni Redis).
 *
 * El caso real: la respuesta del POST /api/facturar/crear se pierde por un
 * timeout, la integración reintenta y antes se creaba OTRA factura con otro
 * número. Los modelos de mongoose y las colas se reemplazan por dobles en
 * memoria; facturaService, empresaService y numeracionService corren reales.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function stub(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

// crearFactura loguea la numeración y las repeticiones; acá sobran.
console.log = () => {};

// ── Base en memoria ───────────────────────────────────────────────────
let facturas = [];     // la colección invoices
let consultas = [];    // filtros de Invoice.findOne, para ver qué se buscó
let numeraciones = 0;  // llamadas a la secuencia (asignación de número)
let ultimoNumero = 0;  // contador de la secuencia
let encolados = [];    // jobs de generación
let secuencia = 0;

function coincide(doc, filtro) {
  return Object.entries(filtro).every(([campo, condicion]) => {
    const valor = doc[campo];
    if (condicion && typeof condicion === 'object') {
      if (Array.isArray(condicion.$in)) return condicion.$in.includes(valor);
      if (Array.isArray(condicion.$nin)) return !condicion.$nin.includes(valor);
    }
    return valor !== undefined && String(valor) === String(condicion);
  });
}

/** Imita un query de mongoose: encadenable (sort/select) y "thenable". */
function consulta(resolver) {
  let orden = null;
  const query = {
    sort(o) { orden = o; return query; },
    select() { return query; },
    then(ok, error) { return Promise.resolve().then(() => resolver(orden)).then(ok, error); }
  };
  return query;
}

class FacturaFalsa {
  constructor(campos) {
    Object.assign(this, campos);
    this._id = this._id || `factura-${++secuencia}`;
    this.createdAt = this.createdAt || new Date();
  }

  async save() {
    if (!facturas.includes(this)) facturas.push(this);
    return this;
  }

  static findOne(filtro) {
    consultas.push(filtro);
    return consulta((orden) => {
      const candidatas = facturas.filter((f) => coincide(f, filtro));
      // Sin sort devuelve en orden de inserción (la más vieja primero), como
      // Mongo sin índice: así se nota si el servicio se olvida de ordenar.
      if (orden?.createdAt === -1) candidatas.sort((a, b) => b.createdAt - a.createdAt);
      return candidatas[0] || null;
    });
  }

  static exists(filtro) {
    return consulta(() => (facturas.some((f) => coincide(f, filtro)) ? { _id: 'existe' } : null));
  }
}

const empresa = {
  _id: 'empresa-kingston',
  ruc: '80055783-2',
  activo: true,
  nombreFantasia: 'Kingston Center',
  tieneCertificadoValido: () => true,
  configuracionSifen: { timbrado: '18646542', establecimiento: '001', puntoExpedicion: '002', validacionReceptor: 'off' },
  establecimientos: [{ codigo: '001' }]
};

stub('../queues/facturaQueue', {
  facturaQueue: { add: async (nombre, datos) => { encolados.push(datos); return { id: `job-${encolados.length}` }; } },
  kudeQueue: { add: async () => ({ id: 'kude-1' }) }
});
stub('../models/Invoice', FacturaFalsa);
stub('../models/OperationLog', { create: async () => ({}) });
stub('../models/SecuenciaFactura', {
  findOneAndUpdate: async () => { numeraciones++; ultimoNumero++; return { ultimoNumero }; }
});
stub('../models/Empresa', {
  findOne: async ({ ruc }) => (ruc === empresa.ruc ? empresa : null),
  findById: async () => empresa
});

const { crearFactura, generarFacturaHash, normalizarClaveIdempotencia } = require('../services/facturaService');

const CLAVE = 'compras-aqui:order:8f1c2d3e-0000-4000-8000-000000000001';
const CDC = '01800557832001002000000712026092811234567895';

/** Lo que manda la tienda: sin número (lo asigna el sistema), pago con tarjeta. */
function pedidoTienda() {
  return {
    param: { ruc: '80055783-2' },
    data: {
      tipoDocumento: 1,
      tipoEmision: 1,
      moneda: 'PYG',
      cliente: { contribuyente: false, tipoOperacion: 2, pais: 'PRY', documentoTipo: 1, documentoNumero: '4123456', razonSocial: 'Juan Perez' },
      condicion: { tipo: 1, entregas: [{ tipo: 3, monto: '200000', moneda: 'PYG' }] },
      items: [{ descripcion: 'Notebook', cantidad: 2, precioUnitario: 100000, ivaTipo: 1, ivaBase: 100, iva: 10 }]
    }
  };
}

/** Una factura que ya está en la base (emitida por un pedido anterior). */
function sembrar(campos) {
  const factura = new FacturaFalsa({
    empresaId: empresa._id,
    rucEmpresa: empresa.ruc,
    de: 'Factura electrónica',
    facturaHash: `hash-${campos.correlativo}`,
    ...campos
  });
  facturas.push(factura);
  return factura;
}

beforeEach(() => {
  facturas = [];
  consultas = [];
  numeraciones = 0;
  ultimoNumero = 7;  // la próxima factura es la 0000008
  encolados = [];
});

test('misma clave con una factura previa aceptada: devuelve esa, sin numerar ni encolar', async () => {
  const previa = sembrar({
    correlativo: '001-002-0000007', estadoSifen: 'aceptado', proceso: 'Completado', cdc: CDC, claveIdempotencia: CLAVE
  });

  const resultado = await crearFactura(pedidoTienda(), { claveIdempotencia: CLAVE });

  assert.deepEqual(resultado, {
    tipo: 'idempotente',
    facturaId: previa._id,
    correlativo: '001-002-0000007',
    estado: 'aceptado',
    proceso: 'Completado',
    cdc: CDC
  });
  assert.equal(numeraciones, 0, 'no se pidió número');
  assert.equal(encolados.length, 0, 'no se encoló nada');
  assert.equal(facturas.length, 1, 'no se creó otra factura');
});

test('misma clave con una factura previa todavía en curso (encolada, procesando, enviada) u observada: también la devuelve', async () => {
  for (const estadoSifen of ['encolado', 'procesando', 'enviado', 'observado']) {
    facturas = [];
    const previa = sembrar({ correlativo: '001-002-0000007', estadoSifen, proceso: null, claveIdempotencia: CLAVE });

    const resultado = await crearFactura(pedidoTienda(), { claveIdempotencia: CLAVE });

    assert.equal(resultado.tipo, 'idempotente', estadoSifen);
    assert.equal(resultado.facturaId, previa._id, estadoSifen);
    assert.equal(resultado.estado, estadoSifen);
    assert.equal(resultado.proceso, null);
    assert.equal(resultado.cdc, null, 'sin CDC todavía');
  }
  assert.equal(numeraciones, 0);
  assert.equal(encolados.length, 0);
});

test('con la previa rechazada, en error o cancelada la clave queda libre: se emite normalmente y la nueva guarda la clave', async () => {
  for (const estadoSifen of ['rechazado', 'error', 'cancelado']) {
    facturas = [];
    numeraciones = 0;
    encolados = [];
    ultimoNumero = 7;
    sembrar({ correlativo: '001-002-0000007', estadoSifen, cdc: estadoSifen === 'cancelado' ? CDC : null, claveIdempotencia: CLAVE });

    const resultado = await crearFactura(pedidoTienda(), { claveIdempotencia: CLAVE });

    assert.equal(resultado.tipo, 'nueva', estadoSifen);
    assert.equal(resultado.correlativo, '001-002-0000008', estadoSifen);
    assert.equal(numeraciones, 1, `${estadoSifen}: se numeró`);
    assert.equal(encolados.length, 1, `${estadoSifen}: se encoló`);
    const nueva = facturas.find((f) => f._id === resultado.facturaId);
    assert.equal(nueva.claveIdempotencia, CLAVE, `${estadoSifen}: la nueva guarda la clave`);
    assert.equal(nueva.estadoSifen, 'encolado');
  }
});

test('reintento por hash (número liberado tras un rechazo): el registro reutilizado queda con la clave', async () => {
  // SET rechazó la 0000007 y el número volvió al contador: la emisión nueva
  // toma otra vez el 7, coincide el hash y se reutiliza el mismo registro.
  const conNumero7 = pedidoTienda();
  Object.assign(conNumero7.data, { establecimiento: '001', punto: '002', numero: '0000007' });
  const rechazada = sembrar({
    correlativo: '001-002-0000007',
    estadoSifen: 'rechazado',
    facturaHash: generarFacturaHash(conNumero7, empresa)
  });
  ultimoNumero = 6;

  const resultado = await crearFactura(pedidoTienda(), { claveIdempotencia: CLAVE });

  assert.equal(resultado.tipo, 'reintento');
  assert.equal(resultado.facturaId, rechazada._id);
  assert.equal(facturas.length, 1, 'mismo registro');
  assert.equal(rechazada.claveIdempotencia, CLAVE);
  assert.equal(rechazada.estadoSifen, 'encolado');
});

test('el reintento sin clave (desde el panel) conserva la clave que tenía el registro', async () => {
  const conNumero7 = pedidoTienda();
  Object.assign(conNumero7.data, { establecimiento: '001', punto: '002', numero: '0000007' });
  const conError = sembrar({
    correlativo: '001-002-0000007',
    estadoSifen: 'error',
    claveIdempotencia: CLAVE,
    facturaHash: generarFacturaHash(conNumero7, empresa)
  });

  const resultado = await crearFactura(conNumero7);

  assert.equal(resultado.tipo, 'reintento');
  assert.equal(conError.claveIdempotencia, CLAVE);
});

test('sin clave: el comportamiento de hoy (no se busca por clave, se emite y no se guarda clave)', async () => {
  sembrar({ correlativo: '001-002-0000007', estadoSifen: 'aceptado', cdc: CDC, claveIdempotencia: CLAVE });

  for (const sinClave of [undefined, {}, { claveIdempotencia: undefined }, { claveIdempotencia: '' }, { claveIdempotencia: '   ' }]) {
    const antes = facturas.length;
    const resultado = await crearFactura(pedidoTienda(), sinClave);

    assert.equal(resultado.tipo, 'nueva');
    assert.equal(facturas.length, antes + 1);
    const nueva = facturas.find((f) => f._id === resultado.facturaId);
    assert.equal('claveIdempotencia' in nueva, false, 'la factura nueva no lleva clave');
  }
  assert.equal(consultas.some((filtro) => 'claveIdempotencia' in filtro), false, 'nunca se buscó por clave');
});

test('la clave se recorta antes de buscar y de guardar', async () => {
  const previa = sembrar({ correlativo: '001-002-0000007', estadoSifen: 'aceptado', cdc: CDC, claveIdempotencia: CLAVE });

  const resultado = await crearFactura(pedidoTienda(), { claveIdempotencia: `  ${CLAVE}\t` });

  assert.equal(resultado.tipo, 'idempotente');
  assert.equal(resultado.facturaId, previa._id);
});

test('más de 200 caracteres: 400 IDEMPOTENCY_KEY_INVALIDA, sin buscar ni numerar nada', async () => {
  await assert.rejects(
    crearFactura(pedidoTienda(), { claveIdempotencia: 'x'.repeat(201) }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.errorCode, 'IDEMPOTENCY_KEY_INVALIDA');
      assert.match(error.message, /200 caracteres/);
      return true;
    }
  );
  assert.equal(consultas.length, 0);
  assert.equal(numeraciones, 0);
  assert.equal(normalizarClaveIdempotencia('x'.repeat(200)), 'x'.repeat(200), '200 exactos pasan');
});

test('la clave es por empresa: la de otra empresa no cuenta', async () => {
  sembrar({ correlativo: '001-001-0000003', estadoSifen: 'aceptado', cdc: CDC, claveIdempotencia: CLAVE, empresaId: 'otra-empresa' });

  const resultado = await crearFactura(pedidoTienda(), { claveIdempotencia: CLAVE });

  assert.equal(resultado.tipo, 'nueva');
});

test('con varias facturas de la misma clave manda la más reciente vigente', async () => {
  // Insertadas fuera de orden a propósito: sin ordenar por fecha saldría la vieja.
  const otraVigente = sembrar({ correlativo: '001-002-0000004', estadoSifen: 'aceptado', cdc: CDC, claveIdempotencia: CLAVE, createdAt: new Date('2026-08-30T10:00:00Z') });
  // Cancelada y vuelta a emitir con la misma clave: la repetición devuelve la nueva.
  sembrar({ correlativo: '001-002-0000005', estadoSifen: 'cancelado', cdc: CDC, claveIdempotencia: CLAVE, createdAt: new Date('2026-09-01T10:00:00Z') });
  const reemitida = sembrar({ correlativo: '001-002-0000006', estadoSifen: 'aceptado', cdc: CDC, claveIdempotencia: CLAVE, createdAt: new Date('2026-09-02T10:00:00Z') });

  const resultado = await crearFactura(pedidoTienda(), { claveIdempotencia: CLAVE });
  assert.equal(resultado.facturaId, reemitida._id, 'la más reciente entre las vigentes');

  // Si la más reciente se rechazó pero una anterior sigue vigente, la clave
  // sigue tomada por la anterior: emitir otra sería un duplicado.
  reemitida.estadoSifen = 'rechazado';
  const segundo = await crearFactura(pedidoTienda(), { claveIdempotencia: CLAVE });
  assert.equal(segundo.tipo, 'idempotente');
  assert.equal(segundo.facturaId, otraVigente._id);
  assert.equal(numeraciones, 0);
});

test('la repetición contesta aunque el certificado haya vencido después del pedido original', async () => {
  sembrar({ correlativo: '001-002-0000007', estadoSifen: 'aceptado', cdc: CDC, claveIdempotencia: CLAVE });
  const original = empresa.tieneCertificadoValido;
  empresa.tieneCertificadoValido = () => false;
  try {
    const resultado = await crearFactura(pedidoTienda(), { claveIdempotencia: CLAVE });
    assert.equal(resultado.tipo, 'idempotente');

    // Una emisión nueva con el certificado vencido sigue rechazándose.
    await assert.rejects(crearFactura(pedidoTienda(), { claveIdempotencia: 'otra-clave' }), { errorCode: 'CERTIFICADO_INVALID' });
  } finally {
    empresa.tieneCertificadoValido = original;
  }
});
