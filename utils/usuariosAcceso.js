/**
 * Reglas puras de la administración de usuarios (sin tocar la base):
 * qué empresas ve cada usuario y cuándo una cuenta se puede eliminar.
 */

const mongoose = require('mongoose');

function resumenEmpresa(e, acceso) {
  return {
    _id: e._id,
    ruc: e.ruc,
    nombre: e.nombreFantasia || e.razonSocial || e.ruc,
    activo: e.activo !== false,
    ...(acceso ? { acceso } : {})
  };
}

/**
 * Empresas a las que llega un usuario por pertenencia: las que creó
 * ('propietario') y las que le compartieron ('compartida'). Un admin ve
 * además todas las otras, pero eso es por rol, no por pertenencia.
 */
function empresasDeUsuario(usuarioId, empresas) {
  const id = String(usuarioId);
  const resultado = [];
  for (const e of empresas) {
    if (String(e.usuarioId) === id) {
      resultado.push(resumenEmpresa(e, 'propietario'));
    } else if ((e.usuariosConAcceso || []).some((u) => String(u) === id)) {
      resultado.push(resumenEmpresa(e, 'compartida'));
    }
  }
  return resultado;
}

/**
 * Normaliza una lista de ids de empresa que llega del cliente.
 * @returns {string[]|null} ids únicos, o null si la lista o algún id es inválido
 */
function normalizarIdsEmpresa(lista) {
  if (!Array.isArray(lista)) return null;
  const ids = [];
  for (const valor of lista) {
    const id = String(valor?._id ?? valor ?? '');
    if (!mongoose.isValidObjectId(id)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * ¿Por qué NO se puede eliminar esta cuenta? null si se puede.
 *
 * Una cuenta dueña de empresas no se elimina: la empresa (y con ella el
 * certificado, el timbrado y los documentos emitidos) quedaría sin dueño.
 * Para sacarle el acceso alcanza con desactivarla.
 */
function motivoNoEliminable({ usuario, solicitanteId, empresasPropias }) {
  if (String(usuario._id) === String(solicitanteId)) {
    return { status: 400, error: 'AUTO_ELIMINACION', message: 'No podés eliminar tu propia cuenta' };
  }
  if (empresasPropias.length) {
    const nombres = empresasPropias.map((e) => e.nombreFantasia || e.razonSocial || e.ruc).join(', ');
    return {
      status: 409,
      error: 'USUARIO_CON_EMPRESAS',
      message: `${usuario.username} es dueño de ${empresasPropias.length} empresa(s) (${nombres}) y no se puede eliminar. ` +
        'Desactivá la cuenta para quitarle el acceso.'
    };
  }
  return null;
}

module.exports = { resumenEmpresa, empresasDeUsuario, normalizarIdsEmpresa, motivoNoEliminable };
