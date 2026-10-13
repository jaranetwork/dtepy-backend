/**
 * Colas de trabajo para Facturación Electrónica
 * Usa Bull (Redis) para procesamiento asíncrono
 */

const Queue = require('bull');
const path = require('path');

// ========================================
// CONFIGURACIÓN DE REDIS
// ========================================
// Acepta una URL completa (lo que entregan Dokploy, Railway, Upstash...)
// o variables sueltas. La contraseña es opcional en ambos casos.
//
//   REDIS_URL=redis://default:contrasena@host:6379
//   REDIS_URL=rediss://default:contrasena@host:6379/2   (TLS + base 2)
//   REDIS_HOST=host  REDIS_PORT=6379  [REDIS_PASSWORD=...]

const OPCIONES_BASE = {
  maxRetriesPerRequest: null,  // Importante para Bull
  retryStrategy: (intentos) => (intentos > 3 ? null : Math.min(intentos * 200, 2000))
};

// Las claves sin valor se descartan para que ioredis aplique sus defaults.
const sinVacios = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, valor]) => valor !== undefined && valor !== ''));

function desdeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`REDIS_URL no es una URL válida: ${url}`);
  }

  const usuario = decodeURIComponent(parsed.username);

  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    password: decodeURIComponent(parsed.password) || undefined,
    // 'default' es el usuario implícito: omitirlo hace que ioredis mande
    // `AUTH <password>` a secas, compatible también con Redis < 6.
    username: usuario && usuario !== 'default' ? usuario : undefined,
    db: Number(parsed.pathname.slice(1)) || undefined,
    tls: parsed.protocol === 'rediss:' ? {} : undefined
  };
}

function desdeVariables() {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    username: process.env.REDIS_USERNAME,
    db: Number(process.env.REDIS_DB) || undefined
  };
}

const url = process.env.REDIS_URL || process.env.REDIS_URI;
const redisConfig = { ...OPCIONES_BASE, ...sinVacios(url ? desdeUrl(url) : desdeVariables()) };

/** Descripción para logs, sin credenciales. */
function describirRedis() {
  const { host, port, db, password, tls } = redisConfig;
  const esquema = tls ? 'rediss' : 'redis';
  return `${esquema}://${host}:${port}${db ? `/${db}` : ''}${password ? ' (con auth)' : ''}`;
}

// Cola principal de facturación
const facturaQueue = new Queue('facturacion', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 1,  // Sin reintentos automáticos (errores de validación no se resuelven reintentando)
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    removeOnComplete: {
      count: 100  // Mantener últimos 100 jobs completados
    },
    removeOnFail: {
      count: 10000  // Mantener últimos 10000 jobs fallidos para debugging
    },
    timeout: 300000  // 5 minutos timeout por job
  }
});

// Cola de generación de KUDE (PDF)
const kudeQueue = new Queue('kude', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 1,  // Sin reintentos automáticos
    backoff: {
      type: 'fixed',
      delay: 2000
    },
    removeOnComplete: 50,
    removeOnFail: 1000,
    timeout: 120000  // 2 minutos
  }
});

// ========================================
// EVENTOS DE MONITOREO
// ========================================

// Progreso del job
facturaQueue.on('progress', (job, progress) => {
  console.log(`📊 [FACTURA] Job ${job.id}: ${progress}% completado`);
});

// Job completado exitosamente
facturaQueue.on('completed', (job, result) => {
  console.log(`✅ [FACTURA] Job ${job.id} completado - CDC: ${result?.cdc || 'N/A'}`);
});

// Job fallido
facturaQueue.on('failed', (job, err) => {
  console.error(`❌ [FACTURA] Job ${job.id} falló: ${err.message}`);
  console.error(`   Datos: RUC=${job.data?.datosFactura?.ruc}, Numero=${job.data?.datosFactura?.numero}`);
  console.error(`   Reintentar desde el frontend corrigiendo los datos`);
});

// Job en espera
facturaQueue.on('waiting', (jobId) => {
  console.log(`⏳ [FACTURA] Job ${jobId} en espera`);
});

// Job activo (procesando)
facturaQueue.on('active', (job) => {
  console.log(`🔄 [FACTURA] Job ${job.id} procesando (intento ${job.attemptsMade + 1})`);
});

// Job estancado (stalled)
facturaQueue.on('stalled', (jobId) => {
  console.warn(`⚠️ [FACTURA] Job ${jobId} estancado - no se reintentará automáticamente`);
});

// Error en la cola
facturaQueue.on('error', (err) => {
  console.error(`💥 [FACTURA] Error en la cola: ${err.message}`);
});

// Eventos de KUDE
kudeQueue.on('completed', (job, result) => {
  console.log(`✅ [KUDE] Job ${job.id} completado`);
});

kudeQueue.on('failed', (job, err) => {
  console.error(`❌ [KUDE] Job ${job.id} falló: ${err.message}`);
});

// ========================================
// FUNCIONES UTILITARIAS
// ========================================

/**
 * Obtener estadísticas de la cola
 */
async function getQueueStats() {
  const [facturacionWaiting, facturacionActive, facturacionCompleted, facturacionFailed] = await Promise.all([
    facturaQueue.getWaitingCount(),
    facturaQueue.getActiveCount(),
    facturaQueue.getCompletedCount(),
    facturaQueue.getFailedCount()
  ]);

  const [kudeWaiting, kudeActive, kudeCompleted, kudeFailed] = await Promise.all([
    kudeQueue.getWaitingCount(),
    kudeQueue.getActiveCount(),
    kudeQueue.getCompletedCount(),
    kudeQueue.getFailedCount()
  ]);

  return {
    facturacion: {
      waiting: facturacionWaiting,
      active: facturacionActive,
      completed: facturacionCompleted,
      failed: facturacionFailed
    },
    kude: {
      waiting: kudeWaiting,
      active: kudeActive,
      completed: kudeCompleted,
      failed: kudeFailed
    }
  };
}

/**
 * Limpiar cola de completados
 */
async function cleanCompletedJobs(queue, count = 100) {
  const jobs = await queue.getCompleted();
  if (jobs.length > count) {
    const toRemove = jobs.slice(0, jobs.length - count);
    await Promise.all(toRemove.map(job => job.remove()));
    return toRemove.length;
  }
  return 0;
}

/**
 * Limpiar cola de fallidos
 */
async function cleanFailedJobs(queue) {
  const jobs = await queue.getFailed();
  const removed = await Promise.all(jobs.map(job => job.remove()));
  return removed.length;
}

/**
 * Limpiar toda la cola (todos los estados)
 */
async function cleanAllJobs(queue) {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaiting(),
    queue.getActive(),
    queue.getCompleted(),
    queue.getFailed(),
    queue.getDelayed()
  ]);

  const allJobs = [...waiting, ...active, ...completed, ...failed, ...delayed];
  const removed = await Promise.all(allJobs.map(job => job.remove()));
  return removed.length;
}

/**
 * Obtener jobs recientes de las colas
 */
async function getRecentJobs(limit = 20) {
  const [completed, failed, active, waiting, kudeCompleted, kudeFailed, kudeActive, kudeWaiting] = await Promise.all([
    facturaQueue.getCompleted(0, limit - 1),
    facturaQueue.getFailed(0, limit - 1),
    facturaQueue.getActive(0, limit - 1),
    facturaQueue.getWaiting(0, limit - 1),
    kudeQueue.getCompleted(0, limit - 1),
    kudeQueue.getFailed(0, limit - 1),
    kudeQueue.getActive(0, limit - 1),
    kudeQueue.getWaiting(0, limit - 1)
  ]);

  // Formatear jobs con información relevante
  const formatJob = (job, queueName = 'facturacion') => {
    const datosFactura = job.data?.datosFactura;
    const data = datosFactura?.data || datosFactura || {};
    const param = datosFactura?.param || {};

    const ruc = data?.cliente?.ruc || data.ruc || param.ruc || job.data?.ruc || job.data?.empresaId || 'N/A';
    const numero = data.numero || job.data?.numero || job.data?.correlativo || 'N/A';
    const timestamp = job.finishedOn || job.processedOn || job.timestamp;

    return {
      id: job.id,
      queue: queueName,
      estado: job.failedReason ? 'failed' : job.finishedOn ? 'completed' : job.processedOn ? 'active' : 'waiting',
      correlativo: numero,
      ruc: ruc,
      timestamp: timestamp,
      error: job.failedReason || null,
      attempts: job.attemptsMade || 0
    };
  };

  // Combinar jobs de ambas colas y ordenar por fecha
  const allJobs = [
    ...completed.map(job => formatJob(job, 'facturacion')),
    ...failed.map(job => formatJob(job, 'facturacion')),
    ...active.map(job => formatJob(job, 'facturacion')),
    ...waiting.map(job => formatJob(job, 'facturacion')),
    ...kudeCompleted.map(job => formatJob(job, 'kude')),
    ...kudeFailed.map(job => formatJob(job, 'kude')),
    ...kudeActive.map(job => formatJob(job, 'kude')),
    ...kudeWaiting.map(job => formatJob(job, 'kude'))
  ];

  allJobs.sort((a, b) => b.timestamp - a.timestamp);
  return allJobs.slice(0, limit);
}

/**
 * Reintentar jobs fallidos
 */
async function retryFailedJobs(queue, limit = 10) {
  const jobs = await queue.getFailed();
  const toRetry = jobs.slice(0, limit);

  for (const job of toRetry) {
    await job.retry();
    console.log(`🔄 Job ${job.id} reencolado para reintento`);
  }

  return toRetry.length;
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  describirRedis,
  facturaQueue,
  kudeQueue,
  getQueueStats,
  getRecentJobs,
  cleanCompletedJobs,
  cleanFailedJobs,
  cleanAllJobs,
  retryFailedJobs,
  redisConfig
};
