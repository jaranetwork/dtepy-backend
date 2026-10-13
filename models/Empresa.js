const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const empresaSchema = new mongoose.Schema({
  // Identidad tributaria (LO MÁS IMPORTANTE)
  ruc: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    validate: {
      validator: function(v) {
        // Acepta RUC con o sin guiones, mínimo 6 dígitos
        // Ejemplos válidos: 8001234-5, 80012345, 80012345-1, 2005001-1
        const sinGuiones = v.replace(/[^0-9]/g, '');
        return sinGuiones.length >= 6 && sinGuiones.length <= 12;
      },
      message: 'RUC inválido. Debe tener entre 6-12 dígitos'
    },
    index: true
  },
  nombreFantasia: {
    type: String,
    required: true,
    trim: true
  },
  razonSocial: {
    type: String,
    required: true,
    trim: true
  },

  // Datos del emisor para el DTE. Si están cargados, las integraciones pueden
  // omitir param.establecimientos / param.actividadesEconomicas / etc. en cada
  // factura: procesarFacturaService los toma de acá como fallback.
  tipoContribuyente: {
    type: Number,
    enum: [1, 2]              // 1 = persona física, 2 = persona jurídica
  },
  tipoRegimen: {
    type: Number,
    min: 1,
    max: 8                    // 1 = Régimen de Turismo ... 8 = Régimen Contable
  },
  actividadesEconomicas: [{
    _id: false,
    codigo: { type: String, required: true, trim: true },
    descripcion: { type: String, required: true, trim: true }
  }],
  establecimientos: [{
    _id: false,
    codigo: { type: String, required: true, trim: true },        // '001'
    denominacion: { type: String, required: true, trim: true },
    direccion: { type: String, trim: true },
    numeroCasa: { type: String, trim: true },
    departamento: Number,
    departamentoDescripcion: String,
    distrito: Number,
    distritoDescripcion: String,
    ciudad: Number,
    ciudadDescripcion: String,
    telefono: String,
    email: String
  }],

  // Configuración SIFEN v150 (datos específicos de cada empresa)
  configuracionSifen: {
    // Timbrado proporcionado por SET
    timbrado: {
      type: String,
      required: true,
      default: '12345678',
      maxlength: 8
    },
    // Fecha de inicio de vigencia del timbrado (YYYY-MM-DD): va en el DTE
    // como dFeIniT. Si falta, se usa la del payload.
    timbradoFecha: {
      type: String,
      match: /^\d{4}-\d{2}-\d{2}$/
    },
    // Establecimiento y punto de expedición POR DEFECTO para la emisión:
    // se usan cuando la factura no trae data.establecimiento / data.punto.
    // Cada punto lleva su propia numeración correlativa independiente.
    establecimiento: {
      type: String,
      default: '001',
      maxlength: 3
    },
    puntoExpedicion: {
      type: String,
      default: '001',
      maxlength: 3
    },
    // Puntos de expedición ADICIONALES habilitados para esta empresa. El
    // payload solo puede pedir el punto por defecto o uno de esta lista: así
    // una integración no emite por error en un rango que pertenece a otro
    // sistema de la misma empresa.
    puntosExpedicion: [{
      type: String,
      maxlength: 3
    }],
    // CSC - Código Secreto del Contribuyente (proporcionado por SET)
    idCSC: {
      type: String,
      required: true,
      default: '0001',
      maxlength: 4
    },
    csc: {
      type: String,
      required: true,
      maxlength: 32,
      minlength: 32
    },
    // Modo de operación
    modo: {
      type: String,
      enum: ['test', 'produccion'],
      default: 'test'
    },
    // URL del logo de la empresa para KUDE
    urlLogo: {
      type: String,
      default: 'https://lrtv.jaranetwork.com/sites/default/files/styles/poster/public/logos/hit.png?itok=UHWpjKPdd'
    },
    envioFacturas: {
      type: String,
      enum: ['normal', 'lotes'],
      default: 'normal'
    },
    // Validación del receptor pre-SIFEN (services/receptorValidator.js):
    //   'estricto'    → errores rechazan la emisión con 400 RECEPTOR_INVALIDO
    //   'advertencia' → normaliza + registra en OperationLog sin rechazar
    //   'off'         → sin validación (escape hatch)
    validacionReceptor: {
      type: String,
      enum: ['estricto', 'advertencia', 'off'],
      default: 'advertencia'
    },
    // Monedas en las que la empresa acepta emitir (política contable).
    // SIFEN admite cualquier ISO 4217, pero la contabilidad define cuáles
    // usa: una emisión en otra moneda se rechaza con MONEDA_NO_PERMITIDA.
    monedasPermitidas: {
      type: [String],
      default: ['PYG', 'USD']
    }
  },
  
  // Notificaciones al integrador cuando una factura llega a estado final
  notificaciones: {
    // URL que recibe un POST firmado (X-DTE-Firma: HMAC-SHA256 del body)
    webhookUrl: {
      type: String,
      trim: true
    },
    // Secreto para firmar el webhook (el integrador verifica la firma)
    webhookSecret: {
      type: String
    },
    // Enviar el KUDE (PDF) + XML por email al cliente al aprobarse.
    // Usa el proveedor SMTP seleccionado (smtpProviderId); si no hay,
    // cae a las variables de entorno SMTP_* del servidor.
    emailAutomatico: {
      type: Boolean,
      default: false
    },
    // Proveedor SMTP con el que se envían los emails de esta empresa
    smtpProviderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SmtpProvider',
      default: null
    }
  },

  // Actualización automática de las cotizaciones de moneda extranjera desde
  // un proveedor del catálogo (services/cotizacionProveedores.js). Apagada por
  // defecto: mientras esté apagada, la cotización la sigue declarando el usuario.
  cotizacionesAutomaticas: {
    activo: {
      type: Boolean,
      default: false
    },
    // id del catálogo hardcodeado; NUNCA una URL
    proveedor: {
      type: String,
      default: 'sistemaaguila'
    },
    // monedas a sincronizar (ISO 4217). Vacío = ninguna.
    monedas: {
      type: [String],
      default: ['USD']
    },
    // qué valor del par se declara como cotización
    tipoValor: {
      type: String,
      enum: ['compra', 'venta', 'promedio'],
      default: 'venta'
    },
    // Guarda de seguridad: si el valor nuevo se aparta de la cotización vigente
    // más que este porcentaje, NO se aplica solo y queda para revisión manual.
    // Evita que un error de la fuente se cuele en documentos fiscales firmados.
    variacionMaximaPct: {
      type: Number,
      default: 10,
      min: 0.1,
      max: 100
    },
    // Lock de exclusión entre corridas (worker vs. "Sincronizar ahora"): lo
    // toma quien va a salir a la fuente y lo suelta al terminar. Vencido (60 s)
    // se puede volver a tomar, así un proceso caído no bloquea para siempre.
    sincronizandoDesde: Date,
    // Resultado del último intento (para mostrar en la UI y diagnosticar)
    ultimaSincronizacion: {
      en: Date,
      estado: { type: String, enum: ['ok', 'sin_cambios', 'pendiente_fuente', 'bloqueada', 'error'] },
      fechaCotizacion: String,
      mensaje: String
    }
  },

  // Certificado digital (solo metadatos, archivo en filesystem)
  certificado: {
    nombreArchivo: String,
    contrasena: String,  // Cifrada con AES-256
    fechaVencimiento: Date,
    fechaCarga: Date,
    activo: {
      type: Boolean,
      default: false
    }
  },
  
  // Relación con el usuario admin (dueño)
  usuarioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Usuarios (además del dueño) que ven la empresa y operan sus documentos.
  // No pueden cambiar la configuración ni el certificado. Lo administra un
  // admin desde Usuarios.
  usuariosConAcceso: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: [],
    index: true
  },
  
  // Datos de contacto
  direccion: String,
  telefono: String,
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  
  // Estado
  activo: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Método: Obtener ruta del certificado
empresaSchema.methods.obtenerRutaCertificado = function() {
  const basePath = process.env.CERTIFICADOS_PATH || 
    path.join(__dirname, '../certificados');
  return path.join(basePath, this.ruc, 'certificado.p12');
};

// Método: Verificar si tiene certificado válido
empresaSchema.methods.tieneCertificadoValido = function() {
  if (!this.certificado?.activo) return false;
  const ruta = this.obtenerRutaCertificado();
  const existe = require('fs').existsSync(ruta);
  // La fecha de vencimiento es opcional, solo verificamos que el archivo exista
  return existe;
};

// Método estático: Buscar por RUC
empresaSchema.statics.findByRuc = function(ruc) {
  return this.findOne({ ruc });
};

// Middleware: Normalizar RUC con guión antes de guardar
// El RUC paraguayo tiene formato: 8 dígitos + guión + 1 dígito verificador
// Ejemplo: 8001234-5, 2005001-1
empresaSchema.pre('save', function(next) {
  if (this.isNew || this.isModified('ruc')) {
    // Si el RUC no tiene guión y tiene 7-9 dígitos, agregar guión antes del último
    const rucSinGuiones = this.ruc.replace(/[^0-9]/g, '');
    if (rucSinGuiones.length >= 7 && rucSinGuiones.length <= 9 && !this.ruc.includes('-')) {
      // Insertar guión antes del último dígito (DV)
      const parteNumerica = rucSinGuiones.slice(0, -1);
      const dv = rucSinGuiones.slice(-1);
      this.ruc = `${parteNumerica}-${dv}`;
    }
  }
  next();
});

// Middleware: Crear carpeta RUC al crear empresa
empresaSchema.pre('save', async function(next) {
  if (this.isNew) {
    const certificadoService = require('../services/certificadoService');
    certificadoService.crearCarpetaRuc(this.ruc);
  }
  next();
});

module.exports = mongoose.model('Empresa', empresaSchema);
