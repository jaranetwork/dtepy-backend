/**
 * Tests de la cotización automática (node --test, sin DB ni red).
 *
 * Cubren las reglas puras: el parseo del feed de la SET/DNIT, qué valor del par
 * se declara según la configuración, y cuándo una moneda ya está resuelta.
 * Esta última es la que fallaba: mirando solo la fecha, cambiar "venta" por
 * "compra" no aplicaba nada hasta que la fuente publicara un día nuevo.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const proveedores = require('../services/cotizacionProveedores');
const {
  yaResuelta,
  esManual,
  valorSegunTipo,
  sumarDias,
  fechaObjetivo,
  hoyAsuncion
} = require('../services/cotizacionSyncService');

/** Feed real del 2026-08-31 (data/latest.json de sistemasaguila). */
const FEED = {
  '2026-08-31': {
    usd: { purchase: 5892.65, sale: 5912.9 },
    brl: { purchase: 1136.92, sale: 1141.02 },
    arp: { purchase: 3.9, sale: 3.92 },
    jpy: { purchase: 36.89, sale: 37.02 },
    eur: { purchase: 6843.73, sale: 6867.24 },
    gbp: { purchase: 7985.72, sale: 8013.75 }
  }
};

const aguila = proveedores.obtener('sistemaaguila');
const automatica = (fechaCotizacion, tipoValor) => ({ fuente: { fechaCotizacion, tipoValor } });
const manual = { valor: 7000, declaradaPor: { tipo: 'usuario' } };

/* ── Proveedor ─────────────────────────────────────────────────────── */

test('el feed de la SET se parsea a pares compra/venta, con ARS donde el feed dice "arp"', () => {
  const { fecha, valores } = aguila.parsear(FEED);
  assert.equal(fecha, '2026-08-31');
  assert.deepEqual(valores.USD, { compra: 5892.65, venta: 5912.9 });
  assert.deepEqual(valores.ARS, { compra: 3.9, venta: 3.92 });
  assert.equal(valores.arp, undefined);
  assert.deepEqual(Object.keys(valores).sort(), ['ARS', 'BRL', 'EUR', 'GBP', 'JPY', 'USD']);
});

test('el proveedor solo ofrece las monedas que publica y ninguna URL configurable', () => {
  assert.deepEqual(aguila.monedas, ['USD', 'BRL', 'ARS', 'JPY', 'EUR', 'GBP']);
  assert.deepEqual(aguila.hostsPermitidos, ['raw.githubusercontent.com', 'cdn.jsdelivr.net']);
  for (const url of aguila.urls) {
    assert.ok(aguila.hostsPermitidos.includes(new URL(url).hostname), url);
  }
});

test('un feed roto no se aplica a medias: lanza', () => {
  assert.throws(() => aguila.parsear(null));
  assert.throws(() => aguila.parsear([FEED]));
  assert.throws(() => aguila.parsear({ '2026-08-31': {}, '2026-09-01': {} }));
  assert.throws(() => aguila.parsear({ '2026-08-31': { usd: { purchase: 0, sale: -1 } } }));
});

test('el rango de cordura descarta valores imposibles', () => {
  assert.equal(proveedores.esValorRazonable(5892.65), true);
  assert.equal(proveedores.esValorRazonable(36.89), true);   // JPY
  assert.equal(proveedores.esValorRazonable(0), false);
  assert.equal(proveedores.esValorRazonable(2_000_000), false);
  assert.equal(proveedores.esValorRazonable(NaN), false);
});

/* ── Qué valor del par se declara ──────────────────────────────────── */

test('venta, compra y promedio salen del mismo par', () => {
  const usd = aguila.parsear(FEED).valores.USD;
  assert.equal(valorSegunTipo(usd, 'venta'), 5912.9);
  assert.equal(valorSegunTipo(usd, 'compra'), 5892.65);
  assert.equal(valorSegunTipo(usd, 'promedio'), (5892.65 + 5912.9) / 2);
  assert.equal(valorSegunTipo(usd, undefined), 5912.9, 'sin tipo, venta');
});

/* ── Idempotencia por fecha Y reglas ───────────────────────────────── */

test('la misma fecha con el mismo tipo de valor ya está resuelta', () => {
  assert.equal(yaResuelta(automatica('2026-08-31', 'venta'), '2026-08-31', 'venta'), true);
});

test('cambiar venta por compra deja la moneda pendiente (el bug)', () => {
  assert.equal(yaResuelta(automatica('2026-08-31', 'venta'), '2026-08-31', 'compra'), false);
  assert.equal(yaResuelta(automatica('2026-08-31', 'compra'), '2026-08-31', 'venta'), false);
  assert.equal(yaResuelta(automatica('2026-08-31', 'venta'), '2026-08-31', 'promedio'), false);
});

test('una fecha más nueva que la del feed también resuelve (finde: la fuente repite la del viernes)', () => {
  assert.equal(yaResuelta(automatica('2026-09-01', 'venta'), '2026-08-31', 'venta'), true);
});

test('una fecha más vieja no resuelve', () => {
  assert.equal(yaResuelta(automatica('2026-08-30', 'venta'), '2026-08-31', 'venta'), false);
});

test('una declaración vieja sin tipo de valor se recalcula una vez', () => {
  assert.equal(yaResuelta({ fuente: { fechaCotizacion: '2026-08-31' } }, '2026-08-31', 'venta'), false);
});

test('una cotización manual nunca resuelve por sí sola (la cubre la guarda de "a mano hoy")', () => {
  assert.equal(yaResuelta(manual, '2026-08-31', 'venta'), false);
  assert.equal(yaResuelta(null, '2026-08-31', 'venta'), false);
  assert.equal(esManual(manual), true);
  assert.equal(esManual(automatica('2026-08-31', 'venta')), false);
  assert.equal(esManual(null), false);
});

/* ── Fechas ────────────────────────────────────────────────────────── */

test('sumarDias no se corre de mes ni de año, y no depende de la TZ del server', () => {
  assert.equal(sumarDias('2026-09-01', -1), '2026-08-31');
  assert.equal(sumarDias('2026-01-01', -1), '2025-12-31');
  assert.equal(sumarDias('2028-02-28', 1), '2028-02-29');   // bisiesto
});

test('la que rige hoy es la publicada ayer, hora de Asunción', () => {
  assert.equal(fechaObjetivo(), sumarDias(hoyAsuncion(), -1));
  assert.match(hoyAsuncion(), /^\d{4}-\d{2}-\d{2}$/);
});
