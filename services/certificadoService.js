const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CERTIFICADOS_BASE_PATH = process.env.CERTIFICADOS_PATH ||
  path.join(__dirname, '../certificados');

const ALGORITMO_ACTUAL = 'aes-256-gcm';
const ALGORITMO_LEGACY = 'aes-256-cbc';
const VERSION = 'v1';

function obtenerMasterKey() {
  const key = process.env.CERTIFICADO_MASTER_KEY;
  if (!key) {
    throw new Error('CERTIFICADO_MASTER_KEY no configurada en variables de entorno');
  }
  return Buffer.from(key.padEnd(32, '0').slice(0, 32), 'utf8');
}

function cifrarContrasena(contrasena) {
  const masterKey = obtenerMasterKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITMO_ACTUAL, masterKey, iv);

  let encrypted = cipher.update(contrasena, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${VERSION}:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function descifrarContrasena(encrypted) {
  const masterKey = obtenerMasterKey();
  const partes = encrypted.split(':');

  if (partes.length === 2) {
    const [ivHex, encryptedHex] = partes;
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITMO_LEGACY, masterKey, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  if (partes.length === 4 && partes[0] === VERSION) {
    const [, ivHex, authTagHex, encryptedHex] = partes;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITMO_ACTUAL, masterKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  throw new Error(`Formato de contraseña cifrada no reconocido: ${partes.length} partes`);
}

function esFormatoGCM(encrypted) {
  return encrypted.startsWith('v1:');
}

function crearCarpetaRuc(ruc) {
  const carpeta = path.join(CERTIFICADOS_BASE_PATH, ruc);
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
  }
  return carpeta;
}

function obtenerRutaCertificado(ruc) {
  return path.join(CERTIFICADOS_BASE_PATH, ruc, 'certificado.p12');
}

function guardarCertificado(ruc, buffer) {
  crearCarpetaRuc(ruc);
  const ruta = obtenerRutaCertificado(ruc);
  fs.writeFileSync(ruta, buffer);
  return ruta;
}

function eliminarCertificado(ruc) {
  const carpeta = path.join(CERTIFICADOS_BASE_PATH, ruc);
  if (fs.existsSync(carpeta)) {
    fs.rmSync(carpeta, { recursive: true, force: true });
  }
}

function existeCertificado(ruc) {
  return fs.existsSync(obtenerRutaCertificado(ruc));
}

function obtenerInfoCertificado(ruc) {
  const ruta = obtenerRutaCertificado(ruc);
  if (!fs.existsSync(ruta)) return null;

  const stats = fs.statSync(ruta);
  return {
    ruta,
    existe: true,
    tamano: stats.size,
    fechaCreacion: stats.birthtime,
    fechaModificacion: stats.mtime
  };
}

function listarCertificados() {
  if (!fs.existsSync(CERTIFICADOS_BASE_PATH)) return [];

  return fs.readdirSync(CERTIFICADOS_BASE_PATH).filter(item => {
    const ruta = path.join(CERTIFICADOS_BASE_PATH, item);
    return fs.statSync(ruta).isDirectory() && existeCertificado(item);
  });
}

/**
 * Resuelve la ruta y contraseña del certificado de una empresa, validando
 * que el archivo exista. Reemplaza a los viejos paths hardcodeados
 * (`certificados/p12/certificado.p12` con contraseña '123456'), que apuntaban
 * a un layout que ya no existe y hacían fallar las consultas a SET.
 *
 * @throws {Error} con statusCode 400 si la empresa no tiene certificado usable
 */
function resolverCertificadoEmpresa(empresa) {
  const sinCert = () => Object.assign(
    new Error(`La empresa ${empresa?.ruc || ''} no tiene un certificado digital cargado y activo`),
    { statusCode: 400, errorCode: 'CERTIFICADO_NO_DISPONIBLE' }
  );

  if (!empresa?.certificado?.contrasena || empresa.certificado.activo === false) {
    throw sinCert();
  }

  const ruta = obtenerRutaCertificado(empresa.ruc);
  if (!fs.existsSync(ruta)) {
    throw sinCert();
  }

  return { ruta, contrasena: descifrarContrasena(empresa.certificado.contrasena) };
}

module.exports = {
  resolverCertificadoEmpresa,
  crearCarpetaRuc,
  obtenerRutaCertificado,
  guardarCertificado,
  eliminarCertificado,
  cifrarContrasena,
  descifrarContrasena,
  esFormatoGCM,
  existeCertificado,
  obtenerInfoCertificado,
  listarCertificados,
  CERTIFICADOS_BASE_PATH
};
