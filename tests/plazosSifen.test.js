const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluarPlazoEmision,
  HORAS_EMISION_RETROACTIVA,
  HORAS_EMISION_ADELANTADA
} = require('../utils/plazosSifen');

const ahora = new Date('2026-09-02T16:49:05-03:00').getTime();
const horasAtras = (h) => new Date(ahora - h * 3600000).toISOString();

test('la NC del caso real (emitida 31/08 09:00, enviada 02/09 16:49) entra holgada', () => {
  const r = evaluarPlazoEmision('2026-08-31T09:00:00-03:00', ahora);
  assert.equal(r.dentro, true);
  assert.ok(r.horasDesfase > 55 && r.horasDesfase < 56, `horas: ${r.horasDesfase}`);
});

test('tres días atrás no tiene nada de especial: el límite son 30 días', () => {
  for (const horas of [72, 100, 240, HORAS_EMISION_RETROACTIVA]) {
    assert.equal(evaluarPlazoEmision(horasAtras(horas), ahora).dentro, true, `${horas} h atrás`);
  }
});

test(`pasadas ${HORAS_EMISION_RETROACTIVA} h hacia atrás se corta (1150)`, () => {
  const r = evaluarPlazoEmision(horasAtras(HORAS_EMISION_RETROACTIVA + 1), ahora);
  assert.equal(r.dentro, false);
  assert.equal(r.motivo, 'retroactiva');
  assert.equal(r.horasLimite, HORAS_EMISION_RETROACTIVA);
});

test(`la fecha adelantada se acepta hasta ${HORAS_EMISION_ADELANTADA} h (1151)`, () => {
  assert.equal(evaluarPlazoEmision(horasAtras(-HORAS_EMISION_ADELANTADA), ahora).dentro, true);
  const r = evaluarPlazoEmision(horasAtras(-(HORAS_EMISION_ADELANTADA + 1)), ahora);
  assert.equal(r.dentro, false);
  assert.equal(r.motivo, 'adelantada');
});

test('fecha ilegible o ausente no bloquea (decide SET)', () => {
  assert.equal(evaluarPlazoEmision('no-es-fecha', ahora).dentro, true);
  assert.equal(evaluarPlazoEmision(null, ahora).dentro, true);
});
