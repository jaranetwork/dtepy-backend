/**
 * Procesador 'generar-factura' del worker (node --test, sin Mongo ni Redis).
 *
 * El worker, al requerirse, carga .env, conecta a Mongo, registra sus
 * procesadores en las colas de Bull y arranca un monitor cada 60 s: todo eso
 * se reemplaza para ejecutar el procesador real con dobles.
 *
 * El caso: si el procesamiento fallaba (xmlgen, firma, QR...), la factura
 * quedaba en 'error' pero nadie avisaba, y la integración la veía "encolada"
 * para siempre. Y el contrapunto: un fallo DESPUÉS de que SET respondiera no
 * puede convertir en 'error' (ni avisar como tal) un documento que ya existe.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

function stub(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

// El aviso falso nunca termina (así se nota si el worker lo espera): con
// límite, un worker que lo esperara hace fallar el test en vez de colgarlo.
const LIMITE = { timeout: 5000 };

console.log = () => {};
console.warn = () => {};
console.error = () => {};

stub('dotenv', { config: () => ({}) });  // no se leen las credenciales de .env
mongoose.connect = async () => {};

const procesadores = {};
let kudeEncolados = [];
stub('../queues/facturaQueue', {
  facturaQueue: {
    process: (nombre, fn) => { procesadores[nombre] = fn; },
    getFailedCount: async () => 0,
    close: async () => {}
  },
  kudeQueue: {
    process: (nombre, fn) => { procesadores[nombre] = fn; },
    add: async (nombre, datos) => { kudeEncolados.push(datos); },
    close: async () => {}
  },
  describirRedis: () => 'redis://stub'
});

let procesar = async () => { throw new Error('procesarFactura sin configurar en el test'); };
stub('../services/procesarFacturaService', {
  procesarFactura: (...args) => procesar(...args),
  generarKUDE: async () => null
});

let factura = null;
stub('../models/Invoice', { findById: async () => factura });

let bitacora = [];
stub('../models/OperationLog', { create: async (registro) => { bitacora.push(registro); return registro; } });

let liberados = [];
let liberar = async (id) => { liberados.push(id); return null; };
stub('../services/numeracionService', {
  ESTADOS_NUNCA_EN_SET: ['rechazado', 'error'],
  liberarNumeroRechazado: (id) => liberar(id)
});

let notificaciones = [];
stub('../services/notificacionService', {
  notificarFacturaFinal: (id) => {
    // Qué había persistido en el momento del aviso.
    notificaciones.push({
      id,
      estado: factura?.estadoSifen,
      guardados: factura?.guardados.length,
      registrosBitacora: bitacora.length
    });
    // Nunca termina: si el worker la esperara, el procesador no terminaría.
    return new Promise(() => {});
  }
});

// El monitor de jobs fallidos (setInterval de 60 s) mantendría vivo el proceso del test.
const setIntervalOriginal = global.setInterval;
global.setInterval = (fn, ms, ...args) => setIntervalOriginal(fn, ms, ...args).unref();
require('../workers/facturaWorker');
global.setInterval = setIntervalOriginal;

const generarFactura = procesadores['generar-factura'];

function nuevaFactura() {
  return {
    _id: new mongoose.Types.ObjectId(),
    estadoSifen: 'encolado',
    proceso: null,
    fechaCreacion: new Date(),
    empresaId: new mongoose.Types.ObjectId(),
    datosFactura: { data: {} },
    guardados: [],
    async save() {
      this.guardados.push({ estadoSifen: this.estadoSifen, proceso: this.proceso, mensajeRetorno: this.mensajeRetorno });
      return this;
    }
  };
}

const job = (facturaId, progress = async () => {}) => ({
  data: { facturaId: String(facturaId), datosFactura: { data: {} }, empresaId: 'empresa-1' },
  progress
});

/** job.progress que falla (Redis caído) al reportar ese porcentaje. */
const redisCaeEn = (porcentaje) => async (n) => {
  if (n === porcentaje) throw new Error('Connection is closed.');
};

const aprobada = {
  success: true,
  estado: 'aceptado',
  estadoVisual: 'aceptado',
  cdc: '01800557832001002000000122026092811234567890',
  codigoRetorno: '0260',
  mensajeRetorno: 'Autorización del DE satisfactoria',
  digestValue: 'digest',
  fechaProceso: '2026-09-28T10:00:05-03:00',
  xmlPath: null,
  xmlContent: '<rDE/>',
  rutaArchivo: null,
  correlativo: '001-002-0000001'
};

beforeEach(() => {
  factura = null;
  bitacora = [];
  liberados = [];
  liberar = async (id) => { liberados.push(id); return null; };
  notificaciones = [];
  kudeEncolados = [];
});

test('el worker registró el procesador de facturas', () => {
  assert.equal(typeof generarFactura, 'function');
});

test('si el procesamiento falla: la factura queda en error y la integración se entera por el webhook', LIMITE, async () => {
  factura = nuevaFactura();
  procesar = async () => { throw new Error('Debe completar el Punto de emisión en data.punto'); };

  // El error original sigue llegando a Bull (el job queda como fallido).
  await assert.rejects(generarFactura(job(factura._id)), /Punto de emisión/);

  assert.equal(factura.estadoSifen, 'error');
  assert.equal(factura.proceso, 'No completado');
  assert.match(factura.mensajeRetorno, /Punto de emisión/);

  assert.equal(notificaciones.length, 1);
  assert.equal(notificaciones[0].id, factura._id.toString());
  // El aviso sale con el estado final ya guardado y el error en la bitácora.
  assert.equal(notificaciones[0].estado, 'error');
  assert.equal(notificaciones[0].guardados, 2, "guardada como 'procesando' y después como 'error'");
  assert.equal(factura.guardados.at(-1).estadoSifen, 'error');
  assert.equal(notificaciones[0].registrosBitacora, 1);
  assert.equal(bitacora[0].tipoOperacion, 'error');

  // No sabemos si el documento llegó a SET: el número no se libera.
  assert.deepEqual(liberados, []);
});

test('si la factura no existe no hay a quién avisar', LIMITE, async () => {
  factura = null;
  await assert.rejects(generarFactura(job(new mongoose.Types.ObjectId())), /no encontrada/);
  assert.equal(notificaciones.length, 0);
});

test('el camino exitoso sigue avisando una sola vez', LIMITE, async () => {
  factura = nuevaFactura();
  procesar = async () => ({ ...aprobada });

  const resultado = await generarFactura(job(factura._id));

  assert.equal(resultado.estado, 'aceptado');
  assert.equal(notificaciones.length, 1);
  assert.equal(notificaciones[0].estado, 'aceptado');
  assert.deepEqual(liberados, []);
  assert.equal(kudeEncolados.length, 1);
});

test('un rechazo de SET libera el número y avisa una sola vez (sin pasar por el catch)', LIMITE, async () => {
  factura = nuevaFactura();
  procesar = async () => ({
    success: true,
    estado: 'rechazado',
    estadoVisual: 'rechazado',
    cdc: '01800557832001002000000122026092811234567890',
    codigoRetorno: '1001',
    mensajeRetorno: 'CDC duplicado',
    xmlPath: null,
    correlativo: '001-002-0000001'
  });

  await generarFactura(job(factura._id));

  assert.equal(factura.estadoSifen, 'rechazado');
  assert.deepEqual(liberados, [String(factura._id)]);
  assert.equal(notificaciones.length, 1);
  assert.equal(notificaciones[0].estado, 'rechazado');
});

// ── Fallos después de la respuesta de SET ───────────────────────────
// El documento ya existe allá: el catch no lo pisa con 'error' ni avisa
// 'error' (la integración lo reemitiría con otro número: 'error' libera la
// Idempotency-Key).

test('SET aprobó y Redis falla al reportar el 100 %: no se pisa el veredicto ni sale un segundo aviso', LIMITE, async () => {
  factura = nuevaFactura();
  procesar = async () => ({ ...aprobada });

  await assert.rejects(generarFactura(job(factura._id, redisCaeEn(100))), /Connection is closed/);

  assert.equal(factura.estadoSifen, 'aceptado');
  assert.equal(factura.guardados.at(-1).estadoSifen, 'aceptado');
  assert.deepEqual(notificaciones.map((n) => n.estado), ['aceptado'], 'solo el aviso del camino exitoso');
  const registro = bitacora.at(-1);
  assert.equal(registro.estado, 'warning');
  assert.match(registro.descripcion, /después de la respuesta de SET \(aceptado\)/);
});

test('SET aprobó y Redis falla antes de guardar el resultado: no queda como error ni se avisa error', LIMITE, async () => {
  factura = nuevaFactura();
  procesar = async () => ({ ...aprobada });

  await assert.rejects(generarFactura(job(factura._id, redisCaeEn(95))), /Connection is closed/);

  assert.notEqual(factura.estadoSifen, 'error');
  assert.equal(factura.guardados.some((g) => g.estadoSifen === 'error'), false);
  assert.equal(notificaciones.length, 0);
});

test('quedó en un lote (encolado) y falla algo después: tampoco se marca error', LIMITE, async () => {
  factura = nuevaFactura();
  procesar = async () => ({ ...aprobada, estado: 'encolado', estadoVisual: 'observado', codigoRetorno: null });

  await assert.rejects(generarFactura(job(factura._id, redisCaeEn(95))), /Connection is closed/);

  assert.equal(factura.guardados.some((g) => g.estadoSifen === 'error'), false);
  assert.equal(notificaciones.length, 0);
});

test('SET rechazó y falla la liberación del número: queda en error y se avisa una sola vez', LIMITE, async () => {
  factura = nuevaFactura();
  procesar = async () => ({ ...aprobada, estado: 'rechazado', estadoVisual: 'rechazado', codigoRetorno: '1001' });
  liberar = async () => { throw new Error('Mongo no responde'); };

  await assert.rejects(generarFactura(job(factura._id)), /Mongo no responde/);

  assert.equal(factura.estadoSifen, 'error');
  assert.deepEqual(notificaciones.map((n) => n.estado), ['error']);
});
