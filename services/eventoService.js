/**
 * Servicio de Eventos SIFEN
 * 
 * Gestiona el envío de eventos a la SET según Manual Técnico v150 - Sección 11
 * 
 * Tipos de eventos:
 * - Emisor: Cancelación, Devolución/Ajuste
 * - Receptor: Conformidad, Disconformidad, Desconocimiento, Notificación de recepción
 */

const Evento = require('../models/Evento');
const { generarIdSifen } = require('../utils/idSifen');
const Invoice = require('../models/Invoice');
const Empresa = require('../models/Empresa');
const certificadoService = require('./certificadoService');
const path = require('path');
const crypto = require('crypto');
const setApi = require('./setapi-wrapper');

// Librería para generar XML de eventos
const FacturaElectronicaPY = require('facturacionelectronicapy-xmlgen').default;
const xmlsign = require('facturacionelectronicapy-xmlsign').default;

/**
 * Tipos de eventos según Manual Técnico v150
 */
const TIPOS_EVENTO = {
  // Eventos del Emisor
  CANCELACION: 'cancelacion',
  DEVOLUCION_AJUSTE: 'devolucion_ajuste',
  
  // Eventos del Receptor
  CONFORMIDAD: 'conformidad',
  DISCONFORMIDAD: 'disconformidad',
  DESCONOCIMIENTO: 'desconocimiento',
  NOTIFICACION_RECEPCION: 'notificacion_recepcion'
};

/**
 * Genera el XML de un evento usando el generador OFICIAL de xmlgen.
 *
 * IMPORTANTE: no armar este XML a mano. SET rechazaba con "0160 XML mal
 * formado" un XML artesanal estructuralmente idéntico; el formato exacto que
 * SET acepta es el que produce xmlgen (rEve Id="1", xsi:schemaLocation con
 * espacio en gGroupGesEve, sobre SOAP con dId incluido). Verificado en
 * producción: evento de cancelación aprobado con dCodRes 0600.
 *
 * El XML retornado ya viene envuelto en el sobre SOAP: signXMLEvento navega
 * env:Envelope > env:Body > ... > rEve para firmar, y setapi.evento() lo
 * envía tal cual (no envuelve).
 *
 * @param {Object} params - Parámetros del evento
 * @returns {Promise<string>} XML del evento sin firmar (con sobre SOAP)
 */
async function generarXMLEvento(params) {
  const { cdc, tipoEvento, descripcion, dId, datosEvento } = params;

  // Fecha de firma en hora de Paraguay explícita (independiente del TZ del
  // proceso): xmlgen la re-formatea con getHours() locales, y un string sin
  // zona horaria se parsea/re-formatea sin conversión.
  const fechaFirmaDigital = new Date()
    .toLocaleString('sv-SE', { timeZone: 'America/Asuncion' })
    .replace(' ', 'T');

  const paramsXmlgen = { version: 150 };
  const datos = {
    cdc,
    motivo: descripcion,
    fechaFirmaDigital,
    ...(datosEvento || {})
  };

  switch (tipoEvento) {
    case 'cancelacion':
      return FacturaElectronicaPY.generateXMLEventoCancelacion(dId, paramsXmlgen, datos);
    case 'conformidad':
      return FacturaElectronicaPY.generateXMLEventoConformidad(dId, paramsXmlgen, datos);
    case 'disconformidad':
      return FacturaElectronicaPY.generateXMLEventoDisconformidad(dId, paramsXmlgen, datos);
    case 'desconocimiento':
      return FacturaElectronicaPY.generateXMLEventoDesconocimiento(dId, paramsXmlgen, datos);
    case 'notificacion_recepcion':
      return FacturaElectronicaPY.generateXMLEventoNotificacion(dId, paramsXmlgen, datos);
    case 'devolucion_ajuste':
      // xmlgen no implementa devolución/ajuste como evento; la devolución se
      // documenta con una Nota de Crédito electrónica, no con un evento.
      throw new Error('La devolución/ajuste se realiza con Nota de Crédito electrónica, no con un evento SIFEN');
    default:
      throw new Error(`Tipo de evento no soportado: ${tipoEvento}`);
  }
}

/**
 * Envía un evento a la SET
 * @param {Object} params - Parámetros del evento
 * @returns {Promise<Object>} Resultado del envío
 */
async function enviarEvento(params) {
  const {
    invoiceId,
    tipoEvento,
    descripcion,
    usuario
  } = params;

  try {
    // ========================================
    // 1. Buscar factura y empresa
    // ========================================
    const invoice = await Invoice.findById(invoiceId);
    
    if (!invoice) {
      throw new Error('Factura no encontrada');
    }

    // Validar que la factura tenga CDC
    if (!invoice.cdc) {
      throw new Error('La factura no tiene CDC. Debe estar aprobada por SET para enviar eventos.');
    }

    // Validar que la factura esté aprobada por SET (con o sin observación)
    if (!['aceptado', 'observado'].includes(invoice.estadoSifen)) {
      throw new Error(`No se puede enviar evento: La factura está en estado "${invoice.estadoSifen}". Debe estar "aceptado" u "observado".`);
    }

    const empresa = await Empresa.findById(invoice.empresaId);
    
    if (!empresa) {
      throw new Error('Empresa no encontrada');
    }

    if (!empresa.activo) {
      throw new Error(`Empresa "${empresa.nombreFantasia}" está inactiva`);
    }

    console.log(`📋 Enviando evento "${tipoEvento}" para factura CDC: ${invoice.cdc}`);

    // ========================================
    // 2. Generar XML del evento
    // ========================================
    const idDocumento = generarIdSifen();

    const xmlEvento = await generarXMLEvento({
      cdc: invoice.cdc,
      tipoEvento,
      descripcion,
      dId: idDocumento,
      datosEvento: params.datosEvento
    });

    // ========================================
    // 3. Firmar XML del evento
    // ========================================
    // NOTA: Usar signXMLEvento en lugar de signXML porque busca el tag "rEve" en lugar de "DE"
    const rutaCertificado = empresa.obtenerRutaCertificado();
    const contrasena = certificadoService.descifrarContrasena(empresa.certificado.contrasena);

    // 🔧 IMPORTANTE: El 4to parámetro 'true' fuerza a usar Node.js en lugar de Java
    // Java 21 en Ubuntu 24.04 corrompe el encoding UTF-8
    // La librería facturacionelectronicapy-xmlsign tiene un método específico para eventos
    // que busca el nodo "rEve" para firmar (según Manual Técnico v150)
    const xmlFirmado = await xmlsign.signXMLEvento(xmlEvento, rutaCertificado, contrasena, true);
    console.log('✅ XML del evento firmado');

    // ========================================
    // 4. Enviar a SET
    // ========================================
    const ambiente = empresa.configuracionSifen.modo || 'test';

    console.log('📤 Enviando evento a SET...');

    const respuesta = await setApi.evento(
      idDocumento,
      xmlFirmado,
      ambiente,
      rutaCertificado,
      contrasena
    );

    console.log('📥 Respuesta de SET recibida');

    // ========================================
    // 5. Extraer datos de respuesta
    // ========================================
    // La respuesta de setapi es un objeto ya parseado (o un string XML en
    // versiones viejas). El parser anterior buscaba una estructura que SIFEN
    // no usa y, al fallar, asumia "registrado correctamente": un evento
    // rechazado por SET quedaba registrado como exitoso.
    const { extraerCodigoRetorno, extraerMensajeRetorno, extraerEstadoResultado, buscarEnRespuesta } =
      require('../utils/estadoSifen');

    const codigoRetorno = extraerCodigoRetorno(respuesta);
    const mensajeRetorno = extraerMensajeRetorno(respuesta) || 'Sin mensaje de SET';
    const estadoResultado = extraerEstadoResultado(respuesta); // Aprobado | Rechazado
    const idEventoSET =
      (typeof respuesta === 'object' ? buscarEnRespuesta(respuesta, 'dProtAut') : null);

    // 0600/0601 = evento registrado segun el Manual Tecnico v150.
    // Codigos de "ya cancelado" (idempotentes para una cancelación, el DTE
    // está efectivamente cancelado — se marca localmente igual):
    //   4003 = "CDC ya se encuentra con el mismo evento solicitado"
    //          (respuesta real de SET producción al reenviar la cancelación)
    //   4155/4204 = "El CDC del DTE ya ha sido cancelado con anterioridad"
    const yaCancelado = tipoEvento === 'cancelacion' &&
      ['4003', '4155', '4204'].includes(codigoRetorno);
    const registrado = estadoResultado === 'Aprobado' || codigoRetorno === '0600' ||
      codigoRetorno === '0601' || yaCancelado;
    const estadoEvento = registrado ? 'registrado' : 'rechazado';

    console.log(`📥 SET respondio al evento: ${codigoRetorno ?? 'sin codigo'} (${estadoEvento}) - ${mensajeRetorno}`);

    // ========================================
    // 6. Guardar evento en BD
    // ========================================
    const evento = new Evento({
      invoiceId: invoice._id,
      cdc: invoice.cdc,
      correlativo: invoice.correlativo,
      tipoEvento,
      descripcion,
      xmlEvento,
      xmlFirmado,
      estadoEvento,
      codigoRetorno,
      mensajeRetorno,
      idEventoSET,
      empresaId: empresa._id,
      rucEmpresa: empresa.ruc,
      rucReceptor: invoice.cliente?.ruc,
      usuario
    });

    await evento.save();
    console.log(`✅ Evento guardado en BD: ${evento._id}`);

    // ========================================
    // 7. Actualizar estado de la factura
    // ========================================
    // Una cancelación registrada en SET anula el DTE: se refleja en la
    // factura local para que no compute en la contabilidad.
    if (registrado && tipoEvento === 'cancelacion') {
      invoice.estadoSifen = 'cancelado';
      await invoice.save();
      console.log(`🚫 Factura ${invoice.correlativo} marcada como cancelada`);

      // Estado final nuevo: la integración se entera por el webhook (sin
      // email: el KUDE solo se manda para aceptado/observado). Es el único
      // lugar que cancela: /api/eventos/enviar y /bulk/cancelar pasan por acá.
      const { notificarFacturaFinal } = require('./notificacionService');
      notificarFacturaFinal(invoice._id.toString());
    }

    // ========================================
    // 8. Retornar resultado
    // ========================================
    return {
      success: true,
      eventoId: evento._id,
      idEventoSET,
      codigoRetorno,
      mensajeRetorno,
      estadoEvento,
      tipoEvento,
      cdc: invoice.cdc,
      correlativo: invoice.correlativo
    };

  } catch (error) {
    console.error('❌ Error enviando evento:', error);
    
    // Guardar evento fallido
    try {
      const invoice = await Invoice.findById(params.invoiceId);
      if (invoice) {
        const eventoFallido = new Evento({
          invoiceId: invoice._id,
          cdc: invoice.cdc || 'N/A',
          correlativo: invoice.correlativo,
          tipoEvento: params.tipoEvento,
          descripcion: params.descripcion,
          xmlEvento: params.xmlEvento || '',
          xmlFirmado: '',
          estadoEvento: 'error',
          codigoRetorno: '9999',
          mensajeRetorno: error.message,
          empresaId: invoice.empresaId,
          rucEmpresa: invoice.rucEmpresa,
          usuario: params.usuario
        });
        await eventoFallido.save();
      }
    } catch (saveError) {
      console.error('❌ Error guardando evento fallido:', saveError);
    }

    throw error;
  }
}

/**
 * Obtiene los eventos de una factura
 * @param {String} invoiceId - ID de la factura
 * @returns {Promise<Array>} Lista de eventos
 */
async function obtenerEventos(invoiceId) {
  const eventos = await Evento.find({ invoiceId })
    .sort({ createdAt: -1 })
    .populate('empresaId', 'ruc nombreFantasia');
  
  return eventos;
}

/**
 * Obtiene eventos por CDC
 * @param {String} cdc - CDC del documento
 * @returns {Promise<Array>} Lista de eventos
 */
async function obtenerEventosPorCDC(cdc) {
  const eventos = await Evento.find({ cdc })
    .sort({ createdAt: -1 })
    .populate('invoiceId', 'correlativo estadoSifen');
  
  return eventos;
}

module.exports = {
  enviarEvento,
  obtenerEventos,
  obtenerEventosPorCDC,
  TIPOS_EVENTO,
  generarXMLEvento
};
