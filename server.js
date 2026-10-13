/**
 * Servidor para generar facturas electrónicas en XML para Paraguay
 * Con integración de base de datos MongoDB para registro de operaciones
 */

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { sanitizarMongo } = require('./middleware/sanitizarMongo');

// Configurar Express
const app = express();

// Detrás de un reverse proxy (Traefik/nginx): necesario para que req.ip sea
// la IP real del cliente y no la del proxy (el rate limit depende de esto).
app.set('trust proxy', 1);

// Cabeceras de seguridad. El CSP se desactiva porque rompería Swagger UI
// (/api/docs); el resto de las protecciones de helmet quedan activas.
app.use(helmet({ contentSecurityPolicy: false }));

// ========================================
// CORS
// ========================================
// Va ANTES de las rutas: si se registra después, Express ya respondió y las
// cabeceras nunca se envían (por eso el frontend solo funcionaba con proxy).
//
// CORS_ORIGINS: lista separada por comas con los orígenes del frontend.
// Ej: CORS_ORIGINS=https://app.midominio.com,http://localhost:3000
// Con '*' (por defecto) se acepta cualquier origen.
const origenesPermitidos = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((origen) => origen.trim())
  .filter(Boolean);

app.use(cors({
  origin: origenesPermitidos.includes('*') ? '*' : origenesPermitidos,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition']
}));

// Middleware para parsear JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Eliminar operadores de MongoDB ($ne, $where, ...) de body/query/params
app.use(sanitizarMongo);

// ========================================
// RATE LIMIT DEL LOGIN (anti fuerza bruta)
// ========================================
// 10 intentos por IP cada 15 minutos. Los logins exitosos no cuentan.
const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Demasiados intentos de inicio de sesión. Probá de nuevo en unos minutos.'
  }
});

// Importar rutas
const statsRoutes = require('./routes/stats');
const invoiceRoutes = require('./routes/invoices');
const authController = require('./controllers/authController');
const apiKeyController = require('./controllers/apiKeyController');
const { verificarToken, verificarAdmin, requerirSesionUsuario } = require('./middleware/auth');

// Rutas de empresas y facturación
const empresaRoutes = require('./routes/empresas');
const facturarRoutes = require('./routes/facturar');
const eventosRoutes = require('./routes/eventos');
const lotesRoutes = require('./routes/lotes');

// Nuevos routers (refactor de endpoints inline)
const queueRoutes = require('./routes/queue');
const facturaRoutes = require('./routes/factura');
const consultaRoutes = require('./routes/consulta');
const logsRoutes = require('./routes/logs');
const cotizacionesRoutes = require('./routes/cotizaciones');
const utilidadesRoutes = require('./routes/utilidades');
const smtpProviderRoutes = require('./routes/smtpProviders');
const usuariosRoutes = require('./routes/usuarios');

// Usar rutas
app.use('/api/stats', statsRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/empresas', empresaRoutes);
app.use('/api/facturar', facturarRoutes);
app.use('/api/eventos', eventosRoutes);
app.use('/api/lotes', lotesRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/factura', facturaRoutes);
app.use('/api/consulta', consultaRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/cotizaciones', cotizacionesRoutes);
app.use('/api/utils', utilidadesRoutes);
app.use('/api/smtp-providers', smtpProviderRoutes);
app.use('/api/usuarios', usuariosRoutes);

// Rutas de autenticación (públicas)
app.post('/api/auth/login', limiteLogin, authController.login);
// Rutas de autenticación (solo sesión JWT: una API Key no gestiona el perfil)
app.get('/api/auth/perfil', verificarToken, requerirSesionUsuario, authController.getPerfil);
app.put('/api/auth/perfil', verificarToken, requerirSesionUsuario, authController.actualizarPerfil);
app.post('/api/auth/cambiar-password', verificarToken, requerirSesionUsuario, authController.cambiarPassword);
app.post('/api/auth/logout', verificarToken, requerirSesionUsuario, authController.logout);

// Rutas de API Keys (solo sesión JWT: una API Key filtrada no debe poder
// crear ni renovar credenciales — eso sería escalación de privilegios)
app.post('/api/api-keys', verificarToken, requerirSesionUsuario, apiKeyController.crearApiKey);
app.get('/api/api-keys', verificarToken, requerirSesionUsuario, apiKeyController.listarApiKeys);
app.get('/api/api-keys/:id', verificarToken, requerirSesionUsuario, apiKeyController.obtenerApiKey);
app.put('/api/api-keys/:id/renew', verificarToken, requerirSesionUsuario, apiKeyController.renovarApiKey);
app.delete('/api/api-keys/:id', verificarToken, requerirSesionUsuario, apiKeyController.revocarApiKey);


// ========================================
// DOCUMENTACION DE LA API (publica, sin auth)
// ========================================
// Swagger UI interactivo en /api/docs y el JSON crudo en /api/openapi.json
// (util para generar clientes o importarlo en Postman/Insomnia).
const swaggerUi = require('swagger-ui-express');
const openapi = require('./docs/openapi');

app.get('/api/openapi.json', (req, res) => res.json(openapi));

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, {
  customSiteTitle: 'DTE-PY API',
  swaggerOptions: {
    persistAuthorization: true,  // el token sobrevive al refresco de la pagina
    docExpansion: 'none',
    tagsSorter: 'alpha'
  }
}));

// ========================================
// HEALTH CHECK (publico, sin auth)
// ========================================
// Lo usa el frontend para validar la URL del backend antes de iniciar sesion.
app.get('/api/health', (req, res) => {
  const estadosMongo = ['desconectado', 'conectado', 'conectando', 'desconectando'];
  res.json({
    ok: true,
    servicio: 'dtepy-backend',
    version: require('./package.json').version,
    mongo: estadosMongo[mongoose.connection.readyState] || 'desconocido',
    fecha: new Date().toISOString()
  });
});

// Conectar a MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/sifen_db';

const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Conectado a MongoDB');
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error.message);
    process.exit(1);
  }
};

// ========================================
// INICIO DEL SERVIDOR
// ========================================

// Iniciar el servidor
const PORT = process.env.PORT || 8081;

const iniciarServidor = async () => {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`🚀 Servidor de facturación electrónica iniciado en http://localhost:${PORT}`);
    console.log(`   CORS permitido para: ${origenesPermitidos.join(', ')}`);
    console.log(`📋 Endpoints disponibles:`);
    console.log(`   GET  /api/health - Estado del servicio (público)`);
    console.log(`   GET  /api/docs - Documentación interactiva de la API`);
    console.log(`   POST /api/facturar/crear - Genera factura electrónica (con cola asíncrona)`);
    console.log(`   GET  /api/stats - Estadísticas del sistema`);
    console.log(`   GET  /api/invoices - Lista de facturas`);
    console.log(`   GET  /api/invoices/:id - Detalle de factura`);
    console.log(`   GET  /api/invoices/cdc/:cdc - Consulta por CDC`);
    console.log(`   GET  /api/invoices/estado/:cdc - Estado SET por CDC`);
    console.log(`   POST /api/invoices/:id/refresh-status - Refrescar estado desde SET`);
    console.log(`   GET  /api/factura/estado/:id - Estado de factura (cola)`);
    console.log(`   GET  /api/queue/stats - Estadísticas de la cola`);
    console.log(`   GET  /api/logs - Logs de operaciones`);
    console.log(`   GET  /api/consulta/ruc/:ruc - Consulta RUC en SET`);
  });
};

// Si este archivo es ejecutado directamente, iniciar el servidor
if (require.main === module) {
  iniciarServidor();
}

module.exports = app;
