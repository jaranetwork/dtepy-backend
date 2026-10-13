const Invoice = require('../models/Invoice');
const Empresa = require('../models/Empresa');
const SecuenciaFactura = require('../models/SecuenciaFactura');

/**
 * Numeración correlativa y su relación con lo que SET realmente registró.
 *
 * Un DTE rechazado NO existe en SET (consultarlo devuelve 0420), así que su
 * número sigue libre y reusarlo es lo correcto: si no, cada rechazo deja un
 * hueco en la numeración que después hay que inutilizar ante SET.
 */

// Estados en los que SET no tiene registro del documento.
const ESTADOS_NUNCA_EN_SET = ['rechazado', 'error'];

/**
 * Clave de la secuencia a la que pertenece un documento ya emitido.
 * El correlativo es la fuente de la verdad para establecimiento/punto/número:
 * es lo que realmente se firmó, aunque después alguien toque el payload.
 *
 * @returns {{clave: object, numero: number}|null} null si no se puede derivar
 */
function claveSecuenciaDeFactura(invoice, empresa) {
  const partes = String(invoice?.correlativo || '').split('-');
  if (partes.length !== 3) return null;

  const [establecimiento, punto, numeroTexto] = partes;
  const numero = Number(numeroTexto);
  if (!Number.isInteger(numero) || numero <= 0) return null;

  const data = invoice.datosFactura?.data || invoice.datosFactura || {};
  const tipoDocumento = Number(data.tipoDocumento || 1);
  const timbrado = String(
    invoice.datosFactura?.param?.timbradoNumero ||
    data.timbrado ||
    empresa?.configuracionSifen?.timbrado ||
    ''
  );

  return {
    clave: { empresaId: invoice.empresaId, timbrado, tipoDocumento, establecimiento, punto },
    numero
  };
}

/**
 * Devuelve el número al contador cuando SET rechazó el documento.
 *
 * El `$inc: -1` va condicionado a que la secuencia siga en ese número: si
 * mientras tanto se emitió otro documento, el contador no se toca (el hueco
 * ya quedó y bajarlo repartiría un número ocupado). Esa condición es también
 * lo que hace la operación segura ante concurrencia.
 *
 * @param {string|object} invoiceId
 * @returns {Promise<number|null>} el número liberado, o null si no se liberó
 */
async function liberarNumeroRechazado(invoiceId) {
  const invoice = await Invoice.findById(invoiceId)
    .select('empresaId correlativo estadoSifen datosFactura');
  if (!invoice || !ESTADOS_NUNCA_EN_SET.includes(invoice.estadoSifen)) return null;

  const empresa = await Empresa.findById(invoice.empresaId).select('configuracionSifen.timbrado');
  const derivado = claveSecuenciaDeFactura(invoice, empresa);
  if (!derivado) return null;

  const liberada = await SecuenciaFactura.findOneAndUpdate(
    { ...derivado.clave, ultimoNumero: derivado.numero },
    { $inc: { ultimoNumero: -1 } }
  );
  if (!liberada) return null;

  console.log(`↩️  Número ${invoice.correlativo} liberado: SET rechazó el documento, no existe allá`);
  return derivado.numero;
}

module.exports = { ESTADOS_NUNCA_EN_SET, claveSecuenciaDeFactura, liberarNumeroRechazado };
