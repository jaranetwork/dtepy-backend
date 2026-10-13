/**
 * Redondeo SEDECO (Resolución 347/2014 de la Secretaría de Defensa del
 * Consumidor): los montos se redondean a múltiplos de 50 guaraníes porque no
 * hay monedas más chicas. Es una regla para el pago en EFECTIVO.
 *
 * xmlgen lo trae activado por defecto (config.redondeoSedeco = true) y lo
 * aplica a TODO documento en PYG: el total no múltiplo de 50 salía con
 * dTotGralOpe hasta 49 Gs MENOR que lo cobrado (la diferencia en dRedon),
 * aunque se hubiera pagado con tarjeta o transferencia por el monto exacto.
 *
 * Regla: se redondea solo si la operación es en PYG y TODAS las entregas de la
 * condición de pago (data.condicion.entregas, al menos una) son en efectivo.
 * Sin entregas no se redondea: no hay pago en efectivo declarado (es el caso
 * de las notas de crédito y débito, que no llevan condición de pago).
 */

// Catálogo de formas de pago de SIFEN (iTiPago): 1 = Efectivo.
const TIPO_PAGO_EFECTIVO = 1;

/**
 * @param {object} data  el `data` del payload (moneda + condicion.entregas)
 * @returns {boolean}    valor para config.redondeoSedeco de xmlgen
 */
function aplicaRedondeoSedeco(data) {
  // Sin moneda xmlgen asume PYG: acá también.
  const moneda = String(data?.moneda || 'PYG').trim().toUpperCase();
  if (moneda !== 'PYG') return false;

  const entregas = data?.condicion?.entregas;
  if (!Array.isArray(entregas) || entregas.length === 0) return false;

  return entregas.every((entrega) => Number(entrega?.tipo) === TIPO_PAGO_EFECTIVO);
}

module.exports = { TIPO_PAGO_EFECTIVO, aplicaRedondeoSedeco };
