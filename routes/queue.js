const express = require('express');
const router = express.Router();
const { verificarToken, verificarPermiso, requerirSesionAdmin } = require('../middleware/auth');

router.use(verificarToken);

// Lecturas: cualquier sesión, o API Key con stats:leer.
// Limpiezas: solo sesión admin (clear-all descarta trabajos pendientes).

router.get('/stats', verificarPermiso('stats:leer'), async (req, res) => {
  try {
    const { getQueueStats } = require('../queues/facturaQueue');
    const stats = await getQueueStats();

    res.json({
      success: true,
      message: 'Estadísticas de cola obtenidas',
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'QUEUE_ERROR',
      message: error.message
    });
  }
});

router.get('/jobs', verificarPermiso('stats:leer'), async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const { getRecentJobs } = require('../queues/facturaQueue');
    const jobs = await getRecentJobs(parseInt(limit));

    res.json({
      success: true,
      message: 'Jobs recientes obtenidos',
      data: jobs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'QUEUE_ERROR',
      message: error.message
    });
  }
});

router.post('/clear', requerirSesionAdmin, async (req, res) => {
  try {
    const { queue = 'facturacion', keep = 0 } = req.body;
    const { facturaQueue, kudeQueue, cleanCompletedJobs } = require('../queues/facturaQueue');

    const targetQueue = queue === 'kude' ? kudeQueue : facturaQueue;
    const removed = await cleanCompletedJobs(targetQueue, keep);

    res.json({
      success: true,
      message: `Se eliminaron ${removed} jobs completados de la cola ${queue}`,
      data: { removed, queue, keep }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'QUEUE_ERROR',
      message: error.message
    });
  }
});

router.post('/clear-failed', requerirSesionAdmin, async (req, res) => {
  try {
    const { queue = 'facturacion' } = req.body;
    const { facturaQueue, kudeQueue, cleanFailedJobs } = require('../queues/facturaQueue');

    const targetQueue = queue === 'kude' ? kudeQueue : facturaQueue;
    const removed = await cleanFailedJobs(targetQueue);

    res.json({
      success: true,
      message: `Se eliminaron ${removed} jobs fallidos de la cola ${queue}`,
      data: { removed, queue }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'QUEUE_ERROR',
      message: error.message
    });
  }
});

router.post('/clear-all', requerirSesionAdmin, async (req, res) => {
  try {
    const { queue = 'facturacion' } = req.body;
    const { facturaQueue, kudeQueue, cleanAllJobs } = require('../queues/facturaQueue');

    const targetQueue = queue === 'kude' ? kudeQueue : facturaQueue;
    const removed = await cleanAllJobs(targetQueue);

    res.json({
      success: true,
      message: `Se eliminaron ${removed} jobs de la cola ${queue}`,
      data: { removed, queue }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'QUEUE_ERROR',
      message: error.message
    });
  }
});

router.post('/clear-completed', requerirSesionAdmin, async (req, res) => {
  try {
    const { queue = 'facturacion', keep = 0 } = req.body;
    const { facturaQueue, kudeQueue, cleanCompletedJobs } = require('../queues/facturaQueue');

    const targetQueue = queue === 'kude' ? kudeQueue : facturaQueue;
    const removed = await cleanCompletedJobs(targetQueue, keep);

    res.json({
      success: true,
      message: `Se eliminaron ${removed} jobs completados de la cola ${queue}`,
      data: { removed, queue, keep }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'QUEUE_ERROR',
      message: error.message
    });
  }
});

module.exports = router;
