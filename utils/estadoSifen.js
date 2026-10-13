/**
 * Utilitarios para manejo de estados SIFEN v150
 * 
 * Este módulo centraliza la lógica de determinación de estados
 * y extracción de datos de respuestas SOAP de la SET.
 */

/**
 * setapi NO devuelve el XML crudo: cuando SET responde XML, lo parsea con
 * xml2js y resuelve un OBJETO (claves con namespace, ej. 'ns2:dCodRes').
 * Los extractores de abajo hacían .match() sobre ese objeto y fallaban
 * siempre ("xmlContent.match is not a function"), con lo cual TODA
 * respuesta real de SET terminaba en codigo null -> estado rechazado,
 * aunque SET hubiera aceptado el documento.
 *
 * Esta función busca un campo recursivamente en la respuesta parseada,
 * ignorando el prefijo de namespace.
 *
 * @param {object} respuesta   objeto parseado por xml2js
 * @param {string} nombreCampo p.ej. 'dCodRes'
 * @param {function} [validador] filtro opcional sobre el valor encontrado
 * @returns {string|null}
 */
function buscarEnRespuesta(respuesta, nombreCampo, validador = null, profundidad = 0) {
  if (respuesta === null || typeof respuesta !== 'object' || profundidad > 8) return null;
  for (const [clave, valor] of Object.entries(respuesta)) {
    const nombre = clave.includes(':') ? clave.split(':').pop() : clave;
    if (nombre === nombreCampo && (typeof valor === 'string' || typeof valor === 'number')) {
      const texto = String(valor).trim();
      if (!validador || validador(texto)) return texto;
    }
    const anidado = buscarEnRespuesta(valor, nombreCampo, validador, profundidad + 1);
    if (anidado !== null) return anidado;
  }
  return null;
}

/**
 * Extrae el código de retorno de una respuesta SOAP
 * Soporta ambos formatos: <ns2:dCodRes> (SIFEN v150) y <codigoRetorno> (genérico)
 *
 * @param {string|object} xmlContent - XML crudo u objeto parseado por setapi
 * @returns {string|null} Código de retorno o null si no encuentra
 */
function extraerCodigoRetorno(xmlContent) {
  try {
    if (xmlContent && typeof xmlContent === 'object') {
      return buscarEnRespuesta(xmlContent, 'dCodRes')
        ?? buscarEnRespuesta(xmlContent, 'codigoRetorno');
    }
    // Soporta ambos formatos: SIFEN v150 (<ns2:dCodRes>) y genérico (<codigoRetorno>)
    const match =
      xmlContent.match(/<ns2:dCodRes>(.*?)<\/ns2:dCodRes>/) ||
      xmlContent.match(/<dCodRes>(.*?)<\/dCodRes>/) ||
      xmlContent.match(/<codigoRetorno>(.*?)<\/codigoRetorno>/);

    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer código de retorno:', error.message);
    return null;
  }
}

/**
 * Extrae el mensaje de retorno de una respuesta SOAP
 * Soporta ambos formatos: <ns2:dMsgRes> (SIFEN v150) y <mensajeRetorno> (genérico)
 *
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} Mensaje de retorno o null si no encuentra
 */
function extraerMensajeRetorno(xmlContent) {
  try {
    if (xmlContent && typeof xmlContent === 'object') {
      return buscarEnRespuesta(xmlContent, 'dMsgRes')
        ?? buscarEnRespuesta(xmlContent, 'mensajeRetorno');
    }
    // Soporta ambos formatos: SIFEN v150 (<ns2:dMsgRes>) y genérico (<mensajeRetorno>)
    const match =
      xmlContent.match(/<ns2:dMsgRes>(.*?)<\/ns2:dMsgRes>/) ||
      xmlContent.match(/<dMsgRes>(.*?)<\/dMsgRes>/) ||
      xmlContent.match(/<mensajeRetorno>(.*?)<\/mensajeRetorno>/);

    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer mensaje de retorno:', error.message);
    return null;
  }
}

/**
 * Extrae el estado de resultado de una respuesta SOAP
 * Soporta ambos formatos: <ns2:dEstRes> (SIFEN v150) y <estadoResultado> (genérico)
 *
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} Estado de resultado o null si no encuentra
 */
function extraerEstadoResultado(xmlContent) {
  try {
    if (xmlContent && typeof xmlContent === 'object') {
      return buscarEnRespuesta(xmlContent, 'dEstRes')
        ?? buscarEnRespuesta(xmlContent, 'estadoResultado');
    }
    // Soporta ambos formatos: SIFEN v150 (<ns2:dEstRes>) y genérico (<estadoResultado>)
    const match =
      xmlContent.match(/<ns2:dEstRes>(.*?)<\/ns2:dEstRes>/) ||
      xmlContent.match(/<dEstRes>(.*?)<\/dEstRes>/) ||
      xmlContent.match(/<estadoResultado>(.*?)<\/estadoResultado>/);

    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer estado de resultado:', error.message);
    return null;
  }
}

/**
 * Extrae el CDC de una respuesta SOAP
 * Soporta ambos formatos: <ns2:id> (SIFEN v150 oficial) y <cdc> (genérico)
 *
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} CDC o null si no encuentra
 */
function extraerCDC(xmlContent) {
  try {
    if (xmlContent && typeof xmlContent === 'object') {
      // el CDC son exactamente 44 dígitos (el 'id' suelto de setapi es el dId de 15)
      const esCdc = (v) => /^[0-9]{44}$/.test(v);
      return buscarEnRespuesta(xmlContent, 'id', esCdc)
        ?? buscarEnRespuesta(xmlContent, 'Id', esCdc)
        ?? buscarEnRespuesta(xmlContent, 'cdc', esCdc);
    }
    // Soporta ambos formatos: SIFEN v150 (<ns2:id>) y genérico (<cdc>)
    const match =
      xmlContent.match(/<ns2:id>(.*?)<\/ns2:id>/) ||
      xmlContent.match(/<id>(.*?)<\/id>/) ||
      xmlContent.match(/<cdc>(.*?)<\/cdc>/);

    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer CDC:', error.message);
    return null;
  }
}

/**
 * Extrae la fecha de proceso de una respuesta SOAP
 * Soporta ambos formatos: <ns2:dFecProc> (SIFEN v150) y <fechaProceso> (genérico)
 *
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} Fecha de proceso o null si no encuentra
 */
function extraerFechaProceso(xmlContent) {
  try {
    if (xmlContent && typeof xmlContent === 'object') {
      return buscarEnRespuesta(xmlContent, 'dFecProc')
        ?? buscarEnRespuesta(xmlContent, 'fechaProceso');
    }
    // Soporta ambos formatos: SIFEN v150 (<ns2:dFecProc>) y genérico (<fechaProceso>)
    const match =
      xmlContent.match(/<ns2:dFecProc>(.*?)<\/ns2:dFecProc>/) ||
      xmlContent.match(/<dFecProc>(.*?)<\/dFecProc>/) ||
      xmlContent.match(/<fechaProceso>(.*?)<\/fechaProceso>/);

    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer fecha de proceso:', error.message);
    return null;
  }
}

/**
 * Extrae el DigestValue de una respuesta SOAP
 * Soporta ambos formatos: <ns2:dDigVal> (SIFEN v150) y <digestValue> (genérico)
 *
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} DigestValue o null si no encuentra
 */
function extraerDigestValue(xmlContent) {
  try {
    if (xmlContent && typeof xmlContent === 'object') {
      return buscarEnRespuesta(xmlContent, 'DigestValue');
    }
    // Soporta ambos formatos: SIFEN v150 (<ns2:dDigVal>) y genérico (<digestValue>)
    const match =
      xmlContent.match(/<ns2:dDigVal>(.*?)<\/ns2:dDigVal>/) ||
      xmlContent.match(/<dDigVal>(.*?)<\/dDigVal>/) ||
      xmlContent.match(/<digestValue>(.*?)<\/digestValue>/);

    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer DigestValue:', error.message);
    return null;
  }
}

/**
 * Determina el estado SIFEN según el código de retorno
 * Para sistema síncrono simplificado:
 *
 * Códigos de recepción síncrona (siRecepDE) según Manual Técnico v150:
 * - 0260 = Autorización del DE satisfactoria (Aprobado - DTE) 🟢
 * - 1005 = Transmisión extemporánea (Observado) 🟠
 * - 1000-1004 = Errores de validación (Rechazado) 🔴
 *
 * Códigos de consulta (consDE) - Sección 12.3.4.3:
 * - 0420 = CDC inexistente (Rechazado) 🔴
 * - 0421 = RUC Certificado sin permiso (Error) 🔴
 * - 0422 = CDC encontrado (Aprobado) 🟢
 *
 * NOTA: El estado "observado" solo se usa para código 1005 (transmisión extemporánea).
 * NOTA: El código 0000 NO es oficial según el Manual Técnico v150.
 *
 * @param {string} codigo - Código de retorno de 4 dígitos
 * @returns {string} Estado determinado: 'aceptado', 'observado', 'rechazado'
 */
function determinarEstadoSegunCodigo(codigo) {
  if (!codigo) return 'rechazado';

  // Éxito - Autorización satisfactoria (SIFEN v150) - códigos legacy 0, 2
  // 0422 = CDC encontrado (consulta exitosa)
  if (['0260', '0', '2', '0422'].includes(codigo)) {
    return 'aceptado';
  }

  // Transmisión extemporánea - Observado (único caso donde estado = 'observado')
  if (codigo === '1005') {
    return 'observado';
  }

  // Rechazado - códigos específicos (Manual Técnico v150)
  // Incluye 0420 (CDC inexistente) y 0421 (RUC sin permiso)
  if (['1000', '1001', '1002', '1003', '1004', '1', '0420', '0421'].includes(codigo)) {
    return 'rechazado';
  }

  return 'rechazado';
}

/**
 * Determina el estado visual según el código de retorno
 * El estado visual se usa para mostrar colores en el frontend
 *
 * NOTA: El código 0000 NO es oficial según el Manual Técnico v150.
 * Los estados se determinan directamente por códigos oficiales.
 *
 * @param {string} codigo - Código de retorno de 4 dígitos
 * @returns {string} Estado visual: 'aceptado', 'observado', 'rechazado', 'error'
 */
function determinarEstadoVisual(codigo) {
  if (!codigo) return 'rechazado';

  // 0260, 0422 = Verde (Aceptado - CDC encontrado)
  if (['0260', '0422', '0', '2'].includes(codigo)) {
    return 'aceptado';
  }

  // 1005 = Amarillo (Observado - Transmisión extemporánea)
  if (codigo === '1005') {
    return 'observado';
  }

  // 9999 = Rojo (Error de conexión - no es rechazo de SET)
  if (codigo === '9999') {
    return 'error';
  }

  // Otros = Rojo (Rechazado) - incluye 0420, 0421
  return 'rechazado';
}

/**
 * Obtiene el color de Vuetify para el estado visual
 *
 * @param {string} estadoVisual - Estado visual: 'aceptado', 'observado', 'rechazado', 'error'
 * @returns {string} Color de Vuetify: 'success', 'amber', 'error'
 */
function getColorPorEstadoVisual(estadoVisual) {
  switch (estadoVisual) {
    case 'aceptado':
      return 'success';  // Verde
    case 'observado':
      return 'amber';    // Amarillo medio oscuro
    case 'rechazado':
      return 'error';    // Rojo
    case 'error':
      return 'error';    // Rojo (mismo color, pero semántica diferente)
    default:
      return 'info';
  }
}

/**
 * Obtiene el mensaje descriptivo según el código de retorno
 * 
 * @param {string} codigo - Código de retorno de 4 dígitos
 * @returns {string} Mensaje descriptivo
 */
function getMensajePorCodigo(codigo) {
  const mensajes = {
    '0260': 'Autorización del DE satisfactoria',
    '1005': 'Transmisión extemporánea del DE',
    '1000': 'CDC no corresponde con las informaciones del XML',
    '1001': 'CDC duplicado',
    '1002': 'Documento electrónico duplicado',
    '1003': 'DV del CDC inválido',
    '1004': 'La fecha y hora de la firma digital es adelantada',
    '0420': 'CDC inexistente - Documento no encontrado en la SET',
    '0421': 'CDC encontrado',
    '0': 'Procesamiento exitoso',
    '2': 'Documento aprobado',
    '3': 'Documento en procesamiento',
    '1': 'Documento rechazado'
  };

  return mensajes[codigo] || 'Estado desconocido';
}

/**
 * Extrae el estado del documento de una respuesta SOAP de consulta
 * Soporta formatos: <ns2:estado>, <estado>, <estadoResultado>
 * Este campo indica el estado real del documento: Aprobado/Rechazado/Pendiente
 *
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} Estado del documento o null si no encuentra
 */
function extraerEstadoDocumento(xmlContent) {
  try {
    if (xmlContent && typeof xmlContent === 'object') {
      return buscarEnRespuesta(xmlContent, 'estado')
        ?? buscarEnRespuesta(xmlContent, 'dEstDe')
        ?? buscarEnRespuesta(xmlContent, 'dEstRes');
    }
    // El estado del documento viene en <estado> (no confundir con <dEstRes>)
    const match =
      xmlContent.match(/<ns2:estado>(.*?)<\/ns2:estado>/) ||
      xmlContent.match(/<estado>(.*?)<\/estado>/) ||
      xmlContent.match(/<estadoResultado>(.*?)<\/estadoResultado>/);

    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer estado del documento:', error.message);
    return null;
  }
}

module.exports = {
  // Búsqueda genérica sobre la respuesta parseada
  buscarEnRespuesta,

  // Funciones de extracción de SOAP
  extraerCodigoRetorno,
  extraerMensajeRetorno,
  extraerEstadoResultado,
  extraerEstadoDocumento,
  extraerCDC,
  extraerFechaProceso,
  extraerDigestValue,

  // Funciones de determinación de estados
  determinarEstadoSegunCodigo,
  determinarEstadoVisual,
  getColorPorEstadoVisual,
  getMensajePorCodigo
};
