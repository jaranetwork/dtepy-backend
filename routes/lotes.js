const express = require('express');
const router = express.Router();
const LoteEnvio = require('../models/LoteEnvio');
const Invoice = require('../models/Invoice');
const envioLoteService = require('../services/envioLoteService');
const { verificarToken, verificarPermiso } = require('../middleware/auth');
const { cargarAlcance, filtroEmpresa, perteneceAlAlcance } = require('../middleware/alcance');

router.use(verificarToken, verificarPermiso('facturas:leer'), cargarAlcance);

router.get('/list', async (req, res) => {
  try {
    const { estado, empresaId, tipoDocumento, page = 1, limit = 20, rucEmpresa } = req.query;
    const filtro = {};
    if (estado) filtro.estado = estado;
    if (empresaId) filtro.empresaId = empresaId;
    if (rucEmpresa) {
      const Empresa = require('../models/Empresa');
      const empresa = await Empresa.findOne({ ruc: String(rucEmpresa) }).select('_id');
      filtro.empresaId = empresa ? empresa._id : null;
    }
    if (tipoDocumento) filtro.tipoDocumento = parseInt(tipoDocumento);

    const options = {
      sort: { createdAt: -1 },
      limit: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit)
    };

    Object.assign(filtro, filtroEmpresa(req));

    const lotes = await LoteEnvio.find(filtro, null, options)
      .populate('empresaId', 'ruc nombreFantasia razonSocial')
      .populate('facturas.facturaId', 'correlativo cdc estadoSifen');
    const total = await LoteEnvio.countDocuments(filtro);

    res.json({
      success: true,
      data: lotes,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (error) {
    console.error('Error listando lotes:', error);
    res.status(500).json({ success: false,       error: 'LOTES_ERROR',
      message: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const lote = await LoteEnvio.findById(req.params.id)
      .populate('empresaId', 'ruc nombreFantasia razonSocial')
      .populate('facturas.facturaId', 'correlativo cdc estadoSifen xmlPath');

    if (!lote || !perteneceAlAlcance(req, lote.empresaId)) {
      return res.status(404).json({ success: false, error: 'LOTE_NOT_FOUND', message: 'Lote no encontrado' });
    }

    res.json({ success: true, data: lote });
  } catch (error) {
    console.error('Error obteniendo lote:', error);
    res.status(500).json({ success: false,       error: 'LOTES_ERROR',
      message: error.message });
  }
});

router.post('/enviar/:id', verificarPermiso('facturas:crear'), async (req, res) => {
  try {
    const loteDoc = await LoteEnvio.findById(req.params.id).select('empresaId');
    if (!loteDoc || !perteneceAlAlcance(req, loteDoc.empresaId)) {
      return res.status(404).json({ success: false, error: 'LOTE_NOT_FOUND', message: 'Lote no encontrado' });
    }

    const lote = await envioLoteService.enviarLote(req.params.id);
    res.json({ success: true, data: lote, message: 'Lote enviado a SIFEN' });
  } catch (error) {
    console.error('Error enviando lote:', error);
    res.status(500).json({ success: false,       error: 'LOTES_ERROR',
      message: error.message });
  }
});

router.post('/enviar-pendientes', verificarPermiso('facturas:crear'), async (req, res) => {
  try {
    const resultados = await envioLoteService.enviarPendientes();
    res.json({ success: true, data: resultados });
  } catch (error) {
    console.error('Error enviando pendientes:', error);
    res.status(500).json({ success: false,       error: 'LOTES_ERROR',
      message: error.message });
  }
});

router.post('/consultar/:id', verificarPermiso('facturas:crear'), async (req, res) => {
  try {
    const loteDoc = await LoteEnvio.findById(req.params.id).select('empresaId');
    if (!loteDoc || !perteneceAlAlcance(req, loteDoc.empresaId)) {
      return res.status(404).json({ success: false, error: 'LOTE_NOT_FOUND', message: 'Lote no encontrado' });
    }

    const resultado = await envioLoteService.consultarResultadoLote(req.params.id);
    res.json({ success: true, data: resultado });
  } catch (error) {
    console.error('Error consultando lote:', error);
    res.status(500).json({ success: false,       error: 'LOTES_ERROR',
      message: error.message });
  }
});

router.delete('/:id', verificarPermiso('facturas:eliminar'), async (req, res) => {
  try {
    const { id } = req.params;

    const lote = await LoteEnvio.findById(id);
    if (!lote || !perteneceAlAlcance(req, lote.empresaId)) {
      return res.status(404).json({ success: false, error: 'LOTE_NOT_FOUND', message: 'Lote no encontrado' });
    }

    if (!['en_espera', 'error'].includes(lote.estado)) {
      return res.status(400).json({
        success: false,
        error: 'LOTE_INVALID_STATE',
        message: 'Solo se pueden eliminar lotes en estado "en_espera" o "error"'
      });
    }

    // Desvincular facturas del lote
    const facturaIds = lote.facturas.map(f => f.facturaId).filter(Boolean);
    if (facturaIds.length > 0) {
      await Invoice.updateMany(
        { _id: { $in: facturaIds } },
        { $unset: { grupoLoteId: '' } }
      );
    }

    await LoteEnvio.findByIdAndDelete(id);

    res.json({
      success: true,
      message: 'Lote eliminado correctamente',
      facturasDesvinculadas: facturaIds.length
    });
  } catch (error) {
    console.error('Error eliminando lote:', error);
    res.status(500).json({ success: false,       error: 'LOTES_ERROR',
      message: error.message });
  }
});

module.exports = router;
