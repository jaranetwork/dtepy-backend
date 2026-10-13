const express = require('express');
const router = express.Router();
const OperationLog = require('../models/OperationLog');
const { verificarToken, verificarPermiso, requerirSesionAdmin } = require('../middleware/auth');

router.use(verificarToken, verificarPermiso('stats:leer'));

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 15, estado, tipoOperacion, invoiceId, search } = req.query;

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { fecha: -1 }
    };

    const filtro = {};
    if (estado && estado !== 'all') {
      filtro.estado = estado;
    }
    if (tipoOperacion) {
      filtro.tipoOperacion = tipoOperacion;
    }
    if (invoiceId) {
      filtro.invoiceId = invoiceId;
    }
    if (search) {
      // Texto literal (sin esto, un patrón hostil permite ReDoS)
      const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filtro.$or = [{ descripcion: re }, { tipoOperacion: re }];
    }

    const skip = (options.page - 1) * options.limit;
    const logs = await OperationLog.find(filtro)
      .sort(options.sort)
      .skip(skip)
      .limit(options.limit)
      .populate('invoiceId', 'correlativo cdc estadoSifen');

    const total = await OperationLog.countDocuments(filtro);
    const totalPages = Math.ceil(total / options.limit);

    res.status(200).json({
      success: true,
      logs: logs.map(log => ({
        _id: log._id,
        invoiceId: log.invoiceId ? {
          _id: log.invoiceId._id,
          correlativo: log.invoiceId.correlativo,
          cdc: log.invoiceId.cdc,
          estadoSifen: log.invoiceId.estadoSifen
        } : null,
        tipoOperacion: log.tipoOperacion,
        descripcion: log.descripcion,
        estado: log.estado,
        fecha: log.fecha,
        detalle: log.detalle
      })),
      total,
      page: options.page,
      limit: options.limit,
      totalPages
    });
  } catch (error) {
    console.error('Error al obtener logs:', error);
    res.status(500).json({ success: false, error: 'LOGS_ERROR', message: 'Error al obtener logs' });
  }
});

router.delete('/clear', requerirSesionAdmin, async (req, res) => {
  try {
    const { tipo } = req.query;

    let filtro = {};
    if (tipo && tipo !== 'all') {
      filtro.estado = tipo;
    }

    const result = await OperationLog.deleteMany(filtro);

    console.log(`🗑️ Logs eliminados: ${result.deletedCount} registros (filtro: ${tipo || 'todos'})`);

    res.status(200).json({
      success: true,
      message: `Se eliminaron ${result.deletedCount} registros de logs`,
      data: { deletedCount: result.deletedCount }
    });
  } catch (error) {
    console.error('Error al limpiar logs:', error);
    res.status(500).json({
      success: false,
      error: 'LOGS_CLEAR_ERROR',
      message: 'Error al limpiar logs'
    });
  }
});

module.exports = router;
