/**
 * Migración: eliminar las API Keys en texto plano de la base de datos
 *
 * Hasta ahora el campo `key` guardaba la clave en claro junto al `keyHash`,
 * con lo cual un dump o acceso a la base exponía todas las API Keys. La
 * autenticación siempre se hizo por `keyHash`, así que el texto plano
 * no hace falta para nada.
 *
 * Esta migración, para cada API Key existente:
 *   1. Calcula `keyHash` si faltara (a partir del texto plano).
 *   2. Guarda `keyParcial` (prefijo...sufijo) para identificarla en listados.
 *   3. Elimina el campo `key` (texto plano).
 *   4. Elimina el índice único `key_1`, que ya no aplica.
 *
 * Es idempotente: se puede ejecutar más de una vez sin efecto.
 * Las keys existentes SIGUEN FUNCIONANDO: la verificación usa keyHash.
 *
 * Nota: los documentos viejos también se migran solos la primera vez que se
 * usan (el hook pre-save del modelo descarta el texto plano); este script
 * limpia todo de una vez sin esperar a que cada key se use.
 *
 * Uso:
 *   node migrations/002-apikeys-sin-clave-plana.js
 */

require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/sifen_db';

async function migrar() {
  console.log('🔄 ========================================');
  console.log('🔄 Migración 002: API Keys sin clave plana');
  console.log('🔄 ========================================\n');

  try {
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ Conectado a MongoDB\n');

    const coleccion = mongoose.connection.collection('apikeys');

    // 1-3. Limpiar el texto plano de cada documento
    const cursor = coleccion.find({ key: { $exists: true, $ne: null } });
    let migradas = 0;

    for await (const doc of cursor) {
      const actualizacion = { $unset: { key: '' }, $set: {} };

      if (!doc.keyHash) {
        actualizacion.$set.keyHash = crypto.createHash('sha256').update(doc.key).digest('hex');
      }
      if (!doc.keyParcial && typeof doc.key === 'string' && doc.key.length >= 16) {
        actualizacion.$set.keyParcial =
          `${doc.key.substring(0, 8)}...${doc.key.substring(doc.key.length - 8)}`;
      }
      if (Object.keys(actualizacion.$set).length === 0) {
        delete actualizacion.$set;
      }

      await coleccion.updateOne({ _id: doc._id }, actualizacion);
      migradas++;
      console.log(`   🔑 ${doc.nombre || doc._id}: texto plano eliminado`);
    }

    console.log(`\n✅ API Keys migradas: ${migradas}`);
    if (migradas === 0) {
      console.log('   (ninguna tenía la clave en texto plano: nada que hacer)');
    }

    // 4. Eliminar el índice único del campo que ya no existe
    try {
      await coleccion.dropIndex('key_1');
      console.log('✅ Índice key_1 eliminado');
    } catch (error) {
      if (error.codeName === 'IndexNotFound' || /index not found/i.test(error.message)) {
        console.log('✓ Índice key_1 no existe (ya estaba eliminado)');
      } else {
        throw error;
      }
    }

    console.log('\n🎉 Migración completada');
  } catch (error) {
    console.error('\n❌ Error en la migración:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

migrar();
