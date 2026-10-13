/**
 * Administración de usuarios del panel.
 *
 * Solo una sesión de usuario ADMIN puede listar, crear, modificar o eliminar
 * cuentas; una API Key nunca alcanza (una key filtrada no debe poder crear
 * accesos).
 *
 * Además de los datos de la cuenta, acá se administra el ACCESO A EMPRESAS:
 * un usuario no-admin ve las empresas que creó y las que se le comparten
 * (`Empresa.usuariosConAcceso`). Compartir da acceso a la empresa y a sus
 * documentos, no a su configuración ni a su certificado.
 *
 * Desactivar (PUT activo:false) corta el acceso y conserva la cuenta;
 * eliminar (DELETE) la borra junto con sus API Keys y proveedores SMTP. Una
 * cuenta dueña de empresas no se elimina.
 */

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Empresa = require('../models/Empresa');
const ApiKey = require('../models/ApiKey');
const SmtpProvider = require('../models/SmtpProvider');
const { verificarToken, requerirSesionAdmin } = require('../middleware/auth');
const { resumenEmpresa, empresasDeUsuario, normalizarIdsEmpresa, motivoNoEliminable } = require('../utils/usuariosAcceso');

router.use(verificarToken, requerirSesionAdmin);

const ROLES = ['admin', 'usuario', 'contador'];
const CAMPOS_EMPRESA = 'ruc nombreFantasia razonSocial usuarioId usuariosConAcceso activo';

function publico(u) {
  return {
    _id: u._id,
    username: u.username,
    email: u.email,
    nombre: u.nombre,
    apellido: u.apellido,
    rol: u.rol,
    activo: u.activo,
    ultimoAcceso: u.ultimoAcceso,
    fechaCreacion: u.fechaCreacion || u.createdAt
  };
}

const todasLasEmpresas = () => Empresa.find({}).select(CAMPOS_EMPRESA).sort({ nombreFantasia: 1 });

async function conEmpresas(usuario) {
  return { ...publico(usuario), empresas: empresasDeUsuario(usuario._id, await todasLasEmpresas()) };
}

/**
 * Valida la lista de empresas a compartir. Devuelve { ids } o { error }.
 */
async function validarEmpresasCompartidas(lista) {
  const ids = normalizarIdsEmpresa(lista);
  if (!ids) return { error: 'empresasCompartidas debe ser una lista de ids de empresa válidos' };
  if (ids.length) {
    const existentes = await Empresa.countDocuments({ _id: { $in: ids } });
    if (existentes !== ids.length) return { error: 'Alguna de las empresas indicadas no existe' };
  }
  return { ids };
}

/**
 * Deja al usuario con acceso compartido exactamente a `ids`. Las empresas de
 * las que es dueño no entran en la lista: ya las ve por ser suyas.
 * Sin tocar updatedAt: compartir no es un cambio de configuración.
 */
async function aplicarEmpresasCompartidas(usuarioId, ids) {
  await Empresa.updateMany(
    { _id: { $nin: ids }, usuariosConAcceso: usuarioId },
    { $pull: { usuariosConAcceso: usuarioId } },
    { timestamps: false }
  );
  if (ids.length) {
    await Empresa.updateMany(
      { _id: { $in: ids }, usuarioId: { $ne: usuarioId } },
      { $addToSet: { usuariosConAcceso: usuarioId } },
      { timestamps: false }
    );
  }
}

router.get('/', async (req, res) => {
  try {
    const [usuarios, empresas, keys] = await Promise.all([
      User.find({}).sort({ createdAt: 1 }),
      todasLasEmpresas(),
      ApiKey.aggregate([{ $match: { activa: true } }, { $group: { _id: '$usuario', total: { $sum: 1 } } }])
    ]);
    const keysPorUsuario = new Map(keys.map((k) => [String(k._id), k.total]));

    res.json({
      success: true,
      data: usuarios.map((u) => ({
        ...publico(u),
        empresas: empresasDeUsuario(u._id, empresas),
        apiKeysActivas: keysPorUsuario.get(String(u._id)) || 0
      })),
      // Catálogo para el selector "Empresas con acceso" del panel.
      empresas: empresas.map((e) => ({ ...resumenEmpresa(e), propietarioId: e.usuarioId })),
      total: usuarios.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'USUARIOS_LIST_ERROR', message: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { username, email, password, nombre, apellido, rol, empresasCompartidas } = req.body || {};
    if (!username || !email || !password || !nombre || !apellido) {
      return res.status(400).json({ success: false, error: 'CAMPOS_REQUERIDOS', message: 'Usuario, email, contraseña, nombre y apellido son obligatorios' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, error: 'PASSWORD_CORTA', message: 'La contraseña debe tener al menos 6 caracteres' });
    }
    if (rol && !ROLES.includes(rol)) {
      return res.status(400).json({ success: false, error: 'ROL_INVALIDO', message: `Rol inválido. Válidos: ${ROLES.join(', ')}` });
    }
    let compartidas = { ids: [] };
    if (empresasCompartidas !== undefined) {
      compartidas = await validarEmpresasCompartidas(empresasCompartidas);
      if (compartidas.error) return res.status(400).json({ success: false, error: 'EMPRESAS_INVALIDAS', message: compartidas.error });
    }
    const existente = await User.findOne({ $or: [{ email: String(email).toLowerCase() }, { username }] });
    if (existente) {
      return res.status(409).json({ success: false, error: 'USUARIO_EXISTENTE', message: 'Ya existe un usuario con ese email o nombre de usuario' });
    }
    const usuario = new User({ username, email, password, nombre, apellido, rol: rol || 'usuario' });
    await usuario.save();
    if (compartidas.ids.length) await aplicarEmpresasCompartidas(usuario._id, compartidas.ids);
    res.status(201).json({ success: true, message: 'Usuario creado', data: await conEmpresas(usuario) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'USUARIO_CREAR_ERROR', message: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const usuario = await User.findById(req.params.id);
    if (!usuario) return res.status(404).json({ success: false, error: 'USUARIO_NOT_FOUND', message: 'Usuario no encontrado' });

    const { nombre, apellido, email, username, rol, activo, empresasCompartidas } = req.body || {};
    const esUnoMismo = String(usuario._id) === String(req.usuario._id);

    if (rol !== undefined) {
      if (!ROLES.includes(rol)) {
        return res.status(400).json({ success: false, error: 'ROL_INVALIDO', message: `Rol inválido. Válidos: ${ROLES.join(', ')}` });
      }
      if (esUnoMismo && rol !== 'admin') {
        return res.status(400).json({ success: false, error: 'AUTO_DEGRADACION', message: 'No podés quitarte el rol de administrador a vos mismo' });
      }
      usuario.rol = rol;
    }
    if (activo !== undefined) {
      if (esUnoMismo && activo === false) {
        return res.status(400).json({ success: false, error: 'AUTO_DESACTIVACION', message: 'No podés desactivar tu propia cuenta' });
      }
      usuario.activo = Boolean(activo);
    }
    if (nombre !== undefined) usuario.nombre = nombre;
    if (apellido !== undefined) usuario.apellido = apellido;
    if (email !== undefined && email !== usuario.email) {
      const otro = await User.findOne({ email: String(email).toLowerCase(), _id: { $ne: usuario._id } });
      if (otro) return res.status(409).json({ success: false, error: 'EMAIL_EN_USO', message: 'Ese email ya lo usa otro usuario' });
      usuario.email = email;
    }
    if (username !== undefined && username !== usuario.username) {
      const nuevo = String(username).trim();
      if (nuevo.length < 3 || nuevo.length > 50) {
        return res.status(400).json({ success: false, error: 'USERNAME_INVALIDO', message: 'El nombre de usuario debe tener entre 3 y 50 caracteres' });
      }
      const otro = await User.findOne({ username: nuevo, _id: { $ne: usuario._id } });
      if (otro) return res.status(409).json({ success: false, error: 'USERNAME_EN_USO', message: 'Ese nombre de usuario ya existe' });
      usuario.username = nuevo;
    }

    let compartidas = null;
    if (empresasCompartidas !== undefined) {
      compartidas = await validarEmpresasCompartidas(empresasCompartidas);
      if (compartidas.error) return res.status(400).json({ success: false, error: 'EMPRESAS_INVALIDAS', message: compartidas.error });
    }

    await usuario.save();
    if (compartidas) await aplicarEmpresasCompartidas(usuario._id, compartidas.ids);
    res.json({ success: true, message: 'Usuario actualizado', data: await conEmpresas(usuario) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'USUARIO_ACTUALIZAR_ERROR', message: error.message });
  }
});

router.post('/:id/password', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ success: false, error: 'PASSWORD_CORTA', message: 'La contraseña debe tener al menos 6 caracteres' });
    }
    const usuario = await User.findById(req.params.id);
    if (!usuario) return res.status(404).json({ success: false, error: 'USUARIO_NOT_FOUND', message: 'Usuario no encontrado' });
    usuario.password = password; // el pre-save la hashea
    await usuario.save();
    res.json({ success: true, message: `Contraseña de ${usuario.username} restablecida` });
  } catch (error) {
    res.status(500).json({ success: false, error: 'USUARIO_PASSWORD_ERROR', message: error.message });
  }
});

/**
 * Eliminar la cuenta de forma permanente, con sus API Keys y proveedores
 * SMTP. Los documentos y eventos que generó quedan (guardan el nombre de
 * quien los hizo, no una referencia a la cuenta).
 */
router.delete('/:id', async (req, res) => {
  try {
    const usuario = await User.findById(req.params.id);
    if (!usuario) return res.status(404).json({ success: false, error: 'USUARIO_NOT_FOUND', message: 'Usuario no encontrado' });

    const empresasPropias = await Empresa.find({ usuarioId: usuario._id }).select('ruc nombreFantasia razonSocial');
    const motivo = motivoNoEliminable({ usuario, solicitanteId: req.usuario._id, empresasPropias });
    if (motivo) return res.status(motivo.status).json({ success: false, error: motivo.error, message: motivo.message });

    const [keys, smtp] = await Promise.all([
      ApiKey.deleteMany({ usuario: usuario._id }),
      SmtpProvider.deleteMany({ usuarioId: usuario._id }),
      Empresa.updateMany({ usuariosConAcceso: usuario._id }, { $pull: { usuariosConAcceso: usuario._id } }, { timestamps: false })
    ]);
    await User.deleteOne({ _id: usuario._id });

    console.log(`🗑️ Usuario eliminado: ${usuario.username} (${usuario.email}) por ${req.usuario.username}`);
    res.json({
      success: true,
      message: `Usuario ${usuario.username} eliminado`,
      data: { _id: usuario._id, apiKeysEliminadas: keys.deletedCount || 0, proveedoresSmtpEliminados: smtp.deletedCount || 0 }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'USUARIO_ELIMINAR_ERROR', message: error.message });
  }
});

module.exports = router;
