require('dotenv').config();
const { ocultarCredenciales } = require('../utils/ocultarCredenciales');
const mongoose = require('mongoose');
const envioLoteService = require('../services/envioLoteService');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sifen_db';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000
})
.then(() => console.log('✅ [LOTE-WORKER] MongoDB conectado'))
.catch(err => console.error('❌ [LOTE-WORKER] Error conectando a MongoDB:', err.message));

const INTERVALO_MS = 30000;
// Un lote con menos de 50 documentos se envía igual cuando su factura más
// antigua esperó este tiempo (sin esto quedaba en_espera para siempre).
const ESPERA_MAX_MS = parseInt(process.env.LOTE_ESPERA_MAX_MS || '45000', 10);

async function procesarLotes() {
  // 1. enviar lotes en espera que ya cumplieron la espera máxima
  try {
    const enviados = await envioLoteService.enviarLotesConEspera(ESPERA_MAX_MS);
    for (const res of enviados) {
      if (res.success) {
        console.log(`📤 [LOTE-WORKER] Lote ${res.loteId} enviado a SET (${res.count} docs, espera cumplida)`);
      } else {
        console.warn(`⚠️ [LOTE-WORKER] No se pudo enviar lote ${res.loteId}: ${res.error}`);
      }
    }
  } catch (err) {
    console.error('❌ [LOTE-WORKER] Error enviando lotes en espera:', err.message);
  }

  // 2. consultar resultado de los lotes ya enviados
  try {
    const resultados = await envioLoteService.consultarPendientes();
    if (resultados.length > 0) {
      for (const res of resultados) {
        if (res.completado) {
          console.log(`✅ [LOTE-WORKER] Lote ${res.loteId} completado`);
        } else if (res.error) {
          console.warn(`⚠️ [LOTE-WORKER] Error lote ${res.loteId}: ${res.error}`);
        }
      }
    }
  } catch (err) {
    console.error('❌ [LOTE-WORKER] Error consultando lotes:', err.message);
  }
}

setInterval(procesarLotes, INTERVALO_MS);

console.log(`👷 [LOTE-WORKER] Iniciado - envía lotes con espera > ${ESPERA_MAX_MS / 1000}s y consulta cada ${INTERVALO_MS / 1000}s`);
console.log(`📍 MongoDB: ${ocultarCredenciales(MONGODB_URI)}`);

process.on('SIGINT', async () => {
  console.log('\n🛑 [LOTE-WORKER] Cerrando...');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 [LOTE-WORKER] SIGTERM recibido...');
  await mongoose.connection.close();
  process.exit(0);
});
