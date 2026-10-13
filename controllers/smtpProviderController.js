/**
 * Controller para gestión de proveedores SMTP
 * CRUD de las configuraciones SMTP que las empresas usan para el envío
 * automático del KUDE por email (empresa.notificaciones.smtpProviderId).
 */

const SmtpProvider = require('../models/SmtpProvider');
const Empresa = require('../models/Empresa');
const certificadoService = require('../services/certificadoService');

/**
 * Valida los datos del proveedor. Devuelve mensaje de error o null.
 */
function validarDatos({ nombre, host, puerto, usuario, remitente }, esCreacion) {
  if (esCreacion) {
    if (!nombre || !host || !usuario) {
      return 'nombre, host y usuario son requeridos';
    }
  }
  if (puerto !== undefined && puerto !== null && puerto !== '') {
    const p = Number(puerto);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return 'puerto inválido: debe ser un número entre 1 y 65535';
    }
  }
  if (remitente && !/^.+@.+\..+$/.test(String(remitente).replace(/^.*<|>$/g, ''))) {
    return 'remitente inválido: debe ser un email (ej. facturas@miempresa.com)';
  }
  return null;
}

/**
 * Listar proveedores SMTP del usuario autenticado
 * GET /api/smtp-providers
 */
exports.listar = async (req, res) => {
  try {
    const providers = await SmtpProvider.find({ usuarioId: req.usuario._id })
      .select('-contrasena')
      .sort({ nombre: 1 });

    res.json({ success: true, data: providers });
  } catch (error) {
    console.error('❌ Error listando proveedores SMTP:', error);
    res.status(500).json({
      success: false,
      error: 'Error al listar proveedores SMTP',
      message: error.message
    });
  }
};

/**
 * Obtener un proveedor SMTP
 * GET /api/smtp-providers/:id
 */
exports.obtener = async (req, res) => {
  try {
    const provider = await SmtpProvider.findOne({
      _id: req.params.id,
      usuarioId: req.usuario._id
    }).select('-contrasena');

    if (!provider) {
      return res.status(404).json({ success: false, error: 'Proveedor SMTP no encontrado' });
    }

    res.json({ success: true, data: provider });
  } catch (error) {
    console.error('❌ Error obteniendo proveedor SMTP:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener proveedor SMTP',
      message: error.message
    });
  }
};

/**
 * Crear proveedor SMTP
 * POST /api/smtp-providers
 */
exports.crear = async (req, res) => {
  try {
    const { nombre, host, puerto, seguro, usuario, contrasena, remitente, activo, validarCertificado } = req.body;

    const error = validarDatos(req.body, true);
    if (error) {
      return res.status(400).json({ success: false, error });
    }
    if (!contrasena) {
      return res.status(400).json({ success: false, error: 'contrasena es requerida' });
    }

    const provider = new SmtpProvider({
      nombre,
      host,
      puerto: puerto ? Number(puerto) : undefined,
      seguro: Boolean(seguro),
      usuario,
      contrasena: certificadoService.cifrarContrasena(contrasena),
      remitente,
      validarCertificado: validarCertificado !== undefined ? Boolean(validarCertificado) : true,
      activo: activo !== undefined ? Boolean(activo) : true,
      usuarioId: req.usuario._id
    });

    await provider.save();

    console.log(`✅ Proveedor SMTP creado: ${nombre} (${host})`);

    const data = provider.toObject();
    delete data.contrasena;

    res.status(201).json({
      success: true,
      message: 'Proveedor SMTP creado exitosamente',
      data
    });
  } catch (error) {
    console.error('❌ Error creando proveedor SMTP:', error);
    res.status(500).json({
      success: false,
      error: 'Error al crear proveedor SMTP',
      message: error.message
    });
  }
};

/**
 * Actualizar proveedor SMTP. La contraseña solo se cambia si viene un
 * valor no vacío (vacío = mantener la actual).
 * PUT /api/smtp-providers/:id
 */
exports.actualizar = async (req, res) => {
  try {
    const { nombre, host, puerto, seguro, usuario, contrasena, remitente, activo, validarCertificado } = req.body;

    const error = validarDatos(req.body, false);
    if (error) {
      return res.status(400).json({ success: false, error });
    }

    const provider = await SmtpProvider.findOne({
      _id: req.params.id,
      usuarioId: req.usuario._id
    });

    if (!provider) {
      return res.status(404).json({ success: false, error: 'Proveedor SMTP no encontrado' });
    }

    if (nombre) provider.nombre = nombre;
    if (host) provider.host = host;
    if (puerto !== undefined && puerto !== null && puerto !== '') provider.puerto = Number(puerto);
    if (seguro !== undefined) provider.seguro = Boolean(seguro);
    if (usuario) provider.usuario = usuario;
    if (contrasena) provider.contrasena = certificadoService.cifrarContrasena(contrasena);
    if (remitente !== undefined) provider.remitente = remitente || undefined;
    if (validarCertificado !== undefined) provider.validarCertificado = Boolean(validarCertificado);
    if (activo !== undefined) provider.activo = Boolean(activo);

    await provider.save();

    const data = provider.toObject();
    delete data.contrasena;

    res.json({
      success: true,
      message: 'Proveedor SMTP actualizado exitosamente',
      data
    });
  } catch (error) {
    console.error('❌ Error actualizando proveedor SMTP:', error);
    res.status(500).json({
      success: false,
      error: 'Error al actualizar proveedor SMTP',
      message: error.message
    });
  }
};

/**
 * Eliminar proveedor SMTP. Se bloquea si alguna empresa lo tiene
 * seleccionado en sus notificaciones.
 * DELETE /api/smtp-providers/:id
 */
exports.eliminar = async (req, res) => {
  try {
    const provider = await SmtpProvider.findOne({
      _id: req.params.id,
      usuarioId: req.usuario._id
    });

    if (!provider) {
      return res.status(404).json({ success: false, error: 'Proveedor SMTP no encontrado' });
    }

    const empresasUsando = await Empresa.countDocuments({
      'notificaciones.smtpProviderId': provider._id
    });

    if (empresasUsando > 0) {
      return res.status(400).json({
        success: false,
        error: `No se puede eliminar: ${empresasUsando} empresa(s) usan este proveedor SMTP`,
        mensaje: 'Cambie el proveedor SMTP de esas empresas antes de eliminarlo',
        dependencias: { empresas: empresasUsando }
      });
    }

    await SmtpProvider.deleteOne({ _id: provider._id });

    console.log(`🗑️ Proveedor SMTP eliminado: ${provider.nombre} (${provider.host})`);

    res.json({ success: true, message: 'Proveedor SMTP eliminado correctamente' });
  } catch (error) {
    console.error('❌ Error eliminando proveedor SMTP:', error);
    res.status(500).json({
      success: false,
      error: 'Error al eliminar proveedor SMTP',
      message: error.message
    });
  }
};

/**
 * Probar la conexión del proveedor (login SMTP con nodemailer.verify).
 * Si el body trae { destinatario }, además envía un email de prueba.
 * POST /api/smtp-providers/:id/probar
 */
exports.probar = async (req, res) => {
  try {
    const provider = await SmtpProvider.findOne({
      _id: req.params.id,
      usuarioId: req.usuario._id
    });

    if (!provider) {
      return res.status(404).json({ success: false, error: 'Proveedor SMTP no encontrado' });
    }

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      ...provider.opcionesTransporte(certificadoService.descifrarContrasena(provider.contrasena)),
      connectionTimeout: 10000
    });

    await transporter.verify();

    const { destinatario } = req.body || {};
    if (destinatario) {
      await transporter.sendMail({
        from: provider.remitente || provider.usuario,
        to: destinatario,
        subject: 'Prueba de proveedor SMTP - DTE-PY',
        text: `Este es un email de prueba del proveedor SMTP "${provider.nombre}" (${provider.host}:${provider.puerto}).\n\nSi lo recibió, la configuración es correcta.`
      });
    }

    res.json({
      success: true,
      message: destinatario
        ? `Conexión OK y email de prueba enviado a ${destinatario}`
        : 'Conexión SMTP verificada correctamente'
    });
  } catch (error) {
    console.error('❌ Error probando proveedor SMTP:', error.message);
    res.status(400).json({
      success: false,
      error: `Fallo la prueba SMTP: ${String(error.message).slice(0, 200)}`
    });
  }
};
