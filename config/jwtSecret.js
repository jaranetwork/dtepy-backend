/**
 * Secreto JWT: obligatorio y sin valor por defecto.
 *
 * Antes había un fallback hardcodeado ('sifen-secret-key-change-in-production')
 * publicado en el repositorio: cualquier deploy que no definiera JWT_SECRET
 * aceptaba tokens que cualquiera podía forjar. Ahora el servidor no arranca
 * sin un secreto real, y rechaza los valores de ejemplo conocidos.
 */

const SECRETOS_PUBLICOS = [
  'sifen-secret-key-change-in-production',      // viejo fallback hardcodeado
  'tu_secreto_super_secreto_cambiar_en_produccion' // placeholder del .env.example
];

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || SECRETOS_PUBLICOS.includes(JWT_SECRET)) {
  console.error('❌ JWT_SECRET no está configurado (o usa un valor de ejemplo público).');
  console.error('   Cualquiera podría forjar tokens de sesión con un secreto conocido.');
  console.error('');
  console.error('   Generá un secreto propio:');
  console.error('     node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  console.error('');
  console.error('   y agregalo al archivo .env:');
  console.error('     JWT_SECRET=<valor generado>');
  process.exit(1);
}

module.exports = JWT_SECRET;
