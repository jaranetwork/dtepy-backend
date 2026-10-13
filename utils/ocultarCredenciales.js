/**
 * URI de conexión apta para logs: la contraseña se reemplaza por ***
 * (mongodb://usuario:***@host:27017/db). Los logs del contenedor los ve
 * cualquiera con acceso al panel de despliegue, y los workers imprimían la
 * URI de MongoDB completa al arrancar. Una URI sin credenciales queda igual.
 *
 * @param {string} uri
 * @returns {string}
 */
function ocultarCredenciales(uri) {
  return String(uri ?? '').replace(/(\/\/[^:/@\s]+):[^@\s]*@/, '$1:***@');
}

module.exports = { ocultarCredenciales };
