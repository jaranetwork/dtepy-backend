const express = require('express');
const router = express.Router();
const { verificarToken, verificarPermiso } = require('../middleware/auth');
const { cargarAlcance } = require('../middleware/alcance');
const facturaController = require('../controllers/facturaController');

router.use(verificarToken, cargarAlcance);

router.post('/crear', verificarPermiso('facturas:crear'), facturaController.crear);

// Dry-run: valida el receptor con las mismas reglas que /crear, sin emitir.
// Pensado para que el checkout calcule su "invoice readiness" antes de cobrar.
router.post('/validar', verificarPermiso('facturas:leer'), facturaController.validar);

router.get('/empresa/:ruc', verificarPermiso('facturas:leer'), facturaController.obtenerEmpresa);

module.exports = router;
