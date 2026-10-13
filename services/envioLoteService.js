const LoteEnvio = require('../models/LoteEnvio');
const { generarIdSifen } = require('../utils/idSifen');
const { buscarEnRespuesta } = require('../utils/estadoSifen');

/**
 * Lee un campo de la respuesta de SET, sea XML crudo (string) u objeto
 * parseado por setapi. Ignora el prefijo de namespace.
 */
function campoRespuesta(respuesta, nombre) {
  if (respuesta && typeof respuesta === 'object') return buscarEnRespuesta(respuesta, nombre);
  const m = String(respuesta || '').match(new RegExp('<(?:\\w+:)?' + nombre + '>([\\s\\S]*?)</(?:\\w+:)?' + nombre + '>'));
  return m ? m[1].trim() : null;
}

/** Bloques de resultado por documento (gResProcLote/dProtDE) en el objeto parseado. */
function bloquesResultadoLote(respuesta, bloques = [], profundidad = 0) {
  if (respuesta === null || typeof respuesta !== 'object' || profundidad > 8) return bloques;
  for (const [clave, valor] of Object.entries(respuesta)) {
    const nombre = clave.includes(':') ? clave.split(':').pop() : clave;
    if (nombre === 'gResProcLote' || nombre === 'dProtDE') {
      if (Array.isArray(valor)) bloques.push(...valor);
      else if (valor && typeof valor === 'object') bloques.push(valor);
    } else {
      bloquesResultadoLote(valor, bloques, profundidad + 1);
    }
  }
  return bloques;
}
const Invoice = require('../models/Invoice');
const setApi = require('./setapi-wrapper');
const OperacionLog = require('../models/OperationLog');
const crypto = require('crypto');

const tiposDocumentoMap = {
  1: 'Factura electrónica',
  2: 'Factura electrónica de exportación',
  3: 'Factura electrónica de importación',
  4: 'Autofactura electrónica',
  5: 'Nota de crédito electrónica',
  6: 'Nota de débito electrónica',
  7: 'Nota de remisión electrónica',
  8: 'Comprobante de retención electrónico'
};

async function agregarFacturaALote(invoiceId, cdc, empresa, tipoDocumento) {
  const ambiente = empresa.configuracionSifen.modo;

  let lote = await LoteEnvio.findOne({
    empresaId: empresa._id,
    tipoDocumento: tipoDocumento,
    ambiente: ambiente,
    estado: 'en_espera'
  });

  if (!lote) {
    lote = new LoteEnvio({
      empresaId: empresa._id,
      tipoDocumento: tipoDocumento,
      descripcion: tiposDocumentoMap[tipoDocumento] || 'Documento electrónico',
      ambiente: ambiente,
      facturas: [],
      count: 0
    });
  }

  lote.facturas.push({
    facturaId: invoiceId,
    cdc: cdc,
    estadoIndividual: 'pendiente'
  });
  lote.count = lote.facturas.length;

  Invoice.findByIdAndUpdate(invoiceId, {
    grupoLoteId: lote._id,
    estadoSifen: 'encolado'
  }).catch(err => console.warn('⚠️ No se pudo actualizar invoice con grupoLoteId:', err.message));

  await lote.save();

  if (lote.count >= 50) {
    await enviarLote(lote._id);
  }

  return lote;
}

async function enviarLote(loteId) {
  const lote = await LoteEnvio.findById(loteId);
  if (!lote) throw new Error('Lote no encontrado');
  if (lote.estado !== 'en_espera') throw new Error(`El lote ya está en estado ${lote.estado}`);

  lote.estado = 'enviado';
  await lote.save();

  const invoiceIds = lote.facturas.map(f => f.facturaId);
  const invoices = await Invoice.find({ _id: { $in: invoiceIds } });
  const xmlMap = {};
  for (const inv of invoices) {
    xmlMap[inv._id.toString()] = inv.xmlContent;
  }

  const xmls = lote.facturas
    .map(f => xmlMap[f.facturaId.toString()])
    .filter(Boolean);

  if (xmls.length === 0) {
    lote.estado = 'error';
    await lote.save();
    throw new Error('Ninguna factura del lote tiene XML');
  }

  const Empresa = require('../models/Empresa');
  const empresa = await Empresa.findById(lote.empresaId);
  if (!empresa) throw new Error('Empresa no encontrada');

  const certificadoService = require('./certificadoService');
  const rutaCertificado = empresa.obtenerRutaCertificado();
  const contrasena = certificadoService.descifrarContrasena(empresa.certificado.contrasena);
  const idDocumento = generarIdSifen();

  let soapResponse;
  try {
    soapResponse = await setApi.recibeLote(
      idDocumento,
      xmls,
      lote.ambiente,
      rutaCertificado,
      contrasena
    );
  } catch (err) {
    lote.estado = 'error';
    await lote.save();
    throw err;
  }

  const dProtConsLote = campoRespuesta(soapResponse, 'dProtConsLote');
  const codigo = campoRespuesta(soapResponse, 'dCodRes');

  lote.dProtConsLote = dProtConsLote;
  lote.respuestaSifen = {
    codigo: codigo,
    dProtConsLote: dProtConsLote,
    raw: soapResponse
  };

  await OperacionLog.create({
    invoiceId: lote._id,
    tipoOperacion: 'envio_lote',
    descripcion: `Lote enviado - ${lote.count} facturas, dProtConsLote: ${dProtConsLote}`,
    estado: codigo === '0260' ? 'success' : 'error',
    detalle: { loteId: lote._id, dProtConsLote, codigo }
  });

  lote.estado = 'procesando';
  await lote.save();

  return lote;
}

async function consultarResultadoLote(loteId) {
  const lote = await LoteEnvio.findById(loteId);
  if (!lote) throw new Error('Lote no encontrado');
  if (lote.estado !== 'procesando' && lote.estado !== 'enviado') {
    return { lote, completado: false, mensaje: `Estado actual: ${lote.estado}` };
  }

  const Empresa = require('../models/Empresa');
  const empresa = await Empresa.findById(lote.empresaId);
  if (!empresa) throw new Error('Empresa no encontrada');

  if (!lote.dProtConsLote) {
    lote.estado = 'error';
    await lote.save();
    return { lote, completado: false, mensaje: 'Sin dProtConsLote' };
  }

  const certificadoService = require('./certificadoService');
  const rutaCertificado = empresa.obtenerRutaCertificado();
  const contrasena = certificadoService.descifrarContrasena(empresa.certificado.contrasena);
  const idDocumento = generarIdSifen();

  let soapResponse;
  try {
    // OJO: dProtConsLote puede tener 19 digitos y parseInt() lo corrompe
    // (Number.MAX_SAFE_INTEGER tiene 16): se consultaba un lote inexistente
    // (SET respondia 0360). Se pasa el string tal cual.
    soapResponse = await setApi.consultaLote(
      idDocumento,
      lote.dProtConsLote,
      lote.ambiente,
      rutaCertificado,
      contrasena
    );
  } catch (err) {
    console.warn(`⚠️ Error consultando lote ${loteId}: ${err.message}`);
    return { lote, completado: false, mensaje: err.message };
  }

  // La consulta de lote responde en dCodResLot/dMsgResLot (no dCodRes)
  const codigo = campoRespuesta(soapResponse, 'dCodResLot')
    ?? campoRespuesta(soapResponse, 'dCodRes');
  const mensajeLote = campoRespuesta(soapResponse, 'dMsgResLot')
    ?? campoRespuesta(soapResponse, 'dMsgRes');

  const bloques = (typeof soapResponse === 'string')
    ? (soapResponse.match(/<ns2:dProtDE>[\s\S]*?<\/ns2:dProtDE>/g) ||
       soapResponse.match(/<dProtDE>[\s\S]*?<\/dProtDE>/g) || [])
    : bloquesResultadoLote(soapResponse);

  if (bloques.length > 0) {
    let todosResueltos = true;
    for (let i = 0; i < bloques.length && i < lote.facturas.length; i++) {
      const bloque = bloques[i];
      const estRes = campoRespuesta(bloque, 'dEstRes');
      const msgRes = campoRespuesta(bloque, 'dMsgRes');
      const codRes = campoRespuesta(bloque, 'dCodRes');
      const cdcResp = campoRespuesta(bloque, 'dCDCGestion');
      const protAut = campoRespuesta(bloque, 'dProtAut');
      const fecProc = campoRespuesta(soapResponse, 'dFecProc');

      let estadoIndividual;
      let estadoVisual;
      if (estRes === 'Aprobado' || estRes === 'Apobado') {
        estadoIndividual = 'aceptado';
        estadoVisual = 'aceptado';
      } else if (estRes === 'Rechazado') {
        estadoIndividual = 'rechazado';
        estadoVisual = 'rechazado';
      } else if (estRes === 'Aprobado con observación' || estRes === 'Observado') {
        estadoIndividual = 'observado';
        estadoVisual = 'observado';
      } else {
        todosResueltos = false;
        continue;
      }

      lote.facturas[i].estadoIndividual = estadoIndividual;

      const facturaIdNotificar = lote.facturas[i].facturaId;
      // Comprobante de lo que SET respondio: fecha de proceso y numero de
      // protocolo de autorizacion quedan en el registro (antes solo estaban
      // en la respuesta cruda del lote).
      const actualizacion = {
        estadoSifen: estadoIndividual,
        estadoVisual: estadoVisual,
        mensajeRetorno: msgRes,
        codigoRetorno: codRes,
        respuestaSifen: { codigo: codRes, estado: estRes, mensaje: msgRes, fechaProceso: fecProc || null, protocolo: protAut || null }
      };
      if (fecProc) actualizacion.fechaProceso = fecProc;
      Invoice.findByIdAndUpdate(facturaIdNotificar, actualizacion).then(async () => {
        // Rechazo: el documento no existe en SET, así que su número vuelve al
        // contador en vez de quedar como hueco a inutilizar.
        if (estadoIndividual === 'rechazado') {
          const { liberarNumeroRechazado } = require('./numeracionService');
          await liberarNumeroRechazado(facturaIdNotificar);
        }
        // estado final alcanzado: webhook + email del KUDE (fire-and-forget)
        const { notificarFacturaFinal } = require('./notificacionService');
        notificarFacturaFinal(facturaIdNotificar);
      }).catch(err => console.warn('⚠️ No se pudo actualizar factura del lote:', err.message));
    }

    if (todosResueltos) {
      lote.estado = 'completado';
    }

    lote.respuestaSifen = {
      codigo: codigo,
      dProtConsLote: lote.dProtConsLote,
      raw: soapResponse
    };

    await lote.save();
    return { lote, completado: todosResueltos, mensaje: `Procesadas ${bloques.length} facturas` };
  }

  return { lote, completado: false, codigoLote: codigo, mensaje: mensajeLote || `Código: ${codigo}` };
}

async function enviarPendientes() {
  const lotes = await LoteEnvio.find({ estado: 'en_espera', count: { $gt: 0 } });
  const resultados = [];
  for (const lote of lotes) {
    try {
      await enviarLote(lote._id);
      resultados.push({ loteId: lote._id, success: true });
    } catch (err) {
      resultados.push({ loteId: lote._id, success: false, error: err.message });
    }
  }
  return resultados;
}

/**
 * Envía los lotes en espera cuya factura más antigua ya esperó demasiado.
 *
 * El lote se auto-envía al llegar a 50 documentos; sin esto, con menos de
 * 50 quedaba en_espera para siempre salvo envío manual — en producción una
 * venta individual nunca llegaba a SET. El criterio es la EDAD del lote
 * (createdAt): garantiza latencia máxima aunque sigan entrando facturas.
 */
async function enviarLotesConEspera(esperaMs) {
  const limite = new Date(Date.now() - esperaMs);
  const lotes = await LoteEnvio.find({
    estado: 'en_espera',
    count: { $gt: 0 },
    createdAt: { $lte: limite }
  });
  const resultados = [];
  for (const lote of lotes) {
    try {
      await enviarLote(lote._id);
      resultados.push({ loteId: lote._id, count: lote.count, success: true });
    } catch (err) {
      // p. ej. carrera con un envío manual (estado ya no es en_espera)
      resultados.push({ loteId: lote._id, success: false, error: err.message });
    }
  }
  return resultados;
}

async function consultarPendientes() {
  const lotes = await LoteEnvio.find({ estado: { $in: ['enviado', 'procesando'] }, dProtConsLote: { $ne: null } });
  const resultados = [];
  for (const lote of lotes) {
    try {
      const res = await consultarResultadoLote(lote._id);
      resultados.push({ loteId: lote._id, completado: res.completado });
    } catch (err) {
      resultados.push({ loteId: lote._id, completado: false, error: err.message });
    }
  }
  return resultados;
}

module.exports = {
  agregarFacturaALote,
  enviarLote,
  consultarResultadoLote,
  enviarPendientes,
  enviarLotesConEspera,
  consultarPendientes
};
