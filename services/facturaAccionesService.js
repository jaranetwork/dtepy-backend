/**
 * Acciones sobre facturas ya emitidas, reutilizables desde las rutas
 * individuales y desde las operaciones masivas (bulk).
 *
 * Cada acción recibe el documento (ya verificado en alcance por la ruta) y
 * devuelve `{ status, body }` listo para responder. Ninguna toca `req`/`res`:
 * así la misma lógica sirve para un documento o para doscientos.
 */

const fs = require('fs');
const path = require('path');
const Invoice = require('../models/Invoice');
const OperationLog = require('../models/OperationLog');
const LoteEnvio = require('../models/LoteEnvio');
const { generarIdSifen } = require('../utils/idSifen');
const { evaluarPlazoCancelacion } = require('../utils/plazosSifen');
const { ESTADOS_NUNCA_EN_SET } = require('./numeracionService');

// Estados en los que SET ya se pronunció: consultar no cambia nada.
const ESTADOS_FINALES = ['aceptado', 'rechazado', 'error', 'observado', 'cancelado'];
// Estados en los que el documento EXISTE en SET (no se reenvía ni se borra).
const ESTADOS_EN_SET = ['aceptado', 'observado', 'cancelado'];
// Filtro Mongo de los documentos que existen en SET: comprobantes fiscales
// que ninguna limpieza masiva puede tocar.
const FILTRO_EXISTE_EN_SET = { estadoSifen: { $in: ESTADOS_EN_SET }, cdc: { $type: 'string', $ne: '' } };

// ---------------------------------------------------------------------
// Elegibilidad (la usa el backend para decidir y el frontend, vía el
// listado, para habilitar o deshabilitar cada acción)
// ---------------------------------------------------------------------

function elegibleReintento(invoice) {
  if (ESTADOS_EN_SET.includes(invoice.estadoSifen) && invoice.cdc) {
    return { ok: false, motivo: `Ya existe en SET con estado "${invoice.estadoSifen}"` };
  }
  if (['encolado', 'procesando', 'enviado'].includes(invoice.estadoSifen)) {
    return { ok: false, motivo: `Todavía en curso (${invoice.estadoSifen})` };
  }
  const data = invoice.datosFactura?.data || invoice.datosFactura;
  if (!data || !Object.keys(data).length) {
    return { ok: false, motivo: 'Sin datos de emisión guardados' };
  }
  return { ok: true };
}

function elegibleCancelacion(invoice) {
  if (!['aceptado', 'observado'].includes(invoice.estadoSifen) || !invoice.cdc) {
    return { ok: false, motivo: `Solo se cancela un documento aprobado (estado actual: ${invoice.estadoSifen})` };
  }
  const plazo = evaluarPlazoCancelacion(invoice.fechaProceso || invoice.updatedAt, invoice.de);
  if (!plazo.dentro) {
    return {
      ok: false,
      motivo: `Fuera de plazo: ${plazo.horasLimite} h desde la aprobación (pasaron ${Math.floor(plazo.horasTranscurridas)})`,
      horasLimite: plazo.horasLimite,
      horasTranscurridas: plazo.horasTranscurridas
    };
  }
  return {
    ok: true,
    horasLimite: plazo.horasLimite,
    horasTranscurridas: plazo.horasTranscurridas,
    horasRestantes: Math.max(0, plazo.horasLimite - plazo.horasTranscurridas)
  };
}

function elegibleEliminacion(invoice) {
  if (!ESTADOS_NUNCA_EN_SET.includes(invoice.estadoSifen) && invoice.estadoSifen !== 'recibido') {
    return {
      ok: false,
      motivo: ESTADOS_EN_SET.includes(invoice.estadoSifen)
        ? `Existe en SET (${invoice.estadoSifen}): un documento fiscal se conserva 5 años, no se borra`
        : `Todavía en curso (${invoice.estadoSifen})`
    };
  }
  return { ok: true };
}

function elegibilidad(invoice) {
  return {
    reintento: elegibleReintento(invoice),
    cancelacion: elegibleCancelacion(invoice),
    eliminacion: elegibleEliminacion(invoice),
    consultaEstado: { ok: Boolean(invoice.cdc), motivo: invoice.cdc ? undefined : 'Sin CDC' }
  };
}

// ---------------------------------------------------------------------
// Consultar estado en SET
// ---------------------------------------------------------------------

/**
 * Consulta el estado del DTE en SET y sincroniza el registro local.
 * Lógica movida desde POST /api/invoices/:id/refresh-status.
 */
async function consultarEstadoEnSet(invoiceRecord) {
  const id = invoiceRecord._id;

  if (!invoiceRecord.cdc) {
    return { status: 400, body: { success: false, error: 'CDC_REQUIRED', message: 'La factura no tiene CDC asignado' } };
  }

  if (ESTADOS_FINALES.includes(invoiceRecord.estadoSifen)) {
    // Auto-corrección: el CDC es la verdad sobre est-punto-numero del DTE.
    if (invoiceRecord.cdc.length === 44) {
      const correlativoCDC = `${invoiceRecord.cdc.slice(11, 14)}-${invoiceRecord.cdc.slice(14, 17)}-${invoiceRecord.cdc.slice(17, 24)}`;
      if (invoiceRecord.correlativo !== correlativoCDC) {
        console.log(`🩹 Correlativo corregido desde el CDC: ${invoiceRecord.correlativo} -> ${correlativoCDC}`);
        invoiceRecord.correlativo = correlativoCDC;
        await invoiceRecord.save();
      }
    }

    return {
      status: 200,
      body: {
        success: true,
        message: 'Estado final - No se consultó a SET (no hay cambios posibles)',
        esEstadoFinal: true,
        consultoSET: false,
        estadoAnterior: invoiceRecord.estadoSifen,
        estadoActual: invoiceRecord.estadoSifen,
        estadoVisual: invoiceRecord.estadoVisual,
        estadoCambio: false,
        data: {
          estado: invoiceRecord.estadoSifen,
          estadoVisual: invoiceRecord.estadoVisual,
          facturaId: invoiceRecord._id,
          correlativo: invoiceRecord.correlativo,
          cdc: invoiceRecord.cdc,
          codigoRetorno: invoiceRecord.codigoRetorno,
          mensajeRetorno: invoiceRecord.mensajeRetorno,
          fechaProceso: invoiceRecord.fechaProceso
        }
      }
    };
  }

  try {
    const Empresa = require('../models/Empresa');
    const setApi = require('./setapi-wrapper');
    const empresa = await Empresa.findById(invoiceRecord.empresaId);

    const idConsulta = generarIdSifen();
    const ambiente = empresa?.configuracionSifen?.modo || 'test';

    let certificateP12Path = path.join(__dirname, '..', 'certificados', 'p12', 'certificado.p12');
    let certificatePassword = '123456';

    if (empresa?.certificado?.nombreArchivo) {
      const certificadoService = require('./certificadoService');
      certificateP12Path = path.join(__dirname, '..', 'certificados', 'p12', empresa.certificado.nombreArchivo);
      certificatePassword = certificadoService.descifrarContrasena(empresa.certificado.contrasena);
    }

    const respuesta = await setApi.consulta(idConsulta, invoiceRecord.cdc, ambiente, certificateP12Path, certificatePassword);

    const buscar = (...regexes) => {
      for (const re of regexes) {
        const m = String(respuesta).match(re);
        if (m && m[1]) return m[1].trim();
      }
      return null;
    };

    const codigoRetorno = buscar(/<ns2:dCodRes>(.*?)<\/ns2:dCodRes>/, /<dCodRes>(.*?)<\/dCodRes>/, /<codigoRetorno>(.*?)<\/codigoRetorno>/) || invoiceRecord.codigoRetorno;
    const estadoRetorno = buscar(/<ns2:estado>(.*?)<\/ns2:estado>/, /<estado>(.*?)<\/estado>/, /<ns2:dEstRes>(.*?)<\/ns2:dEstRes>/, /<dEstRes>(.*?)<\/dEstRes>/, /<estadoResultado>(.*?)<\/estadoResultado>/) || invoiceRecord.respuestaSifen?.estado;
    const mensajeRetorno = buscar(/<ns2:dMsgRes>(.*?)<\/ns2:dMsgRes>/, /<dMsgRes>(.*?)<\/dMsgRes>/, /<mensajeRetorno>(.*?)<\/mensajeRetorno>/) || invoiceRecord.mensajeRetorno;
    const fechaProceso = buscar(/<ns2:dFecProc>(.*?)<\/ns2:dFecProc>/, /<dFecProc>(.*?)<\/dFecProc>/, /<fechaProceso>(.*?)<\/fechaProceso>/) || invoiceRecord.fechaProceso;
    const digestValueResp = buscar(/<ns2:dDigVal>(.*?)<\/ns2:dDigVal>/, /<dDigVal>(.*?)<\/dDigVal>/, /<digestValue>(.*?)<\/digestValue>/) || invoiceRecord.digestValue;

    let estadoVisual = 'rechazado';
    let estadoSifen = 'rechazado';
    if (codigoRetorno === '0260' || codigoRetorno === '0422') {
      estadoVisual = 'aceptado'; estadoSifen = 'aceptado';
    } else if (codigoRetorno === '1005') {
      estadoVisual = 'observado'; estadoSifen = 'observado';
    } else if (codigoRetorno === '0420') {
      estadoVisual = 'error'; estadoSifen = 'error';
    }

    const estadoAnterior = invoiceRecord.estadoSifen;
    const estadoCambio = estadoSifen !== estadoAnterior;

    if (estadoCambio || !invoiceRecord.respuestaSifen?.codigo) {
      invoiceRecord.estadoSifen = estadoSifen;
      invoiceRecord.estadoVisual = estadoVisual;
      invoiceRecord.codigoRetorno = codigoRetorno;
      invoiceRecord.mensajeRetorno = mensajeRetorno;
      invoiceRecord.fechaProceso = fechaProceso;
      invoiceRecord.respuestaSifen = { codigo: codigoRetorno, estado: estadoRetorno, mensaje: mensajeRetorno, fechaProceso, digestValue: digestValueResp };

      let tipoOperacion = 'actualizacion_estado';
      let logEstado = 'success';
      let descripcion = `Estado actualizado a ${estadoSifen}`;
      if (estadoVisual === 'rechazado') {
        tipoOperacion = 'error_respuesta_set'; logEstado = 'error';
        descripcion = `Factura rechazada por SET: ${mensajeRetorno || codigoRetorno}`;
      } else if (estadoVisual === 'error') {
        tipoOperacion = 'error_respuesta_set'; logEstado = 'error';
        descripcion = 'CDC inexistente en SET - La factura no fue encontrada en la base de datos de la SET';
      } else if (estadoVisual === 'observado') {
        logEstado = 'warning';
        descripcion = `Factura aceptada con observación: ${mensajeRetorno || 'Transmisión extemporánea'}`;
      } else if (estadoVisual === 'aceptado') {
        descripcion = `Factura aceptada por SET: ${mensajeRetorno || 'Autorización satisfactoria'}`;
      }

      await new OperationLog({
        invoiceId: id, tipoOperacion, descripcion, estado: logEstado, fecha: new Date(),
        detalle: { cdc: invoiceRecord.cdc, correlativo: invoiceRecord.correlativo, codigoRetorno, estadoRetorno, mensajeRetorno, estadoVisual, huboCambio: estadoCambio, estadoAnterior, estadoNuevo: estadoSifen }
      }).save();
      await invoiceRecord.save();
    } else {
      await new OperationLog({
        invoiceId: id, tipoOperacion: 'consulta_estado',
        descripcion: `Consulta de estado realizada - Estado actual: ${estadoSifen}`, estado: 'success', fecha: new Date(),
        detalle: { cdc: invoiceRecord.cdc, correlativo: invoiceRecord.correlativo, codigoRetorno, estadoRetorno, mensajeRetorno, estadoVisual, huboCambio: false }
      }).save();
    }

    return {
      status: 200,
      body: {
        success: true,
        message: estadoCambio ? 'Estado actualizado' : 'Estado sin cambios',
        estadoAnterior,
        estadoActual: estadoSifen,
        estadoVisual,
        proceso: invoiceRecord.proceso,
        estadoCambio,
        codigoRetorno,
        mensajeRetorno,
        respuestaSifen: invoiceRecord.respuestaSifen,
        esEstadoFinal: ESTADOS_FINALES.includes(estadoSifen),
        consultoSET: true
      }
    };
  } catch (error) {
    console.error('❌ Error consultando a la SET:', error.message);
    await new OperationLog({
      invoiceId: id, tipoOperacion: 'error_consulta_estado',
      descripcion: `Error al consultar estado en SET: ${error.message}`, estado: 'error', fecha: new Date(),
      detalle: { error: error.message }
    }).save();
    if (invoiceRecord.estadoSifen !== 'error') {
      invoiceRecord.estadoSifen = 'error';
      await invoiceRecord.save();
    }
    return { status: 500, body: { success: false, error: 'REFRESH_STATUS_CONSULTA_ERROR', message: error.message, estadoActual: 'error' } };
  }
}

// ---------------------------------------------------------------------
// Reintentar emisión
// ---------------------------------------------------------------------

/**
 * Reintenta un documento que no llegó a existir en SET.
 *
 * Antes se reenviaba el MISMO XML por el canal individual (siRecepDE) y con
 * el ambiente de la variable AMBIENTE_SET: para las empresas que solo tienen
 * habilitado el envío por lotes eso terminaba siempre en 1264, y un XML ya
 * rechazado vuelve a rechazarse. Ahora se vuelve a emitir con los datos
 * guardados: el flujo normal reutiliza el registro (misma numeración),
 * firma un DTE nuevo y lo manda por el canal configurado en la empresa.
 */
async function reintentarEnvio(invoice) {
  const elegible = elegibleReintento(invoice);
  if (!elegible.ok) {
    return {
      status: 400,
      body: {
        success: false,
        error: ESTADOS_EN_SET.includes(invoice.estadoSifen) ? 'RETRY_ESTADO_FINAL' : 'RETRY_NO_ELEGIBLE',
        message: elegible.motivo,
        estadoActual: invoice.estadoSifen,
        cdc: invoice.cdc
      }
    };
  }

  await new OperationLog({
    invoiceId: invoice._id, tipoOperacion: 'reintento',
    descripcion: `Reintento de emisión - ${invoice.correlativo}`, estado: 'warning', fecha: new Date(),
    detalle: { cdc: invoice.cdc, correlativo: invoice.correlativo, estadoAnterior: invoice.estadoSifen, motivo: 'Reintento manual desde el panel' }
  }).save();

  try {
    const { crearFactura } = require('./facturaService');
    const resultado = await crearFactura(invoice.datosFactura);
    return { status: 200, body: { success: true, message: 'Reintento encolado', data: resultado } };
  } catch (error) {
    return {
      status: error.statusCode || 500,
      body: { success: false, error: error.errorCode || 'RETRY_ERROR', message: error.message, detalles: error.detalles }
    };
  }
}

// ---------------------------------------------------------------------
// Eliminar (solo lo que nunca existió en SET)
// ---------------------------------------------------------------------

async function eliminarFactura(invoice) {
  const elegible = elegibleEliminacion(invoice);
  if (!elegible.ok) {
    return { status: 400, body: { success: false, error: 'FACTURA_NO_ELIMINABLE', message: elegible.motivo } };
  }

  if (invoice.grupoLoteId) {
    // Un documento rechazado quedó referenciado por el lote en que viajó:
    // se quita la referencia y, si el lote queda vacío, se borra también.
    await LoteEnvio.updateOne({ _id: invoice.grupoLoteId }, { $pull: { facturas: { facturaId: invoice._id } } });
    await LoteEnvio.deleteOne({ _id: invoice.grupoLoteId, facturas: { $size: 0 } });
  }

  await Invoice.deleteOne({ _id: invoice._id });
  await OperationLog.deleteMany({ invoiceId: invoice._id });

  return { status: 200, body: { success: true, message: 'Factura eliminada', deletedId: String(invoice._id) } };
}

// ---------------------------------------------------------------------
// Archivos
// ---------------------------------------------------------------------

const DIR_SALIDA = path.join(__dirname, '..', 'de_output');

/**
 * Resuelve la ruta real de un archivo guardado en la factura.
 * Los registros viejos guardan rutas absolutas del contenedor
 * (/app/de_output/...); si el proceso corre en otro lado se busca el mismo
 * archivo relativo a la carpeta de salida local.
 */
function resolverArchivo(guardado) {
  if (!guardado) return null;
  const candidatos = [];
  if (path.isAbsolute(guardado)) {
    candidatos.push(guardado);
    const normalizado = guardado.split('\\').join('/');
    const idx = normalizado.indexOf('de_output/');
    if (idx >= 0) candidatos.push(path.join(DIR_SALIDA, normalizado.slice(idx + 'de_output/'.length)));
  } else {
    candidatos.push(path.join(DIR_SALIDA, guardado));
  }
  return candidatos.find((c) => fs.existsSync(c)) || null;
}

function rutaXml(invoice) {
  return resolverArchivo(invoice.xmlPath);
}

function rutaPdf(invoice) {
  return resolverArchivo(invoice.kudePath);
}

/** Nombre de archivo estable y legible: <tipo>_<correlativo>.<ext> */
function nombreArchivo(invoice, ext) {
  const tipo = String(invoice.de || 'Factura electrónica')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${tipo}_${invoice.correlativo}.${ext}`;
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------

const COLUMNAS_CSV = [
  ['fecha', 'Fecha'], ['correlativo', 'Número'], ['tipo', 'Tipo'], ['estado', 'Estado'],
  ['codigoRetorno', 'Código SET'], ['mensajeRetorno', 'Mensaje SET'], ['protocolo', 'Protocolo SET'], ['cdc', 'CDC'],
  ['clienteRuc', 'RUC cliente'], ['clienteNombre', 'Cliente'], ['moneda', 'Moneda'],
  ['total', 'Total'], ['tipoCambio', 'Tipo de cambio'], ['empresaRuc', 'RUC emisor'],
  ['emision', 'Emisión'], ['lote', 'Lote'], ['proceso', 'Archivos']
];

/** Fecha en hora de Paraguay (la del sistema y la del KUDE), formato 'YYYY-MM-DD HH:mm:ss'. */
function fechaCsv(valor) {
  if (!valor) return '';
  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) return '';
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Asuncion', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(fecha).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${partes.year}-${partes.month}-${partes.day} ${partes.hour === '24' ? '00' : partes.hour}:${partes.minute}:${partes.second}`;
}

function filaCsv(invoice) {
  const data = invoice.datosFactura?.data || {};
  return {
    fecha: fechaCsv(invoice.fechaCreacion),
    correlativo: invoice.correlativo,
    tipo: invoice.de || 'Factura electrónica',
    estado: invoice.estadoSifen,
    codigoRetorno: invoice.codigoRetorno || '',
    mensajeRetorno: invoice.mensajeRetorno || '',
    protocolo: invoice.respuestaSifen?.protocolo || '',
    cdc: invoice.cdc || '',
    clienteRuc: invoice.cliente?.ruc || '',
    clienteNombre: invoice.cliente?.nombre || invoice.cliente?.razonSocial || '',
    moneda: data.moneda || 'PYG',
    total: invoice.total ?? '',
    tipoCambio: data.cambio ?? '',
    empresaRuc: invoice.rucEmpresa || '',
    emision: invoice.tipoEmision === 2 ? 'Contingencia' : 'Normal',
    lote: invoice.grupoLoteId ? String(invoice.grupoLoteId) : '',
    proceso: invoice.proceso || 'Pendiente'
  };
}

/**
 * CSV para Excel en español: separador ";", BOM UTF-8, campos entrecomillados.
 * Los CDC van con un apóstrofo delante para que Excel no los convierta a
 * número y los destroce (44 dígitos → notación científica).
 */
function aCsv(filas) {
  const escapar = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const cabecera = COLUMNAS_CSV.map(([, titulo]) => escapar(titulo)).join(';');
  const lineas = filas.map((f) => COLUMNAS_CSV.map(([clave]) => {
    if (clave === 'cdc' && f.cdc) return escapar(`'${f.cdc}`);
    return escapar(f[clave]);
  }).join(';'));
  return '﻿' + [cabecera, ...lineas].join('\r\n') + '\r\n';
}

module.exports = {
  FILTRO_EXISTE_EN_SET,
  ESTADOS_FINALES,
  ESTADOS_EN_SET,
  elegibleReintento,
  elegibleCancelacion,
  elegibleEliminacion,
  elegibilidad,
  consultarEstadoEnSet,
  reintentarEnvio,
  eliminarFactura,
  rutaXml,
  rutaPdf,
  nombreArchivo,
  filaCsv,
  aCsv,
  COLUMNAS_CSV
};
