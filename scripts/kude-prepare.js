#!/usr/bin/env node
/**
 * Deja listo el directorio de plantillas .jasper que consume el JAR de KUDE:
 * las plantillas base de la librería con las propias de `assets/kude/jasper` encima.
 *
 * Es idempotente y opcional: el servicio lo hace solo la primera vez que
 * genera un PDF. Sirve para adelantarlo en el build de Docker o en el deploy.
 *
 * Uso: npm run kude:prepare
 */

const { prepararPlantillas } = require('../services/kudeRunner');

try {
  prepararPlantillas({ verbose: true });
  console.log('✅ Plantillas de KUDE preparadas');
} catch (error) {
  console.error('❌ No se pudieron preparar las plantillas:', error.message);
  process.exit(1);
}
