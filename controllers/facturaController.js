const { crearFactura } = require('../services/facturaService');
const { buscarEmpresaPorRUC } = require('../services/empresaService');
const { perteneceAlAlcance } = require('../middleware/alcance');
const { resolverCambioParaEmision } = require('../services/cotizacionService');

exports.crear = async (req, res) => {
  try {
    // El emisor tiene que estar dentro del alcance del token: una API Key
    // de un usuario no puede emitir a nombre de la empresa de otro.
    const rucEmisor = req.body?.param?.ruc || req.body?.ruc;
    const empresaEmisora = await buscarEmpresaPorRUC(String(rucEmisor || '').trim());
    if (empresaEmisora && !perteneceAlAlcance(req, empresaEmisora._id)) {
      return res.status(403).json({
        success: false,
        error: 'EMPRESA_FUERA_DE_ALCANCE',
        message: 'El RUC emisor no corresponde a una empresa de este usuario o API Key'
      });
    }

    // Moneda extranjera sin data.cambio: se completa con la cotización
    // DECLARADA por el usuario (vigente). Sin cotización declarada y sin
    // cambio en el payload, la emisión se rechaza (COTIZACION_FALTANTE) —
    // el valor queda congelado acá, al momento de la emisión.
    if (empresaEmisora) {
      const resolucion = await resolverCambioParaEmision(req.body?.data || req.body, empresaEmisora._id);
      if (resolucion.aplicado && resolucion.origen === 'declarada') {
        console.log(`💱 Cambio ${resolucion.moneda} tomado de la cotización declarada: ${resolucion.cambio} Gs`);
      }
    }

    // Idempotency-Key (header estándar): si la respuesta de un POST anterior se
    // perdió, repetirlo con la misma clave devuelve la factura ya creada en
    // vez de emitir otra con otro número.
    const resultado = await crearFactura(req.body, { claveIdempotencia: req.get('Idempotency-Key') });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const facturaId = resultado.facturaId;

    const data = {
      facturaId,
      correlativo: resultado.correlativo,
      estado: resultado.estado,
      proceso: resultado.proceso,
      cdc: resultado.cdc || null,
      xmlLink: `${baseUrl}/api/invoices/${facturaId}/download-xml`,
      kudeLink: `${baseUrl}/api/invoices/${facturaId}/download-pdf`,
      urls: {
        estado: `/api/factura/estado/${facturaId}`,
        consulta: `/api/invoices/${facturaId}`
      }
    };

    if (resultado.tipo === 'idempotente') {
      data.idempotente = true;
      return res.status(200).json({
        success: true,
        message: 'La factura ya existía para esta Idempotency-Key: se devuelve la existente, no se creó otra',
        data
      });
    }

    if (resultado.tipo === 'pdf_regeneracion') {
      data.kudeJobId = resultado.kudeJobId;
      return res.status(202).json({
        success: true,
        message: 'PDF encolado para regeneración (factura ya aprobada por SET)',
        data
      });
    }

    if (resultado.tipo === 'reintento') {
      data.jobId = resultado.jobId;
      data.reintentando = true;
      data.intentoAnterior = resultado.intentoAnterior;
      return res.status(202).json({
        success: true,
        message: 'Factura encolada para procesamiento asíncrono (reintentando proceso fallido)',
        data
      });
    }

    data.jobId = resultado.jobId;
    res.status(202).json({
      success: true,
      message: 'Factura encolada para procesamiento asíncrono',
      data
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const errorCode = error.errorCode || 'INTERNAL_ERROR';
    const response = { success: false, error: errorCode, message: error.message };
    if (error.detalles) response.detalles = error.detalles;
    res.status(statusCode).json(response);
  }
};

exports.obtenerEmpresa = async (req, res) => {
  try {
    const ruc = req.params.ruc?.trim();
    if (!ruc) {
      return res.status(400).json({ success: false, error: 'RUC_REQUIRED', message: 'RUC requerido' });
    }

    const empresa = await buscarEmpresaPorRUC(ruc);
    if (!empresa || !perteneceAlAlcance(req, empresa._id)) {
      return res.status(404).json({ success: false, error: 'EMPRESA_NOT_FOUND', message: `No se encontró una empresa con RUC ${ruc}` });
    }

    res.json({
      success: true,
      data: {
        ruc: empresa.ruc,
        nombreFantasia: empresa.nombreFantasia,
        razonSocial: empresa.razonSocial,
        tieneCertificadoValido: empresa.tieneCertificadoValido(),
        activo: empresa.activo
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'Error al obtener empresa' });
  }
};

/**
 * POST /api/facturar/validar — dry-run del receptor.
 *
 * Corre exactamente la misma validación/normalización que /crear aplica antes
 * de emitir, sin crear nada. El integrador (el checkout del e-commerce) lo usa
 * para saber ANTES de cobrar si el cliente está completo para facturar, y qué
 * corregir si no ("invoice readiness").
 */
exports.validar = async (req, res) => {
  try {
    const { validarReceptor } = require('../services/receptorValidator');
    const data = req.body?.data || req.body || {};
    const resultado = validarReceptor(data);
    res.json({
      success: true,
      valido: resultado.errores.length === 0,
      errores: resultado.errores,
      advertencias: resultado.advertencias,
      clienteNormalizado: resultado.cliente
    });
  } catch (error) {
    console.error('Error en /facturar/validar:', error);
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'Error al validar el receptor' });
  }
};
