/**
 * Servicio de Procesamiento de Facturas
 * Contiene la lógica principal para generar, firmar y enviar facturas
 * Es llamado desde el worker de manera asíncrona
 */

const Invoice = require('../models/Invoice');
const { generarIdSifen } = require('../utils/idSifen');
const Empresa = require('../models/Empresa');
const certificadoService = require('./certificadoService');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { formatoFechaSIFEN, convertirFechasASIFEN } = require('../utils/fechaUtils');
const {
  extraerCodigoRetorno,
  extraerMensajeRetorno,
  extraerEstadoResultado,
  extraerFechaProceso,
  extraerDigestValue,
  determinarEstadoSegunCodigo,
  determinarEstadoVisual
} = require('../utils/estadoSifen');
const { aplicaRedondeoSedeco } = require('../utils/redondeoSedeco');

// Librerías SIFEN
const FacturaElectronicaPY = require('facturacionelectronicapy-xmlgen').default;
const xmlsign = require('facturacionelectronicapy-xmlsign').default;
const qr = require('facturacionelectronicapy-qrgen').default;
const { generarKudePdf } = require('./kudeRunner');

// Importar wrapper de SET API (soporta Mock y Producción)
const setApi = require('./setapi-wrapper');
const envioLoteService = require('./envioLoteService');

/**
 * Total general del documento (dTotGralOpe, F014) tal como quedó en el XML:
 * ítems menos descuentos y anticipos, menos el redondeo SEDECO si aplicó.
 * Es lo que realmente se factura. null si el XML no lo trae (nota de
 * remisión) o no es un número.
 */
function extraerTotalGeneral(xml) {
  const coincidencia = String(xml || '').match(/<(?:\w+:)?dTotGralOpe>\s*([^<]+?)\s*<\/(?:\w+:)?dTotGralOpe>/);
  if (!coincidencia) return null;
  const total = Number(coincidencia[1]);
  return Number.isFinite(total) ? total : null;
}

/**
 * Procesa una factura electrónica completa
 * @param {Object} datosFactura - Datos de la factura
 * @param {String} empresaId - ID de la empresa
 * @param {Object} job - Job de Bull (para reportar progreso)
 * @param {String} invoiceId - ID de la factura en BD (para actualizar con DigestValue)
 * @returns {Object} Resultado del procesamiento
 */
async function procesarFactura(datosFactura, empresaId, job = null, invoiceId = null) {
  const reportarProgreso = async (progress) => {
    if (job && job.progress) {
      await job.progress(progress);
    }
  };

  // Variables para almacenar CDC y DigestValue (extraídos después de firmar)
  let digestValueFirma = null;
  let cdcFirma = null;

  try {
    // ========================================
    // 1. Buscar empresa y validar
    // ========================================
    await reportarProgreso(5);
    
    const Empresa = require('../models/Empresa');
    const empresa = await Empresa.findById(empresaId);
    if (!empresa) {
      throw new Error('Empresa no encontrada');
    }

    if (!empresa.activo) {
      throw new Error(`Empresa "${empresa.nombreFantasia}" está inactiva`);
    }

    if (!empresa.tieneCertificadoValido()) {
      throw new Error('La empresa no tiene un certificado digital válido');
    }

    console.log(`🏢 Procesando factura para: ${empresa.nombreFantasia} (RUC: ${empresa.ruc})`);
    await reportarProgreso(10);

    // ========================================
    // 2. Usar datos directamente del JSON
    // ========================================
    const datosCompletos = datosFactura.data || datosFactura;

    // El CDC lleva un codigo de seguridad de 9 digitos. Si la integracion no
    // lo manda, xmlgen NO lo valida y arma un CDC con la palabra "undefined"
    // adentro: un documento firmado pero corrupto. Se genera uno aca.
    if (!datosCompletos.codigoSeguridadAleatorio) {
      datosCompletos.codigoSeguridadAleatorio = String(crypto.randomInt(1, 1e9)).padStart(9, '0');
      console.log('🎲 codigoSeguridadAleatorio generado:', datosCompletos.codigoSeguridadAleatorio);
    }

    await reportarProgreso(15);

    // ========================================
    // 3. Generar params para xmlgen (usando estructura unificada param/data)
    // ========================================
    // NOTA: El CDC se genera automáticamente dentro de generateXMLDE()
    const param = datosFactura.param || {};
    const timbrado = param.timbradoNumero || datosCompletos.timbrado || empresa.configuracionSifen.timbrado;

    // Fecha de inicio de vigencia del timbrado (dFeIniT): payload > empresa >
    // fecha de la factura como último recurso.
    let timbradoFecha;
    if (param.timbradoFecha) {
      timbradoFecha = param.timbradoFecha;
    } else if (empresa.configuracionSifen?.timbradoFecha) {
      timbradoFecha = empresa.configuracionSifen.timbradoFecha;
    } else if (datosCompletos.fecha) {
      // Extraer solo la fecha (YYYY-MM-DD) sin hora ni microsegundos
      timbradoFecha = datosCompletos.fecha.split('T')[0];
    }

    // Datos del emisor: lo que el payload no trae sale de la configuración de
    // la empresa (establecimientos, actividades, tipo de contribuyente, etc.),
    // así las integraciones pueden mandar solo cliente + items.
    const establecimientosEmpresa = empresa.establecimientos?.length
      ? empresa.establecimientos.map((e) => (e.toObject ? e.toObject() : e))
      : undefined;
    const actividadesEmpresa = empresa.actividadesEconomicas?.length
      ? empresa.actividadesEconomicas.map((a) => (a.toObject ? a.toObject() : a))
      : undefined;

    const params = {
      version: param.version || 150,
      ruc: param.ruc || empresa.ruc,
      razonSocial: param.razonSocial || empresa.razonSocial || param.nombreFantasia,
      nombreFantasia: param.nombreFantasia || empresa.nombreFantasia,
      actividadesEconomicas: param.actividadesEconomicas || actividadesEmpresa,
      timbradoNumero: timbrado,
      timbradoFecha: timbradoFecha,
      tipoContribuyente: param.tipoContribuyente ?? empresa.tipoContribuyente,
      // xmlgen emite cTipReg SIEMPRE (su guarda "typeof x != undefined" está
      // rota): si queda undefined sale <cTipReg/> vacío y SET rechaza con
      // "0160 cTipReg inválido". 8 = Régimen Contable como último recurso.
      tipoRegimen: param.tipoRegimen ?? empresa.tipoRegimen ?? 8,
      establecimientos: param.establecimientos || establecimientosEmpresa
    };

    await reportarProgreso(25);

    // ========================================
    // 4. Generar XML
    // ========================================
    console.log('📝 Generando XML...');

    // CRÍTICO: Convertir TODAS las fechas a formato SIFEN antes de pasar a xmlgen
    // La librería facturacionelectronicapy-xmlgen NO acepta fechas con 'Z' o milisegundos
    convertirFechasASIFEN(datosCompletos);  // ← Modifica el objeto en su lugar (sin reasignar)

    // xmlgen redondea a múltiplos de 50 Gs por defecto; solo corresponde con
    // pago 100 % en efectivo (utils/redondeoSedeco.js).
    const redondeoSedeco = aplicaRedondeoSedeco(datosCompletos);
    console.log(`🧮 Redondeo SEDECO: ${redondeoSedeco ? 'aplicado (pago en efectivo)' : 'no aplica'}`);

    const xmlGenerado = await FacturaElectronicaPY.generateXMLDE(params, datosCompletos, { redondeoSedeco });
    // El total que calculó facturaService es provisorio (sale del payload); el
    // del XML es el del documento, con descuentos y redondeo incluidos.
    const totalDocumento = extraerTotalGeneral(xmlGenerado);
    await reportarProgreso(35);

    // ========================================
    // 5. Firmar XML y extraer DigestValue + CDC
    // ========================================
    console.log('✍️  Firmando XML...');
    const rutaCertificado = empresa.obtenerRutaCertificado();
    const contrasena = certificadoService.descifrarContrasena(empresa.certificado.contrasena);

    // 🔧 IMPORTANTE: El 4to parámetro 'true' fuerza a usar Node.js en lugar de Java
    // Java 21 en Ubuntu 24.04 corrompe el encoding UTF-8
    const xmlFirmado = await xmlsign.signXML(xmlGenerado, rutaCertificado, contrasena, true);
    console.log('✅ XML firmado exitosamente');
    
    // EXTRAER DigestValue y CDC INMEDIATAMENTE (antes de enviar a SET)
    try {
      const xml2js = require('xml2js');
      const xmlFirmadoObj = await xml2js.parseStringPromise(xmlFirmado);

      // Extraer DigestValue de la firma digital
      // La estructura es: rDE > Signature > SignedInfo > Reference > DigestValue
      if (xmlFirmadoObj?.rDE?.Signature?.[0]?.SignedInfo?.[0]?.Reference?.[0]?.DigestValue?.[0]) {
        digestValueFirma = xmlFirmadoObj.rDE.Signature[0].SignedInfo[0].Reference[0].DigestValue[0];
      } else {
        console.warn('⚠️ No se encontró DigestValue en el XML firmado');
      }

      // Extraer CDC (Código de Control) del atributo Id del elemento DE
      // Ejemplo: <DE Id="01036040761001001000000322026022719876543220">
      if (xmlFirmadoObj?.rDE?.DE?.[0]?.$?.Id) {
        cdcFirma = xmlFirmadoObj.rDE.DE[0].$.Id;
      } else if (xmlFirmadoObj?.['rDE:DE']?.[0]?.$?.Id) {
        cdcFirma = xmlFirmadoObj['rDE:DE'][0].$.Id;
      } else {
        console.warn('⚠️ No se encontró CDC en el atributo Id del DE');
      }

      // GUARDAR DigestValue y CDC EN BD INMEDIATAMENTE
      if (invoiceId) {
        try {
          const Invoice = require('../models/Invoice');
          const updateData = {};
          if (digestValueFirma) updateData.digestValue = digestValueFirma;
          if (cdcFirma) {
            updateData.cdc = cdcFirma;
            // El CDC es la verdad sobre est-punto-numero del DTE: se refleja
            // en el correlativo local (un reintento pudo cambiar el punto).
            updateData.correlativo = `${cdcFirma.slice(11, 14)}-${cdcFirma.slice(14, 17)}-${cdcFirma.slice(17, 24)}`;
          }

          if (Object.keys(updateData).length > 0) {
            await Invoice.findByIdAndUpdate(invoiceId, {
              ...updateData,
              ...(totalDocumento !== null ? { total: totalDocumento } : {}),
              estadoSifen: 'enviado'  // Cambiar a 'enviado' mientras se procesa en SET
            });
          } else {
            console.warn('⚠️ No hay datos para guardar en BD');
          }
        } catch (dbErr) {
          console.warn('⚠️ No se pudo guardar en BD:', dbErr.message);
        }
      }
    } catch (err) {
      console.warn('⚠️ No se pudo extraer datos del XML firmado:', err.message);
      console.error(err);
    }
    
    await reportarProgreso(50);

    // ========================================
    // 6. Generar y agregar QR
    // ========================================
    console.log('📱 Generando QR...');
    const idCSC = empresa.configuracionSifen.idCSC;
    const CSC = empresa.configuracionSifen.csc;
    const ambiente = empresa.configuracionSifen.modo;

    const xmlConQR = await qr.generateQR(xmlFirmado, idCSC, CSC, ambiente);
    console.log('✅ QR generado e incrustado');
    await reportarProgreso(60);

    // ========================================
    // 7. GUARDAR XML INMEDIATAMENTE (ANTES DE ENVIAR A SET)
    // ========================================
    // CRÍTICO: Guardar el XML firmado ANTES de enviar a SET para no perderlo si falla la conexión
    const fecha = new Date();
    const anio = fecha.getFullYear();
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    const rutaSalida = path.join(__dirname, `../de_output/${empresa.ruc}/${anio}/${mes}`);

    if (!fs.existsSync(rutaSalida)) {
      fs.mkdirSync(rutaSalida, { recursive: true });
    }

    const correlativo = datosCompletos.encabezado?.idDoc?.correlativo;

    // Extraer datos del XML para el nombre del archivo
    let tipoDocumentoDescripcion;
    let serieDelXML = null;

    try {
      const xml2js = require('xml2js');
      const xmlObj = await xml2js.parseStringPromise(xmlConQR);
      if (xmlObj?.rDE?.DE?.[0]?.gTimb?.[0]?.dDesTiDE?.[0]) {
        tipoDocumentoDescripcion = xmlObj.rDE.DE[0].gTimb[0].dDesTiDE[0];
      }
      if (xmlObj?.rDE?.DE?.[0]?.gInfDoc?.[0]?.gSerieNum?.[0]?.dSerieNum?.[0]) {
        serieDelXML = xmlObj.rDE.DE[0].gInfDoc[0].gSerieNum[0].dSerieNum[0];
      }
    } catch (err) {
      console.warn('⚠️ No se pudo extraer dDesTiDE del XML:', err.message);
    }

    // Construir nombre del archivo
    const timbradoStr = datosCompletos.timbrado || datosCompletos.encabezado?.idDoc?.dNumTim || timbrado;
    const establecimientoStr = (datosCompletos.establecimiento?.toString() || datosCompletos.encabezado?.idDoc?.dEst?.toString() || '001').padStart(3, '0');
    const puntoStr = (datosCompletos.punto?.toString() || datosCompletos.encabezado?.idDoc?.dPunExp?.toString() || '001').padStart(3, '0');
    const numeroStr = (datosCompletos.numero?.toString() || datosCompletos.encabezado?.idDoc?.numDoc?.toString() || '').padStart(7, '0');

    // Normalizar nombre del archivo (igual que KUDE: sin acentos, espacios por guiones bajos)
    const tipoDocumentoNormalizado = tipoDocumentoDescripcion
      .normalize('NFD')                          // Separar caracteres con acentos
      .replace(/[\u0300-\u036f]/g, '')          // Eliminar acentos
      .replace(/ñ/gi, 'n')                       // Reemplazar ñ por n
      .replace(/\s+/g, '_');                     // Reemplazar espacios por guiones bajos

    let nombreArchivo = `${tipoDocumentoNormalizado}_${timbradoStr}-${establecimientoStr}-${puntoStr}-${numeroStr}`;
    if (serieDelXML) {
      nombreArchivo += `-${serieDelXML}`;
    }
    nombreArchivo += '.xml';

    const rutaArchivo = path.join(rutaSalida, nombreArchivo);
    fs.writeFileSync(rutaArchivo, xmlConQR, 'utf8');

    const xmlPathRelativo = `${empresa.ruc}/${anio}/${mes}/${nombreArchivo}`;
    console.log(`📁 XML guardado: ${rutaArchivo}`);
    await reportarProgreso(70);

    // ========================================
    // 9. Decidir modo de envío: normal vs lotes/contingencia
    // ========================================
    const tipoEmision = datosCompletos.tipoEmision || 1;
    const envioFacturas = empresa.configuracionSifen.envioFacturas || 'normal';
    const usarLote = tipoEmision === 2 || envioFacturas === 'lotes';
    const tipoDocumentoAux = datosCompletos.tipoDocumento || 1;

    if (usarLote) {
      await envioLoteService.agregarFacturaALote(invoiceId, cdcFirma, empresa, tipoDocumentoAux);
      console.log(`📦 Factura añadida a lote - tipoEmision: ${tipoEmision}, tipoDocumento: ${tipoDocumentoAux}`);

      await reportarProgreso(80);

      return {
        success: true,
        cdc: cdcFirma,
        xmlPath: xmlPathRelativo,
        xmlContent: xmlConQR,
        rutaArchivo: rutaArchivo,
        estado: 'encolado',
        estadoVisual: 'observado',
        codigoRetorno: null,
        mensajeRetorno: `Encolado para envío por lote (tipoEmision: ${tipoEmision})`,
        digestValue: digestValueFirma,
        fechaProceso: null,
        correlativo: correlativo,
        tipoEmision: tipoEmision,
        tipoDocumento: tipoDocumentoAux
      };
    }

    // ========================================
    // 10. Enviar a SET (modo normal)
    // ========================================
    console.log('📤 Enviando a SET...');
    const idDocumento = generarIdSifen();

    let soapResponse = null;
    let errorEnvio = null;

    try {
      soapResponse = await setApi.recibe(
        idDocumento,
        xmlConQR,
        ambiente,
        rutaCertificado,
        contrasena
      );
      await reportarProgreso(75);
    } catch (setErr) {
      // ⚠️ ERROR DE CONEXIÓN: No perder el XML ya generado
      errorEnvio = setErr;
      console.warn('⚠️ Error enviando a SET:', setErr.message);
      console.warn('⚠️ El XML firmado ya está guardado en:', rutaArchivo);
      
      // Continuar con estado de error
      soapResponse = null;
    }

    // ========================================
    // 11. Extraer datos de respuesta (o usar valores por error)
    // ========================================
    let codigoRetorno = '0000';
    let mensajeRetorno = null;
    let digestValueRespuesta = null;  // De la respuesta SOAP
    let fechaProceso = null;
    let estadoResultado = null;
    let estadoSifen = 'enviado';

    if (soapResponse) {
      codigoRetorno = extraerCodigoRetorno(soapResponse);
      mensajeRetorno = extraerMensajeRetorno(soapResponse);
      digestValueRespuesta = extraerDigestValue(soapResponse);
      fechaProceso = extraerFechaProceso(soapResponse);
      estadoResultado = extraerEstadoResultado(soapResponse);
      estadoSifen = determinarEstadoSegunCodigo(codigoRetorno);
      console.log(`📋 Código: ${codigoRetorno}, Estado: ${estadoSifen}`);
    } else {
      // Error de conexión: establecer estado de error
      estadoSifen = 'error';
      mensajeRetorno = errorEnvio?.message || 'Error de conexión con SET';
      codigoRetorno = '9999';
      console.log(`❌ Estado: ${estadoSifen} - ${mensajeRetorno}`);
    }

    // Calcular estado visual para el frontend (colores)
    const estadoVisual = determinarEstadoVisual(codigoRetorno);

    await reportarProgreso(80);

    // ========================================
    // 12. Retornar resultado
    // ========================================
    // NOTA: El CDC y DigestValue ya fueron guardados en BD después de firmar el XML
    return {
      success: true,
      cdc: cdcFirma,  // CDC extraído después de firmar
      xmlPath: xmlPathRelativo,  // Para BD
      xmlContent: xmlConQR,
      rutaArchivo: rutaArchivo,  // Ruta absoluta para KUDE
      estado: estadoSifen,
      estadoVisual: estadoVisual,  // Para colores en frontend
      codigoRetorno: codigoRetorno,
      mensajeRetorno: mensajeRetorno,
      digestValue: digestValueFirma,  // DigestValue extraído después de firmar
      fechaProceso: fechaProceso,
      correlativo: correlativo
    };

  } catch (error) {
    console.error('❌ Error procesando factura:', error);
    throw error;
  }
}

/**
 * Generar KUDE (PDF) desde XML
 * El JAR genera el PDF con el nombre: {tipoDocumento}_{timbrado}-{establecimiento}-{punto}-{numero}[-{serie}].pdf
 */
async function generarKUDE(xmlContenido, cdc, correlativo, fechaCreacion, datosFactura = null, empresa = null) {
  try {
    console.log('📄 Generando KUDE...');

    const fs = require('fs');
    const path = require('path');

    const destFolder = path.join(__dirname, `../de_output`,
                                  empresa.ruc,
                                  fechaCreacion.getFullYear().toString(),
                                  String(fechaCreacion.getMonth() + 1).padStart(2, '0'), '/');
                                  
    const env = empresa.configuracionSifen.modo;
    // Convención de la plantilla jasper: "0" imprime "Ambiente NO CONECTADO
    // a la SET" (contingencia), "1" imprime "Ambiente de PRUEBA", cualquier
    // otro valor no imprime leyenda (producción normal). Antes producción
    // mandaba "0" y todos los KUDE salían con la leyenda de contingencia.
    const jsonParam = {
      ambiente: env == "produccion" ? "2" : "1",
      LOGO_URL: empresa?.configuracionSifen?.urlLogo || "https://res.cloudinary.com/dficj0aam/image/upload/v1775702075/invoice_axiuol.png",
      active: true,
      template: datosFactura?.data?.templateFactura || datosFactura?.templateFactura || "normal"
    };

    // ========================================
    // CREAR ARCHIVO TEMPORAL PARA EL JAR
    // ========================================
    const nombreTemporal = `xml_temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.xml`;
    const dirTemporal = path.join(__dirname, '../de_output');
    const rutaTemporal = path.join(dirTemporal, nombreTemporal);
    let archivoTemporal = null;

    // Escribir XML a archivo temporal
    try {
      fs.writeFileSync(rutaTemporal, xmlContenido, 'utf-8');
      archivoTemporal = rutaTemporal;
    } catch (err) {
      console.error('❌ No se pudo escribir el archivo temporal:', err.message);
      throw err;
    }

    try {
      await generarKudePdf({
        xmlPath: archivoTemporal,
        destFolder,
        params: jsonParam
      });
    } finally {
      if (archivoTemporal && fs.existsSync(archivoTemporal)) {
        try {
          fs.unlinkSync(archivoTemporal);
          console.log('🧹 Archivo temporal eliminado:', archivoTemporal);
        } catch (err) {
          console.warn('⚠️ No se pudo eliminar archivo temporal:', err.message);
        }
      }
    }

    // ========================================
    // BUSCAR EL PDF GENERADO POR EL JAR
    // ========================================
    let timbrado;
    let tipoDocumentoDescripcion;
    try {
      const xml2js = require('xml2js');
      const xmlObj = await xml2js.parseStringPromise(xmlContenido);

      if (xmlObj?.rDE?.DE?.[0]?.gTimb?.[0]?.dNumTim?.[0]) {
        timbrado = xmlObj.rDE.DE[0].gTimb[0].dNumTim[0];
      }
      if (xmlObj?.rDE?.DE?.[0]?.gTimb?.[0]?.dDesTiDE?.[0]) {
        tipoDocumentoDescripcion = xmlObj.rDE.DE[0].gTimb[0].dDesTiDE[0];
      }
    } catch (err) {
      console.warn('⚠️ No se pudo extraer timbrado del XML:', err.message);
    }

    // Normalizar tipo de documento (igual que XML: sin acentos, espacios por guiones bajos)
    const tipoDocumentoNormalizado = tipoDocumentoDescripcion
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ñ/gi, 'n')
      .replace(/\s+/g, '_');

    // Extraer establecimiento, punto y número DIRECTAMENTE de datosFactura
    // para evitar inconsistencias entre el correlativo y los datos reales del JSON
    let establecimientoStr, puntoStr, numeroFactura;

    if (datosFactura) {
      // Intentar extraer de datosFactura.data (estructura ERPNext)
      const datosData = datosFactura.data || datosFactura;
      establecimientoStr = String(datosData.establecimiento).padStart(3, '0');
      puntoStr = String(datosData.punto).padStart(3, '0');
      numeroFactura = String(datosData.numero || correlativo.split('-')[2]).padStart(7, '0');
    } else if (correlativo.includes('-')) {
      // Fallback: formato con guiones: 001-001-0000001
      const partes = correlativo.split('-');
      establecimientoStr = partes[0];
      puntoStr = partes[1];
      numeroFactura = partes[2];
    } else {
      // Fallback: formato sin guiones: 0010010000001
      establecimientoStr = correlativo.substring(0, 3);
      puntoStr = correlativo.substring(3, 6);
      numeroFactura = correlativo.substring(6);
    }

    // Construir nombre del PDF (mismo formato que el XML normalizado)
    // El JAR de KUDE genera nombres normalizados: sin acentos, espacios por guiones bajos
    const pdfFileName = `${tipoDocumentoNormalizado}_${timbrado}-${establecimientoStr}-${puntoStr}-${numeroFactura}.pdf`;

    const pdfPath = path.join(destFolder, pdfFileName);
    
    if (fs.existsSync(pdfPath)) {
      console.log(`✅ KUDE generado: ${pdfPath}`);
      return pdfPath;
    } else {
      console.warn(`⚠️ PDF no encontrado: ${pdfPath}`);
      throw new Error(`PDF no encontrado: ${pdfFileName}`);
    }

  } catch (error) {
    console.warn('⚠️ Error generando KUDE:', error.message);
    return null;
  }
}

module.exports = {
  procesarFactura,
  generarKUDE,
  extraerTotalGeneral
};
