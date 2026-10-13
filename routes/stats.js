const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
const { verificarToken, verificarPermiso } = require('../middleware/auth');
const { cargarAlcance, filtroEmpresa } = require('../middleware/alcance');

// Igual que el resto de las rutas: sin token o API Key no se exponen datos
// de facturación (era la única ruta sin autenticación).
router.use(verificarToken, verificarPermiso('stats:leer'), cargarAlcance);

router.get('/', async (req, res) => {
  try {
    // Metricas restringidas a las empresas del alcance (admin ve todo)
    const alcance = filtroEmpresa(req);
    if (req.query.rucEmpresa) alcance.rucEmpresa = String(req.query.rucEmpresa);

    const totalFacturas = await Invoice.countDocuments(alcance);
    const facturasPorEstado = await Invoice.aggregate([
      { $match: alcance },
      { $group: { _id: '$estadoSifen', count: { $sum: 1 } } }
    ]);

    const facturasProcesando = await Invoice.countDocuments({ estadoSifen: 'procesando', ...alcance });
    const facturasEnviadas = await Invoice.countDocuments({ estadoSifen: 'enviado', ...alcance });
    const facturasError = await Invoice.countDocuments({ estadoSifen: 'error', ...alcance });
    const facturasRechazadas = await Invoice.countDocuments({ estadoSifen: 'rechazado', ...alcance });
    const facturasAceptadas = await Invoice.countDocuments({ estadoSifen: 'aceptado', ...alcance });

    const facturasHoy = await Invoice.countDocuments({
      ...alcance,
      fechaCreacion: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0)),
        $lt: new Date()
      }
    });

    const ultimasFacturas = await Invoice.find(alcance)
      .sort({ fechaCreacion: -1 })
      .limit(10)
      .select('correlativo cdc estadoSifen fechaCreacion total');

    const hace7Dias = new Date();
    hace7Dias.setDate(hace7Dias.getDate() - 7);

    const tendenciasPorDia = await Invoice.aggregate([
      { $match: { fechaCreacion: { $gte: hace7Dias }, ...alcance } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$fechaCreacion' } }, count: { $sum: 1 }, total: { $sum: '$total' } } },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      success: true,
      data: {
        totalFacturas,
        facturasPorEstado,
        facturasProcesando,
        facturasEnviadas,
        facturasError,
        facturasRechazadas,
        facturasAceptadas,
        facturasHoy,
        ultimasFacturas,
        tendenciasPorDia,
        fechaUltimaConsulta: new Date(),
        uptime: process.uptime(),
        memoria: process.memoryUsage()
      }
    });
  } catch (error) {
    console.error('Error en /api/stats:', error);
    res.json({
      success: true,
      data: {
        totalFacturas: 0,
        facturasPorEstado: [],
        facturasProcesando: 0,
        facturasEnviadas: 0,
        facturasError: 0,
        facturasRechazadas: 0,
        facturasAceptadas: 0,
        facturasHoy: 0,
        ultimasFacturas: [],
        fechaUltimaConsulta: new Date(),
        uptime: process.uptime(),
        memoria: process.memoryUsage()
      }
    });
  }
});

module.exports = router;
