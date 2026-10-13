const express = require('express');
const router = express.Router();
const { generarIdSifen } = require('../utils/idSifen');
const { verificarToken, verificarPermiso } = require('../middleware/auth');
const { cargarAlcance, empresaParaConsultas } = require('../middleware/alcance');
const { resolverCertificadoEmpresa } = require('../services/certificadoService');

router.use(verificarToken, verificarPermiso('facturas:leer'), cargarAlcance);

/**
 * SIFEN exige el RUC SIN dígito verificador en dRUCCons: con el DV (o el
 * guión) el request no pasa la validación XSD y SET responde
 * "0160: XML Mal Formado". Acá se acepta cualquier formato y se normaliza.
 *   "80055783-2" -> "80055783"
 *   "80055783"   -> "80055783"
 */
function rucSinDv(ruc) {
  const limpio = String(ruc).trim();
  if (limpio.includes('-')) {
    return limpio.split('-')[0].replace(/[^0-9]/g, '');
  }
  return limpio.replace(/[^0-9]/g, '');
}

/**
 * Convierte la respuesta SOAP de SET (claves con namespace ns2:) en un
 * objeto plano y tipado. Devuelve null si la estructura no es la esperada.
 */
function interpretarRespuestaSet(respuesta) {
  const cuerpo = respuesta?.['ns2:rResEnviConsRUC'];
  if (!cuerpo) return null;

  const contenido = cuerpo['ns2:xContRUC'] || {};
  return {
    codigo: cuerpo['ns2:dCodRes'] || null,          // 0502 = RUC encontrado
    mensaje: cuerpo['ns2:dMsgRes'] || null,
    razonSocial: (contenido['ns2:dRazCons'] || '').trim() || null,
    estado: contenido['ns2:dCodEstCons'] || null,    // ACT, SUS, ...
    estadoDescripcion: contenido['ns2:dDesEstCons'] || null,
    facturadorElectronico: contenido['ns2:dRUCFactElec'] === 'S'
  };
}

router.get('/ruc/:ruc', async (req, res) => {
  try {
    const rucOriginal = String(req.params.ruc || '').trim();
    const ruc = rucSinDv(rucOriginal);

    if (!ruc) {
      return res.status(400).json({ success: false, error: 'RUC_REQUIRED', message: 'RUC requerido' });
    }

    // La consulta a SET va firmada: se usa el certificado de una empresa
    // del alcance.
    const empresa = await empresaParaConsultas(req);
    if (!empresa) {
      return res.status(400).json({
        success: false,
        error: 'CERTIFICADO_NO_DISPONIBLE',
        message: 'Para consultar a SIFEN se necesita una empresa con certificado digital activo'
      });
    }

    let respuesta;
    try {
      const setApi = require('../services/setapi-wrapper');
      const ambiente = empresa.configuracionSifen?.modo || 'test';
      const cert = resolverCertificadoEmpresa(empresa);

      respuesta = await setApi.consultaRUC(generarIdSifen(), ruc, ambiente, cert.ruta, cert.contrasena);
    } catch (error) {
      // Fallo de transporte: certificado, red, SET caído.
      console.error('Error consultando RUC en SET:', error.message);
      return res.status(502).json({
        success: false,
        error: 'CONSULTA_SET_ERROR',
        message: `No se pudo consultar el RUC en SET: ${error.message}`,
        data: { ruc, encontrado: false }
      });
    }

    const resultado = interpretarRespuestaSet(respuesta);

    // SET respondió con otra estructura (rechazo de validación, etc.):
    // no inventar un "encontrado", exponer el motivo.
    if (!resultado) {
      console.error('Respuesta inesperada de SET en consulta de RUC:', JSON.stringify(respuesta).slice(0, 500));
      return res.status(502).json({
        success: false,
        error: 'CONSULTA_SET_RESPUESTA_INESPERADA',
        message: 'SET devolvió una respuesta con estructura inesperada',
        data: { ruc, encontrado: false, respuestaCruda: respuesta }
      });
    }

    const encontrado = resultado.codigo === '0502';

    return res.status(encontrado ? 200 : 404).json({
      success: encontrado,
      ...(encontrado ? {} : { error: 'RUC_NOT_FOUND' }),
      message: resultado.mensaje,
      data: {
        ruc,
        encontrado,
        razonSocial: resultado.razonSocial,
        estado: resultado.estado,
        estadoDescripcion: resultado.estadoDescripcion,
        facturadorElectronico: resultado.facturadorElectronico,
        codigoSet: resultado.codigo
      }
    });
  } catch (error) {
    console.error('Error al consultar RUC:', error);
    res.status(500).json({ success: false, error: 'CONSULTA_ERROR', message: 'Error al consultar RUC' });
  }
});

module.exports = router;
