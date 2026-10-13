const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
const { verificarToken, verificarPermiso } = require('../middleware/auth');
const { cargarAlcance, perteneceAlAlcance } = require('../middleware/alcance');

router.use(verificarToken, verificarPermiso('facturas:leer'), cargarAlcance);

router.get('/estado/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const invoice = await Invoice.findById(id);
    if (!invoice || !perteneceAlAlcance(req, invoice.empresaId)) {
      return res.status(404).json({
        success: false,
        error: 'FACTURA_NOT_FOUND',
        message: 'Factura no encontrada'
      });
    }

    let jobStatus = null;
    let jobProgress = 0;
    let jobAttempts = 0;
    let failedReason = null;

    try {
      const { facturaQueue } = require('../queues/facturaQueue');
      const job = await facturaQueue.getJob(`factura-${id}`);

      if (job) {
        jobStatus = await job.getState();
        jobProgress = await job.progress();
        jobAttempts = job.attemptsMade || 0;

        if (jobStatus === 'failed') {
          failedReason = job.failedReason;
        }
      }
    } catch (queueError) {
      console.warn('⚠️ No se pudo obtener estado del job:', queueError.message);
    }

    res.json({
      success: true,
      message: 'Estado de factura obtenido exitosamente',
      data: {
        facturaId: invoice._id,
        correlativo: invoice.correlativo,
        estado: invoice.estadoSifen,
        cdc: invoice.cdc,
        codigoRetorno: invoice.codigoRetorno,
        mensajeRetorno: invoice.mensajeRetorno,
        fechaCreacion: invoice.fechaCreacion,
        fechaEnvio: invoice.fechaEnvio,
        tipoEmision: invoice.tipoEmision || 1,
        grupoLoteId: invoice.grupoLoteId || null,
        proceso: invoice.proceso || null,
        job: {
          status: jobStatus,
          progress: jobProgress,
          attempts: jobAttempts,
          failedReason: failedReason
        }
      }
    });

  } catch (error) {
    console.error('Error consultando estado:', error);
    res.status(500).json({
      success: false,
      error: 'ESTADO_ERROR',
      message: 'Error al consultar estado de factura'
    });
  }
});

module.exports = router;
