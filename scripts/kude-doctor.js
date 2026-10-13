#!/usr/bin/env node
/**
 * Diagnóstico del entorno de generación de KUDE (PDF).
 *
 * Reemplaza al viejo `node patch-kude.js`: en lugar de modificar node_modules
 * y confiar en que salió bien, acá se verifica de punta a punta y se genera
 * un PDF de prueba real.
 *
 * Uso: npm run kude:doctor
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const {
  generarKudePdf,
  prepararPlantillas,
  resolverDistKude,
  resolverJava,
  JAR_PROPIO,
  JASPER_PROPIOS_DIR,
  RUNTIME_DE_DIR
} = require('../services/kudeRunner');

// DE mínimo válido: alcanza para que el JAR elija plantilla, arme el nombre
// del archivo y exporte el PDF.
const XML_PRUEBA = `<?xml version="1.0" encoding="UTF-8"?>
<rDE><DE Id="01"><gTimb><iTiDE>1</iTiDE><dDesTiDE>Factura electrónica</dDesTiDE><dNumTim>12558946</dNumTim><dEst>001</dEst><dPunExp>001</dPunExp><dNumDoc>0000001</dNumDoc></gTimb><gDtipDE><gCamItem><dDesProSer>Prueba</dDesProSer></gCamItem></gDtipDE></DE></rDE>`;

const ok = (msg) => console.log(`✅ ${msg}`);
const info = (msg) => console.log(`   ${msg}`);
const warn = (msg) => console.log(`⚠️  ${msg}`);
const fail = (msg) => console.log(`❌ ${msg}`);

function versionDeJava(java) {
  return new Promise((resolve) => {
    execFile(java, ['-version'], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve(null);
      resolve(String(stderr || stdout || '').split('\n')[0].trim());
    });
  });
}

async function main() {
  console.log('\n🔎 Diagnóstico de KUDE\n' + '─'.repeat(60));
  let errores = 0;

  // 1. Librería instalada
  let distDir;
  try {
    distDir = resolverDistKude();
    ok('Librería facturacionelectronicapy-kude encontrada');
    info(distDir);
  } catch (error) {
    fail(error.message);
    process.exit(1);
  }

  // 2. jasperLibs (classpath)
  const libsDir = path.join(distDir, 'jasperLibs');
  const libs = fs.existsSync(libsDir)
    ? fs.readdirSync(libsDir).filter((f) => f.endsWith('.jar'))
    : [];
  if (libs.length) {
    ok(`Classpath de JasperReports: ${libs.length} .jar en jasperLibs/`);
  } else {
    fail(`No se encontraron los .jar en ${libsDir}`);
    errores++;
  }

  // 3. JAR propio
  if (fs.existsSync(JAR_PROPIO)) {
    ok('JAR propio (CreateKude.jar) encontrado');
    info(JAR_PROPIO);
  } else {
    fail(`Falta el JAR propio en ${JAR_PROPIO}`);
    errores++;
  }

  // 4. Plantillas .jasper
  try {
    const propias = fs.existsSync(JASPER_PROPIOS_DIR)
      ? fs.readdirSync(JASPER_PROPIOS_DIR).filter((f) => f.endsWith('.jasper'))
      : [];
    prepararPlantillas();
    const finales = fs.readdirSync(RUNTIME_DE_DIR).filter((f) => f.endsWith('.jasper'));
    ok(`Plantillas listas: ${finales.length} (${propias.length} propias)`);
    info(`Propias:  ${propias.join(', ') || '(ninguna)'}`);
    info(`Runtime:  ${RUNTIME_DE_DIR}`);
  } catch (error) {
    fail(`No se pudieron preparar las plantillas: ${error.message}`);
    errores++;
  }

  // 5. Java
  const java = resolverJava();
  const version = await versionDeJava(java);
  if (version) {
    ok(`Java disponible: ${version}`);
    info(java);
  } else {
    fail(`No se pudo ejecutar Java: ${java}`);
    info('Configurá KUDE_JAVA_PATH, JAVA8_HOME o JAVA_HOME, o agregá java al PATH.');
    errores++;
  }

  // 6. Prueba real: generar un PDF
  if (errores === 0) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kude-doctor-'));
    const xmlPath = path.join(tmp, 'prueba.xml');
    fs.writeFileSync(xmlPath, XML_PRUEBA, 'utf8');

    try {
      await generarKudePdf({
        xmlPath,
        destFolder: path.join(tmp, 'salida'),
        params: { ambiente: '1', active: true, template: 'normal' }
      });

      const salida = path.join(tmp, 'salida');
      const pdfs = fs.existsSync(salida)
        ? fs.readdirSync(salida).filter((f) => f.toLowerCase().endsWith('.pdf'))
        : [];

      if (pdfs.length) {
        ok(`PDF de prueba generado: ${pdfs[0]}`);
      } else {
        fail('El JAR corrió sin error pero no generó ningún PDF');
        errores++;
      }
    } catch (error) {
      fail('Falló la generación del PDF de prueba');
      info(error.message.split('\n').slice(0, 6).join('\n   '));
      if (/UnsupportedClassVersionError/.test(error.message)) {
        warn('El CreateKude.jar propio está compilado para una versión de Java más nueva.');
        info('Instalá esa versión de Java o apuntá KUDE_JAVA_PATH al binario correcto.');
      }
      errores++;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    warn('Se omite la prueba de generación por los errores de arriba');
  }

  console.log('─'.repeat(60));
  if (errores === 0) {
    console.log('✅ Todo listo: KUDE puede generar PDFs.\n');
    process.exit(0);
  }
  console.log(`❌ ${errores} problema(s) encontrado(s).\n`);
  process.exit(1);
}

main().catch((error) => {
  fail(error.stack || error.message);
  process.exit(1);
});
