/**
 * Ejecutor de KUDE (PDF) sin parchear node_modules.
 *
 * Antes: se copiaba `CreateKude.jar` y los `.jasper` dentro de
 * `node_modules/facturacionelectronicapy-kude/dist/` y se reescribía el
 * `index.js` de la librería (script `patch-kude.js`). Eso se perdía en cada
 * `npm install` / rebuild de Docker y era invisible para el control de versiones.
 *
 * Ahora: los artefactos propios viven en `assets/kude/` y se le pasan al JAR
 * por parámetro. La librería se usa tal cual viene de npm, solo como origen de
 * `jasperLibs/` (classpath) y de las plantillas base `DE/`.
 *
 * El comando armado es equivalente al de la librería (`KUDEGen.generateKUDE`),
 * con dos diferencias deliberadas:
 *
 *   1. Se usa `-cp <jar><sep><jasperLibs>/*` + clase `CreateKude` en lugar de
 *      `-jar`, porque el `Class-Path` del manifiesto de nuestro JAR es relativo
 *      a la ubicación del JAR (esperaba estar dentro de `dist/`). Con `-cp` el
 *      classpath es explícito y el JAR puede vivir donde queramos.
 *   2. Se usa `execFile` (sin shell) en lugar de `exec`, así los argumentos
 *      llegan tal cual: desaparece la restricción de "las rutas no pueden tener
 *      espacios" y el JSON de parámetros no sufre el escapado del shell.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const ASSETS_DIR = path.join(RAIZ, 'assets', 'kude');

// JAR propio (versión parcheada: normaliza los nombres de archivo del PDF)
const JAR_PROPIO = process.env.KUDE_JAR_PATH || path.join(ASSETS_DIR, 'CreateKude.jar');

// Plantillas .jasper propias, que pisan a las de la librería
const JASPER_PROPIOS_DIR = process.env.KUDE_JASPER_DIR || path.join(ASSETS_DIR, 'jasper');

// Carpeta de trabajo donde se fusionan las plantillas de la librería + las propias
const RUNTIME_DE_DIR = process.env.KUDE_RUNTIME_DIR || path.join(RAIZ, '.kude', 'DE');

const ENCODING_JVM = process.env.KUDE_JVM_ENCODING || 'IBM850';
const TIMEOUT_MS = parseInt(process.env.KUDE_TIMEOUT_MS || '120000', 10);

/**
 * Ubica el directorio `dist` de la librería instalada.
 */
function resolverDistKude() {
  try {
    const pkgJson = require.resolve('facturacionelectronicapy-kude/package.json');
    return path.join(path.dirname(pkgJson), 'dist');
  } catch (error) {
    // Fallback por si la resolución de módulos no está disponible
    const fallback = path.join(RAIZ, 'node_modules', 'facturacionelectronicapy-kude', 'dist');
    if (fs.existsSync(fallback)) return fallback;
    throw new Error(
      'No se encontró el paquete facturacionelectronicapy-kude. Ejecutá `npm install`.'
    );
  }
}

/**
 * Resuelve el ejecutable de Java.
 * Acepta tanto la ruta al binario como un JAVA_HOME (directorio).
 */
function resolverJava() {
  const candidato = process.env.KUDE_JAVA_PATH || process.env.JAVA8_HOME || process.env.JAVA_HOME;
  if (!candidato) return 'java';

  const binario = process.platform === 'win32' ? 'java.exe' : 'java';

  try {
    if (fs.statSync(candidato).isDirectory()) {
      const desdeHome = path.join(candidato, 'bin', binario);
      return fs.existsSync(desdeHome) ? desdeHome : 'java';
    }
  } catch (error) {
    // La ruta no existe como archivo: puede ser un comando del PATH ("java", "java21", ...)
  }

  return candidato;
}

/**
 * Copia `origen` a `destino` solo si cambió (tamaño o fecha de modificación).
 */
function copiarSiCambio(origen, destino) {
  try {
    const src = fs.statSync(origen);
    const dst = fs.existsSync(destino) ? fs.statSync(destino) : null;
    if (dst && dst.size === src.size && dst.mtimeMs >= src.mtimeMs) return false;
    fs.copyFileSync(origen, destino);
    return true;
  } catch (error) {
    throw new Error(`No se pudo copiar ${origen} -> ${destino}: ${error.message}`);
  }
}

/**
 * Arma el directorio de plantillas que consume el JAR:
 * las plantillas base de la librería, con las propias de `assets/kude/jasper` encima.
 *
 * Es idempotente: se puede llamar en cada arranque o desde `npm run kude:prepare`.
 *
 * @returns {string} ruta con separador final (el JAR concatena `srcJasper + nombre`)
 */
function prepararPlantillas({ verbose = false } = {}) {
  const dirBase = path.join(resolverDistKude(), 'DE');

  fs.mkdirSync(RUNTIME_DE_DIR, { recursive: true });

  const cambios = { libreria: [], propias: [] };

  // El orden importa: primero la base, después las propias, que la pisan.
  for (const origenDir of [dirBase, JASPER_PROPIOS_DIR]) {
    if (!fs.existsSync(origenDir)) continue;
    const clave = origenDir === dirBase ? 'libreria' : 'propias';

    for (const archivo of fs.readdirSync(origenDir)) {
      if (!archivo.toLowerCase().endsWith('.jasper')) continue;
      if (copiarSiCambio(path.join(origenDir, archivo), path.join(RUNTIME_DE_DIR, archivo))) {
        cambios[clave].push(archivo);
      }
    }
  }

  if (verbose) {
    console.log(`📁 Plantillas KUDE en: ${RUNTIME_DE_DIR}`);
    console.log(`   Base (librería): ${dirBase}`);
    console.log(`   Propias:         ${JASPER_PROPIOS_DIR}`);
    if (cambios.libreria.length) console.log(`   Actualizadas de la librería: ${cambios.libreria.join(', ')}`);
    if (cambios.propias.length) console.log(`   Sobreescritas con las propias: ${cambios.propias.join(', ')}`);
    if (!cambios.libreria.length && !cambios.propias.length) console.log('   Sin cambios (ya estaba al día)');
  }

  return RUNTIME_DE_DIR + path.sep;
}

/**
 * Genera el PDF llamando directamente al JAR.
 *
 * @param {object} opciones
 * @param {string} opciones.xmlPath      Ruta del XML firmado
 * @param {string} opciones.destFolder   Carpeta destino del PDF
 * @param {object} opciones.params       Parámetros del reporte (ambiente, LOGO_URL, template, ...)
 * @param {string} [opciones.srcJasper]  Carpeta de plantillas (por defecto, la preparada)
 * @param {string} [opciones.javaPath]   Ejecutable de Java
 * @returns {Promise<string>} stdout del proceso
 */
function generarKudePdf({ xmlPath, destFolder, params, srcJasper, javaPath }) {
  return new Promise((resolve, reject) => {
    let java;
    let classpath;
    let plantillas;
    let destino;

    try {
      const distDir = resolverDistKude();

      if (!fs.existsSync(JAR_PROPIO)) {
        throw new Error(`No se encontró el JAR de KUDE en: ${JAR_PROPIO}`);
      }

      java = javaPath || resolverJava();
      plantillas = srcJasper || prepararPlantillas();
      classpath = [JAR_PROPIO, path.join(distDir, 'jasperLibs') + path.sep + '*'].join(path.delimiter);

      // El JAR escribe el PDF con `exportReportToPdfFile`, que no crea carpetas.
      destino = destFolder.endsWith(path.sep) || destFolder.endsWith('/')
        ? destFolder
        : destFolder + path.sep;
      fs.mkdirSync(destino, { recursive: true });
    } catch (error) {
      return reject(error);
    }

    // El JAR parsea este argumento con Gson: tiene que ser JSON plano,
    // no un JSON serializado dos veces.
    const jsonParam = typeof params === 'string' ? params : JSON.stringify(params || {});

    const args = [
      `-Dfile.encoding=${ENCODING_JVM}`,
      '-cp', classpath,
      'CreateKude',
      xmlPath,
      plantillas,
      destino,
      jsonParam
    ];

    execFile(
      java,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detalle = String(stderr || stdout || '').trim();
          error.message = `KUDE falló (${java}): ${error.message}${detalle ? `\n${detalle}` : ''}`;
          return reject(error);
        }

        // A diferencia de la librería, stderr por sí solo no se considera un
        // fallo: el JAR y JasperReports escriben advertencias ahí.
        const aviso = String(stderr || '').trim();
        if (aviso) console.warn('⚠️ [KUDE] stderr:', aviso);

        resolve(String(stdout || ''));
      }
    );
  });
}

module.exports = {
  generarKudePdf,
  prepararPlantillas,
  resolverDistKude,
  resolverJava,
  JAR_PROPIO,
  JASPER_PROPIOS_DIR,
  RUNTIME_DE_DIR
};
