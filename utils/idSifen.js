/**
 * Identificadores de control (dId) para los servicios de SIFEN.
 *
 * El Manual Técnico define dId como NUMÉRICO de 1 a 15 dígitos. Antes se
 * generaba con crypto.randomBytes(16).toString('hex') — 32 caracteres con
 * letras — y SET rechazaba el envío completo con "0160: XML Mal Formado"
 * (falla la validación XSD del request, no del documento).
 *
 * Formato: epoch en milisegundos (13 dígitos) + 2 dígitos aleatorios
 * = 15 dígitos exactos, sin cero inicial, único en la práctica.
 */

function generarIdSifen() {
  const aleatorio = Math.floor(Math.random() * 90 + 10); // 10..99
  return `${Date.now()}${aleatorio}`;
}

module.exports = { generarIdSifen };
