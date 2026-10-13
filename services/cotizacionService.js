/**
 * Cotizaciones de moneda extranjera declaradas por el usuario.
 *
 * Regla de negocio (definida por el usuario del sistema): la cotización la
 * declara él — nunca se inventa ni se consulta a una fuente externa. Si una
 * emisión en moneda extranjera no trae `data.cambio` y tampoco hay cotización
 * declarada vigente, la factura se rechaza con COTIZACION_FALTANTE.
 */

const Cotizacion = require('../models/Cotizacion');

// Monedas del catálogo de xmlgen (PYG queda excluida: no necesita cotización)
const constantes = require('facturacionelectronicapy-xmlgen/dist/services/constants.service.js').default;

function monedasValidas() {
  return constantes.monedas.filter((m) => m.codigo !== 'PYG').map((m) => m.codigo);
}

function validarMoneda(moneda) {
  const codigo = String(moneda || '').toUpperCase().trim();
  if (!monedasValidas().includes(codigo)) {
    const error = new Error(`Moneda '${moneda}' inválida. Valores: ${monedasValidas().join(', ')}`);
    error.statusCode = 400;
    error.errorCode = 'MONEDA_INVALIDA';
    throw error;
  }
  return codigo;
}

/**
 * Declara una cotización nueva (queda como vigente para esa empresa+moneda).
 */
async function declarar({ empresaId, moneda, valor, declaradaPor }) {
  const codigo = validarMoneda(moneda);

  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) {
    const error = new Error('El valor de la cotización debe ser un número mayor a 0 (guaraníes por unidad)');
    error.statusCode = 400;
    error.errorCode = 'COTIZACION_INVALIDA';
    throw error;
  }

  const cotizacion = new Cotizacion({ empresaId, moneda: codigo, valor: numero, declaradaPor });
  await cotizacion.save();
  return cotizacion;
}

/**
 * Cotización vigente (la última declarada) de una moneda para una empresa.
 * @returns {Promise<object|null>}
 */
async function vigente(empresaId, moneda) {
  return Cotizacion.findOne({ empresaId, moneda: String(moneda).toUpperCase() })
    .sort({ createdAt: -1 });
}

/**
 * Vigentes de todas las monedas de un conjunto de empresas (una por empresa+moneda).
 */
async function vigentes(empresaIds) {
  const filtro = empresaIds ? { empresaId: { $in: empresaIds } } : {};
  return Cotizacion.aggregate([
    { $match: filtro },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: { empresaId: '$empresaId', moneda: '$moneda' },
        cotizacionId: { $first: '$_id' },
        valor: { $first: '$valor' },
        declaradaPor: { $first: '$declaradaPor' },
        declaradaEn: { $first: '$createdAt' },
        fuente: { $first: '$fuente' }
      }
    },
    {
      $project: {
        _id: 0,
        empresaId: '$_id.empresaId',
        moneda: '$_id.moneda',
        cotizacionId: 1,
        valor: 1,
        declaradaPor: 1,
        declaradaEn: 1,
        fuente: 1
      }
    },
    { $sort: { moneda: 1 } }
  ]);
}

/**
 * Historial de declaraciones (más recientes primero).
 */
async function historial({ empresaIds, moneda, limite = 50 }) {
  const filtro = {};
  if (empresaIds) filtro.empresaId = { $in: empresaIds };
  if (moneda) filtro.moneda = String(moneda).toUpperCase();
  return Cotizacion.find(filtro)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limite) || 50, 200))
    .populate('empresaId', 'ruc nombreFantasia');
}

/**
 * Completa el cambio de una emisión en moneda extranjera con la cotización
 * declarada vigente, cuando la integración no lo manda.
 *
 * - moneda PYG o ausente: no hace nada.
 * - condicionTipoCambio 2 (por ítem): no toca nada, los cambios van por ítem.
 * - data.cambio ya presente (> 0): se respeta el de la integración.
 * - sin cambio y sin cotización declarada: COTIZACION_FALTANTE (400).
 *
 * También completa el `cambio` de las entregas de la condición de pago que
 * estén en la misma moneda de la operación y no lo traigan (xmlgen lo exige).
 *
 * Muta `datos` en el lugar. Devuelve un resumen para el log.
 */
async function resolverCambioParaEmision(datos, empresaId) {
  if (!datos || typeof datos !== 'object') return { aplicado: false };

  const moneda = String(datos.moneda || 'PYG').toUpperCase();
  if (moneda === 'PYG') return { aplicado: false };
  if (Number(datos.condicionTipoCambio) === 2) return { aplicado: false, motivo: 'cambio por ítem' };

  let cambio = Number(datos.cambio);
  let origen = 'integracion';

  if (!Number.isFinite(cambio) || cambio <= 0) {
    const declarada = await vigente(empresaId, moneda);
    if (!declarada) {
      const error = new Error(
        `No hay cotización declarada para ${moneda}. Declarala en la sección Cotizaciones ` +
        `(o POST /api/cotizaciones), o mandá data.cambio en el payload.`
      );
      error.statusCode = 400;
      error.errorCode = 'COTIZACION_FALTANTE';
      throw error;
    }
    cambio = declarada.valor;
    origen = 'declarada';
    datos.cambio = cambio;
    datos.condicionTipoCambio = 1;
  }

  // Entregas en la moneda de la operación sin su cambio: xmlgen las rechaza
  const entregas = datos.condicion?.entregas;
  if (Array.isArray(entregas)) {
    for (const entrega of entregas) {
      const monedaEntrega = String(entrega?.moneda || '').toUpperCase();
      const cambioEntrega = Number(entrega?.cambio);
      if (monedaEntrega === moneda && (!Number.isFinite(cambioEntrega) || cambioEntrega <= 0)) {
        entrega.cambio = cambio;
      }
    }
  }

  return { aplicado: true, moneda, cambio, origen };
}

module.exports = {
  declarar,
  vigente,
  vigentes,
  historial,
  resolverCambioParaEmision,
  monedasValidas
};
