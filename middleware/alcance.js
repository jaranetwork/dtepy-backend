/**
 * Alcance multi-empresa: qué empresas puede ver el token autenticado.
 *
 * Una empresa tiene un dueño (`usuarioId`) y, además, una lista de usuarios
 * con acceso (`usuariosConAcceso`) que el administrador gestiona desde
 * Usuarios. Quien tiene acceso compartido ve la empresa y opera sus
 * documentos (consultar, emitir, cancelar), pero no cambia su configuración
 * ni su certificado: eso queda para el dueño y los administradores.
 *
 * Reglas:
 *   - Sesión JWT de un admin        → sin restricción (ve todo el sistema).
 *   - Sesión JWT de otro rol        → sus empresas + las compartidas con él.
 *   - API Key atada a una empresa   → solo esa empresa.
 *   - API Key sin empresa asociada  → las empresas de su dueño + las
 *                                     compartidas con él (nunca "todo": una
 *                                     key filtrada de un admin no abre el
 *                                     sistema entero).
 *
 * Uso: aplicar `cargarAlcance` después de verificarToken, y en los handlers
 * usar `filtroEmpresa(req)` para listados/agregaciones y
 * `perteneceAlAlcance(req, empresaId)` para documentos puntuales. Para la
 * colección de empresas en sí: `filtroEmpresasVisibles(req)` (leer) y
 * `filtroEmpresasAdministrables(req)` (configurar, certificado, eliminar).
 */

const Empresa = require('../models/Empresa');

const esSesionAdmin = (req) => req.tipoAutenticacion === 'jwt' && req.usuario?.rol === 'admin';

/** Empresas de un usuario: las que creó y las que le compartieron. */
function condicionAccesoDe(usuarioId) {
  return { $or: [{ usuarioId }, { usuariosConAcceso: usuarioId }] };
}

/** Filtro sobre la colección `empresas`: las que este token puede VER. */
function filtroEmpresasVisibles(req) {
  if (esSesionAdmin(req)) return {};
  if (req.apiKey?.empresaId) return { _id: req.apiKey.empresaId };
  return condicionAccesoDe(req.usuario._id);
}

/** Filtro sobre la colección `empresas`: las que este token puede CONFIGURAR. */
function filtroEmpresasAdministrables(req) {
  if (esSesionAdmin(req)) return {};
  return { usuarioId: req.usuario._id };
}

/**
 * Relación del token con una empresa que ya pasó el filtro de visibles:
 * 'propietario' | 'administrador' | 'compartida'.
 */
function tipoAccesoEmpresa(req, empresa) {
  if (String(empresa.usuarioId?._id ?? empresa.usuarioId) === String(req.usuario._id)) return 'propietario';
  if (esSesionAdmin(req)) return 'administrador';
  return 'compartida';
}

async function cargarAlcance(req, res, next) {
  try {
    if (esSesionAdmin(req)) {
      req.alcance = { total: true, ids: null };
      return next();
    }

    if (req.apiKey?.empresaId) {
      req.alcance = { total: false, ids: [req.apiKey.empresaId] };
      return next();
    }

    const empresas = await Empresa.find(condicionAccesoDe(req.usuario._id)).select('_id');
    req.alcance = { total: false, ids: empresas.map((e) => e._id) };
    next();
  } catch (error) {
    console.error('Error cargando alcance de empresas:', error);
    res.status(500).json({ success: false, error: 'ALCANCE_ERROR', message: 'Error resolviendo permisos' });
  }
}

/**
 * Filtro de Mongo para listados y agregaciones.
 * @param {object} req
 * @param {string} [campo='empresaId'] nombre del campo en la colección
 * @returns {object} `{}` si el alcance es total, `{ campo: { $in: [...] } }` si no
 */
function filtroEmpresa(req, campo = 'empresaId') {
  if (!req.alcance || req.alcance.total) return {};
  return { [campo]: { $in: req.alcance.ids } };
}

/**
 * ¿Este documento (por su empresaId) está dentro del alcance?
 * Acepta un ObjectId, un string o un documento populado.
 */
function perteneceAlAlcance(req, empresaId) {
  if (!req.alcance || req.alcance.total) return true;
  if (!empresaId) return false; // sin empresa asignada: solo visible para admin
  const idStr = String(empresaId._id ?? empresaId);
  return req.alcance.ids.some((id) => String(id) === idStr);
}

/**
 * Empresa del alcance con certificado activo, para las consultas a SET que
 * no parten de una factura (consulta de RUC, CDC ajeno). Devuelve null si
 * no hay ninguna.
 */
async function empresaParaConsultas(req) {
  const filtro = {
    activo: true,
    'certificado.activo': true,
    ...(req.alcance && !req.alcance.total ? { _id: { $in: req.alcance.ids } } : {})
  };
  return Empresa.findOne(filtro).sort({ updatedAt: -1 });
}

module.exports = {
  cargarAlcance,
  filtroEmpresa,
  perteneceAlAlcance,
  empresaParaConsultas,
  condicionAccesoDe,
  filtroEmpresasVisibles,
  filtroEmpresasAdministrables,
  tipoAccesoEmpresa
};
