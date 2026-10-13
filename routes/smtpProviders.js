/**
 * Rutas para gestión de proveedores SMTP
 * Solo sesión JWT (UI): una API Key no debe poder leer ni cambiar la
 * configuración de correo con la que se envían los KUDE.
 */

const express = require('express');
const router = express.Router();
const { verificarToken, requerirSesionUsuario } = require('../middleware/auth');
const smtpProviderController = require('../controllers/smtpProviderController');

router.use(verificarToken);
router.use(requerirSesionUsuario);

/**
 * @route   GET /api/smtp-providers
 * @desc    Listar proveedores SMTP del usuario
 */
router.get('/', smtpProviderController.listar);

/**
 * @route   POST /api/smtp-providers
 * @desc    Crear proveedor SMTP
 */
router.post('/', smtpProviderController.crear);

/**
 * @route   GET /api/smtp-providers/:id
 * @desc    Obtener un proveedor SMTP
 */
router.get('/:id', smtpProviderController.obtener);

/**
 * @route   PUT /api/smtp-providers/:id
 * @desc    Actualizar proveedor SMTP
 */
router.put('/:id', smtpProviderController.actualizar);

/**
 * @route   DELETE /api/smtp-providers/:id
 * @desc    Eliminar proveedor SMTP (bloqueado si alguna empresa lo usa)
 */
router.delete('/:id', smtpProviderController.eliminar);

/**
 * @route   POST /api/smtp-providers/:id/probar
 * @desc    Verificar conexión SMTP; con { destinatario } envía email de prueba
 */
router.post('/:id/probar', smtpProviderController.probar);

module.exports = router;
