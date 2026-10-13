/**
 * Rutas para gestión de empresas
 * Todas las rutas requieren autenticación
 */

const express = require('express');
const router = express.Router();
const { verificarToken, verificarPermiso, requerirSesionUsuario } = require('../middleware/auth');
const { upload, manejarErrorUpload } = require('../middleware/upload');
const empresaController = require('../controllers/empresaController');

// Todas las rutas requieren autenticación.
// Lecturas: sesión JWT, o API Key con 'facturas:leer'.
// Mutaciones (crear/editar/eliminar/subir certificado): SOLO sesión JWT —
// una API Key filtrada no debe poder cambiar la configuración tributaria
// ni reemplazar el certificado con el que se firma.
router.use(verificarToken);

/**
 * @route   GET /api/empresas
 * @desc    Listar todas las empresas del usuario
 * @access  Privada (requiere JWT o API Key)
 */
router.get('/', verificarPermiso('facturas:leer'), empresaController.listar);

/**
 * @route   POST /api/empresas
 * @desc    Crear una nueva empresa
 * @access  Privada (requiere JWT o API Key)
 */
router.post('/', requerirSesionUsuario, empresaController.crear);

/**
 * @route   GET /api/empresas/:id
 * @desc    Obtener detalles de una empresa
 * @access  Privada (requiere JWT o API Key)
 */
router.get('/:id', verificarPermiso('facturas:leer'), empresaController.obtener);

/**
 * @route   PUT /api/empresas/:id
 * @desc    Actualizar empresa existente
 * @access  Privada (requiere JWT o API Key)
 */
router.put('/:id', requerirSesionUsuario, empresaController.actualizar);

/**
 * @route   DELETE /api/empresas/:id
 * @desc    Eliminar empresa
 * @access  Privada (requiere JWT o API Key)
 */
router.delete('/:id', requerirSesionUsuario, empresaController.eliminar);

/**
 * @route   POST /api/empresas/:id/certificado
 * @desc    Subir/actualizar certificado digital
 * @access  Privada (requiere JWT o API Key)
 */
router.post(
  '/:id/certificado',
  requerirSesionUsuario,
  upload.single('certificado'),
  manejarErrorUpload,
  empresaController.subirCertificado
);

/**
 * @route   GET /api/empresas/:id/validar-certificado
 * @desc    Validar certificado de una empresa
 * @access  Privada (requiere JWT o API Key)
 */
router.get('/:id/validar-certificado', verificarPermiso('facturas:leer'), empresaController.validarCertificado);

/**
 * @route   GET /api/empresas/:id/stats
 * @desc    Obtener estadísticas de una empresa
 * @access  Privada (requiere JWT o API Key)
 */
router.get('/:id/stats', verificarPermiso('facturas:leer'), empresaController.obtenerStats);

module.exports = router;
