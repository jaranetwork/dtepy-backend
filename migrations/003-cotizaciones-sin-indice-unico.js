/**
 * Migración: eliminar el índice único de cotizaciones por fecha de la fuente
 *
 * El índice `empresaId_1_moneda_1_fuente.fechaCotizacion_1` (único, parcial)
 * garantizaba una sola cotización automática por empresa+moneda+fecha de la
 * fuente. Servía para que dos corridas simultáneas no duplicaran la
 * declaración, pero también impedía volver a declarar la MISMA fecha con otras
 * reglas: al cambiar "venta" por "compra" (o al revés), la sincronización
 * chocaba contra el índice y no aplicaba nada — ni siquiera con "Sincronizar
 * ahora". Había que esperar a que la fuente publicara un día nuevo.
 *
 * Una redeclaración es una declaración nueva y tiene que quedar en el historial
 * con su valor, quién y cuándo. La exclusión entre corridas ahora la da el lock
 * por empresa de `cotizacionSyncService` (`cotizacionesAutomaticas.sincronizandoDesde`).
 *
 * Es idempotente: se puede ejecutar más de una vez sin efecto.
 * No toca ninguna cotización: solo elimina el índice.
 *
 * Uso:
 *   node migrations/003-cotizaciones-sin-indice-unico.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/sifen_db';

async function migrar() {
  console.log('🔄 ========================================');
  console.log('🔄 Migración 003: cotizaciones sin índice único por fecha');
  console.log('🔄 ========================================\n');

  try {
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ Conectado a MongoDB\n');

    const coleccion = mongoose.connection.collection('cotizacions');
    const indices = await coleccion.indexes();

    // Se busca por forma de la clave, no por nombre: así también agarra un
    // índice creado con otro nombre.
    const sobrantes = indices.filter(
      (indice) => indice.unique && Object.keys(indice.key).includes('fuente.fechaCotizacion')
    );

    if (sobrantes.length === 0) {
      console.log('✓ No hay índice único por fuente.fechaCotizacion (ya estaba eliminado)');
    }

    for (const indice of sobrantes) {
      await coleccion.dropIndex(indice.name);
      console.log(`✅ Índice ${indice.name} eliminado`);
    }

    console.log('\n📋 Índices que quedan en cotizacions:');
    for (const indice of await coleccion.indexes()) {
      console.log(`   • ${indice.name}${indice.unique ? ' (único)' : ''}`);
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
