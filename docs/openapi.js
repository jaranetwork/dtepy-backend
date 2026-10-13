/**
 * Especificación OpenAPI 3.0 de la API de DTE-PY.
 *
 * Se sirve en /api/docs (Swagger UI) y en /api/openapi.json (JSON crudo).
 *
 * Escrita a mano contra las rutas reales, con los responses tipados según lo
 * que cada handler devuelve de verdad (no genéricos). Al agregar o cambiar un
 * endpoint, actualizar también este archivo.
 */

const { version } = require('../package.json');

// ---------------------------------------------------------------------------
// Helpers de construcción
// ---------------------------------------------------------------------------

const ref = (nombre) => ({ $ref: `#/components/schemas/${nombre}` });

const respuestaError = (descripcion) => ({
  description: descripcion,
  content: {
    'application/json': { schema: ref('Error') }
  }
});

const NO_AUTORIZADO = respuestaError('Token o API Key ausentes, inválidos o expirados');
const NO_ENCONTRADO = respuestaError('El recurso no existe o está fuera del alcance del token');
const ERROR_SERVIDOR = respuestaError('Error interno');

const paramRuta = (nombre, descripcion) => ({
  name: nombre,
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: descripcion
});

const paramPagina = [
  {
    name: 'page',
    in: 'query',
    schema: { type: 'integer', default: 1, minimum: 1 },
    description: 'Número de página'
  },
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', default: 10, minimum: 1 },
    description: 'Cantidad de resultados por página'
  }
];

const okJson = (descripcion, schema) => ({
  description: descripcion,
  content: {
    'application/json': {
      schema: schema || ref('RespuestaOk')
    }
  }
});

/** Envoltorio estándar { success, message?, data } con `data` tipado. */
const envuelto = (dataSchema, conMensaje = true) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    ...(conMensaje ? { message: { type: 'string' } } : {}),
    data: dataSchema
  }
});

const fechaHora = (descripcion) => ({
  type: 'string',
  format: 'date-time',
  nullable: true,
  ...(descripcion ? { description: descripcion } : {})
});

const objectId = (descripcion) => ({
  type: 'string',
  example: '68ae1f2b9c3d4e5f6a7b8c9d',
  ...(descripcion ? { description: descripcion } : {})
});

// ---------------------------------------------------------------------------
// Especificación
// ---------------------------------------------------------------------------

module.exports = {
  openapi: '3.0.3',

  info: {
    title: 'DTE-PY — API de Facturación Electrónica (SIFEN Paraguay)',
    version,
    description: `
API del backend DTE-PY para emisión de Documentos Tributarios Electrónicos
ante SIFEN (Paraguay).

## Autenticación

Todos los endpoints requieren autenticación salvo \`/api/health\` y
\`/api/auth/login\`. Se aceptan dos credenciales, ambas en la misma cabecera:

    Authorization: Bearer <token>

- **JWT**: se obtiene con \`POST /api/auth/login\`. Vence según \`JWT_EXPIRES_IN\`
  (24h por defecto). Es lo que usa el frontend.
- **API Key**: se genera con \`POST /api/api-keys\` y no vence salvo que se le
  defina expiración. Es lo que usan las integraciones (ERPNext y similares).

El middleware intenta primero validar el valor como JWT; si no lo es, lo busca
como API Key.

### Permisos de las API Keys

Una sesión JWT opera con el rol del usuario. Una API Key, en cambio, solo
alcanza lo que declaran sus \`permisos\`:

| Permiso | Habilita |
|---|---|
| \`facturas:crear\` | Emitir documentos, reintentos, eventos, envío de lotes |
| \`facturas:leer\` | Consultas, descargas, estado, empresas (lectura) |
| \`facturas:eliminar\` | Borrar facturas y lotes individuales |
| \`stats:leer\` | Estadísticas, logs y estado de la cola |
| \`admin\` | Todos los anteriores |

Además hay operaciones **vedadas a las API Keys** sin importar sus permisos:

- Gestión de credenciales (\`/api/api-keys/*\`, perfil, contraseña): solo
  sesión JWT. Una key filtrada no puede crear ni renovar credenciales.
- Mutaciones de empresas y subida de certificados: solo sesión JWT.
- Destructivas masivas (\`DELETE /api/invoices/clear\`,
  \`DELETE /api/logs/clear\`, \`POST /api/queue/clear*\`): solo sesión JWT
  de un usuario **admin**.

### Alcance multi-empresa

Facturas, eventos, lotes y estadísticas se limitan a las **empresas del
token**: un admin ve todo el sistema; los demás usuarios, las empresas que
crearon y las que un admin les compartió (Usuarios → Empresas con acceso);
una API Key, las empresas de su dueño (o únicamente la empresa a la que esté
asociada). El acceso compartido permite operar los documentos de la empresa,
no cambiar su configuración ni su certificado. Los documentos fuera del alcance responden \`404\`.

### Límites

\`POST /api/auth/login\` admite 10 intentos fallidos por IP cada 15 minutos;
después responde \`429\`.

## Flujo típico de emisión

1. \`POST /api/facturar/crear\` → la factura se encola y responde \`202\` al instante.
2. \`GET /api/factura/estado/:id\` → seguimiento del procesamiento.
3. \`GET /api/invoices/:id/download-xml\` y \`/download-pdf\` → XML firmado y KUDE.

El procesamiento (generar XML, firmar, enviar a SET, generar el PDF) ocurre en
workers asíncronos sobre Redis, no en el request.
`.trim()
  },

  servers: [
    { url: '/', description: 'Servidor actual' },
    { url: 'http://localhost:8081', description: 'Desarrollo local' }
  ],

  tags: [
    { name: 'Salud', description: 'Estado del servicio' },
    { name: 'Autenticación', description: 'Login, perfil y contraseña' },
    { name: 'API Keys', description: 'Credenciales para integraciones' },
    { name: 'Facturación', description: 'Emisión de documentos electrónicos' },
    { name: 'Facturas', description: 'Consulta, descarga y mantenimiento' },
    { name: 'Empresas', description: 'Multi-empresa y certificados digitales' },
    { name: 'Eventos SIFEN', description: 'Cancelación, conformidad, disconformidad' },
    { name: 'Lotes', description: 'Envío agrupado de documentos' },
    { name: 'Cola', description: 'Estado y mantenimiento de la cola de trabajos' },
    { name: 'Cotizaciones', description: 'Cotizaciones de moneda extranjera declaradas (Gs por unidad)' },
    { name: 'Logs', description: 'Auditoría de operaciones' },
    { name: 'Estadísticas', description: 'Métricas del sistema' },
    { name: 'Consultas SET', description: 'Consultas directas a la SET' }
  ],

  security: [{ bearerAuth: [] }],

  paths: {
    // -----------------------------------------------------------------------
    // Salud
    // -----------------------------------------------------------------------
    '/api/health': {
      get: {
        tags: ['Salud'],
        summary: 'Estado del servicio',
        description: 'Público, sin autenticación. Lo usa el frontend para validar la URL del backend antes de iniciar sesión.',
        security: [],
        responses: {
          200: okJson('El servicio responde', ref('SaludServicio'))
        }
      }
    },

    '/api/openapi.json': {
      get: {
        tags: ['Salud'],
        summary: 'Especificación OpenAPI de esta API',
        description: 'Público. Devuelve este mismo documento en JSON, para importarlo en Postman/Insomnia o generar un cliente.',
        security: [],
        responses: {
          200: okJson('Especificación OpenAPI 3.0', { type: 'object' })
        }
      }
    },

    // -----------------------------------------------------------------------
    // Autenticación
    // -----------------------------------------------------------------------
    '/api/auth/login': {
      post: {
        tags: ['Autenticación'],
        summary: 'Iniciar sesión',
        description: 'Público. Devuelve el JWT que se usa como `Bearer` en el resto de la API. Máximo 10 intentos fallidos por IP cada 15 minutos.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string', description: 'Usuario o email', example: 'admin' },
                  password: { type: 'string', format: 'password' }
                }
              }
            }
          }
        },
        responses: {
          200: okJson('Sesión iniciada', ref('LoginRespuesta')),
          400: respuestaError('Faltan username o password'),
          401: respuestaError('Credenciales inválidas o usuario inactivo'),
          429: respuestaError('Demasiados intentos de inicio de sesión')
        }
      }
    },

    '/api/auth/perfil': {
      get: {
        tags: ['Autenticación'],
        summary: 'Obtener el perfil del usuario autenticado',
        description: 'Solo con sesión JWT.',
        responses: {
          200: okJson('Perfil', envuelto({
            type: 'object',
            properties: { usuario: ref('PerfilUsuario') }
          }, false)),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)')
        }
      },
      put: {
        tags: ['Autenticación'],
        summary: 'Actualizar el perfil',
        description: 'Solo con sesión JWT.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  nombre: { type: 'string' },
                  apellido: { type: 'string' },
                  email: { type: 'string', format: 'email' }
                }
              }
            }
          }
        },
        responses: {
          200: okJson('Perfil actualizado', envuelto({
            type: 'object',
            properties: {
              usuario: {
                type: 'object',
                description: 'Versión reducida (sin rol ni fechas)',
                properties: {
                  id: objectId(),
                  username: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  nombre: { type: 'string' },
                  apellido: { type: 'string' }
                }
              }
            }
          })),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)')
        }
      }
    },

    '/api/auth/cambiar-password': {
      post: {
        tags: ['Autenticación'],
        summary: 'Cambiar la contraseña',
        description: 'Solo con sesión JWT.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['passwordActual', 'passwordNuevo'],
                properties: {
                  passwordActual: { type: 'string', format: 'password' },
                  passwordNuevo: { type: 'string', format: 'password' }
                }
              }
            }
          }
        },
        responses: {
          200: okJson('Contraseña actualizada'),
          400: respuestaError('La contraseña actual no coincide'),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)')
        }
      }
    },

    '/api/auth/logout': {
      post: {
        tags: ['Autenticación'],
        summary: 'Cerrar sesión',
        description: 'El JWT no se invalida del lado del servidor: el cliente debe descartarlo.',
        responses: {
          200: okJson('Sesión cerrada'),
          401: NO_AUTORIZADO
        }
      }
    },

    // -----------------------------------------------------------------------
    // API Keys
    // -----------------------------------------------------------------------
    '/api/api-keys': {
      get: {
        tags: ['API Keys'],
        summary: 'Listar API Keys',
        description: 'Solo con sesión JWT (no con API Key). Devuelve solo `keyParcial` (prefijo y sufijo): la clave completa no se guarda en la base y no se puede recuperar.',
        responses: {
          200: okJson('Listado de API Keys del usuario', envuelto({
            type: 'array',
            items: ref('ApiKeyResumen')
          }, false)),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)')
        }
      },
      post: {
        tags: ['API Keys'],
        summary: 'Crear una API Key',
        description: '⚠️ La clave en texto plano se devuelve **una sola vez**, en esta respuesta. Después solo queda su hash: no hay forma de volver a verla. Solo con sesión JWT.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nombre'],
                properties: {
                  nombre: { type: 'string', example: 'Integración ERPNext' },
                  descripcion: { type: 'string' },
                  permisos: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: ['facturas:crear', 'facturas:leer', 'facturas:eliminar', 'stats:leer', 'admin']
                    },
                    default: ['facturas:crear', 'facturas:leer', 'stats:leer']
                  },
                  expiracion: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Opcional. Sin este campo la key no vence.'
                  }
                }
              }
            }
          }
        },
        responses: {
          201: okJson('API Key creada (única vez que se ve la clave)', ref('ApiKeyCreada')),
          400: respuestaError('Falta el nombre'),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)')
        }
      }
    },

    '/api/api-keys/{id}': {
      get: {
        tags: ['API Keys'],
        summary: 'Detalle de una API Key',
        description: 'Solo con sesión JWT. No incluye la clave ni su hash.',
        parameters: [paramRuta('id', 'ID de la API Key')],
        responses: {
          200: okJson('Detalle', envuelto(ref('ApiKeyDetalle'), false)),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)'),
          404: NO_ENCONTRADO
        }
      },
      delete: {
        tags: ['API Keys'],
        summary: 'Revocar una API Key',
        description: 'Solo con sesión JWT.',
        parameters: [paramRuta('id', 'ID de la API Key')],
        responses: {
          200: okJson('Revocada'),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)'),
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/api-keys/{id}/renew': {
      put: {
        tags: ['API Keys'],
        summary: 'Renovar una API Key',
        description: 'Genera una clave nueva manteniendo nombre y permisos. **La anterior deja de funcionar de inmediato.** La nueva se muestra una sola vez. Solo con sesión JWT.',
        parameters: [paramRuta('id', 'ID de la API Key')],
        responses: {
          200: okJson('Renovada (única vez que se ve la clave nueva)', {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: {
                type: 'object',
                description: 'A diferencia de la creación, solo vuelven estos campos',
                properties: {
                  id: objectId(),
                  key: { type: 'string', description: '⚠️ Única vez que se muestra' },
                  nombre: { type: 'string' },
                  fechaCreacion: fechaHora()
                }
              },
              advertencia: { type: 'string' }
            }
          }),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)'),
          404: NO_ENCONTRADO
        }
      }
    },

    // -----------------------------------------------------------------------
    // Facturación
    // -----------------------------------------------------------------------
    '/api/facturar/crear': {
      post: {
        tags: ['Facturación'],
        summary: 'Emitir un documento electrónico',
        description: `
Endpoint principal de integración.

**Es asíncrono**: valida, encola y responde \`202\` de inmediato. El XML se
genera, firma y envía a SET en un worker aparte. Para seguir el avance, usar
\`GET /api/factura/estado/:facturaId\`.

La empresa emisora se resuelve por el \`param.ruc\`, que debe corresponder a una
empresa del alcance del token, activa y con certificado válido.

**Moneda extranjera** (verificado en producción): \`data.moneda: "USD"|"BRL"\`
+ \`data.condicionTipoCambio: 1\` (cotización global) + \`data.cambio\` (guaraníes
por unidad). Los precios de los items y los montos de \`condicion.entregas\` van
en la moneda de la operación (cada entrega también lleva \`moneda\` y \`cambio\`);
el total en guaraníes (dTotalGs) lo calcula el sistema.

**IVA por item** (\`items[].ivaTipo\`): 1 = gravado (con \`ivaBase\` % gravado y
\`iva\` 10/5), 2 = exonerado y 3 = exento (ambos con \`ivaBase: 0, iva: 0\`),
4 = gravado parcial (\`ivaBase\` = % gravado). **Régimen de Turismo (RTC,
Dto. 2063/2024)**: venta local de bienes del anexo a turista extranjero no
residente, exenta de IVA — items con \`ivaTipo: 3\`, cliente **B2C**
(\`tipoOperacion: 2\`) con pasaporte (\`documentoTipo: 2\`) o cédula extranjera
(\`3\`), \`pais: "PRY"\` (regla SIFEN 1320: en operaciones que no son B2F el
país del receptor es siempre PRY; el país de residencia real se consigna en
\`data.observacion\`), y empresa con \`tipoRegimen: 1\`. Requiere estar
inscripto en el registro RTC de la DNIT. **B2F (\`tipoOperacion: 4\`) es solo
para exportación de servicios** — ahí sí va el país real y la dirección del
exterior (obligatoria).

---

## Flow de integración recomendado

1. \`POST /api/facturar/crear\` con el payload mínimo (\`param.ruc\` +
   \`data.cliente\` + \`data.items\` + fecha/condición) → \`202 { facturaId,
   correlativo }\` en milisegundos. La numeración, el emisor, la sucursal y el
   canal de envío salen de la configuración de la empresa.
2. El sistema firma, agrupa en lote, envía a SET y consulta el resultado
   **solo** (≈ 90 s de venta a aprobada, sin intervención).
3. Enterarse del resultado, a elección:
   - **Webhook** (recomendado): configurar \`notificaciones.webhookUrl\` en la
     empresa — se recibe un POST firmado al llegar a estado final.
   - **Polling**: \`GET /api/factura/estado/:facturaId\` cada 10-15 s hasta
     \`estado: "aceptado"\` (con \`proceso: "Completado"\` el PDF ya existe).
4. Entregar el KUDE al cliente:
   - **Email automático**: activar \`notificaciones.emailAutomatico\` (el
     sistema manda PDF + XML a \`data.cliente.email\` al aprobarse), o
   - descargar \`GET /api/invoices/:id/download-pdf\` y adjuntarlo en el email
     propio de confirmación de compra.
5. Si SET rechaza: corregir según \`mensajeRetorno\` y re-POSTear el mismo
   payload con el **mismo** \`data.numero\` (reintento de la misma factura).
6. Anulación (hasta 48 h): \`POST /api/eventos/enviar\` con
   \`tipoEvento: "cancelacion"\`.
`.trim(),
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string', maxLength: 200 },
            description: 'Opcional, una por venta/documento. Si la empresa ya tiene una factura con esa clave que no está rechazada, en error ni cancelada, se devuelve esa (la más reciente; `200`, `data.idempotente: true`) en vez de crear otra: reintentar tras un timeout no duplica. Si todas las de esa clave están rechazadas, en error o canceladas, se emite normalmente. Se recortan espacios; vacía se ignora; más de 200 caracteres → `400 IDEMPOTENCY_KEY_INVALIDA`.'
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: ref('SolicitudFactura') }
          }
        },
        responses: {
          200: okJson('Ya existía una factura para esa Idempotency-Key: se devuelve la existente, no se crea otra', ref('FacturaEncolada')),
          202: okJson('Encolada para procesamiento', ref('FacturaEncolada')),
          400: respuestaError('Datos inválidos o empresa sin certificado'),
          401: NO_AUTORIZADO,
          403: respuestaError('El RUC emisor no pertenece al alcance del token (EMPRESA_FUERA_DE_ALCANCE)'),
          404: respuestaError('No existe una empresa con ese RUC')
        }
      }
    },

    '/api/facturar/validar': {
      post: {
        tags: ['Facturación'],
        summary: 'Validar el receptor sin emitir (dry-run)',
        description: 'Corre exactamente la misma validación y normalización del receptor que `/api/facturar/crear` aplica antes de firmar (reglas del receptor de SIFEN MT v150 + NT vigentes: 1300/1304/1305/1309-1314/1318/1320/1321/1330/1333, formato de pasaporte, DV módulo 11, tope de innominado de 7.000.000 Gs del Decreto 872/2023), sin crear nada. Pensado para que la integración calcule el "invoice readiness" del cliente ANTES de cobrar una orden y sepa exactamente qué corregir. Devuelve además `clienteNormalizado` (documento limpio, DV recalculado, país por defecto, campos prohibidos removidos), que es lo que se firmaría. JWT o API Key con `facturas:leer`.',
        requestBody: {
          content: {
            'application/json': { schema: ref('SolicitudFactura') }
          }
        },
        responses: {
          200: okJson('Resultado de la validación', {
            type: 'object',
            properties: {
              valido: { type: 'boolean' },
              errores: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    codigo: { type: 'string', example: 'RECEPTOR_PAIS_INVALIDO' },
                    regla: { type: 'string', nullable: true, example: '1320', description: 'Código de validación SIFEN que rechazaría el documento' },
                    mensaje: { type: 'string' }
                  }
                }
              },
              advertencias: { type: 'array', items: { type: 'string' } },
              clienteNormalizado: { type: 'object', nullable: true }
            }
          }),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/facturar/empresa/{ruc}': {
      get: {
        tags: ['Facturación'],
        summary: 'Buscar empresa emisora por RUC',
        description: 'Útil para que la integración confirme que el RUC está dado de alta antes de emitir.',
        parameters: [paramRuta('ruc', 'RUC con o sin guión (ej: 80055783-2)')],
        responses: {
          200: okJson('Empresa encontrada', envuelto(ref('EmpresaEmisora'), false)),
          400: respuestaError('RUC requerido'),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/factura/estado/{id}': {
      get: {
        tags: ['Facturación'],
        summary: 'Estado de procesamiento de una factura',
        description: 'Devuelve el estado en SIFEN y el del trabajo en la cola. Es el endpoint a consultar tras un `202` de `/api/facturar/crear`.',
        parameters: [paramRuta('id', 'ID de la factura')],
        responses: {
          200: okJson('Estado', envuelto(ref('EstadoFacturaCola'))),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    // -----------------------------------------------------------------------
    // Facturas
    // -----------------------------------------------------------------------
    '/api/invoices': {
      get: {
        tags: ['Facturas'],
        summary: 'Listar facturas',
        parameters: [
          ...paramPagina,
          {
            name: 'estado',
            in: 'query',
            schema: ref('EstadoSifen'),
            description: 'Filtrar por estado en SIFEN'
          },
          {
            name: 'rucEmpresa',
            in: 'query',
            schema: { type: 'string' },
            description: 'Filtrar por RUC de la empresa emisora'
          },
          {
            name: 'search',
            in: 'query',
            schema: { type: 'string' },
            description: 'Texto a buscar (literal, se interpreta según `searchType`)'
          },
          {
            name: 'searchType',
            in: 'query',
            schema: { type: 'string', enum: ['ruc', 'nombre', 'cdc', 'tipo', 'id'] },
            description: 'Campo sobre el que aplica `search`: RUC o nombre del cliente, CDC, tipo de documento, o ID'
          }
        ],
        responses: {
          200: okJson('Listado paginado', ref('ListadoFacturas')),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/invoices/cdc/{cdc}': {
      get: {
        tags: ['Facturas'],
        summary: 'Buscar una factura por CDC',
        description: 'Primero busca en la base local; si no está, consulta directamente a SIFEN (requiere una empresa con certificado activo).',
        parameters: [paramRuta('cdc', 'Código de Control (44 dígitos)')],
        responses: {
          200: okJson('Factura encontrada (local o en SIFEN)', ref('BusquedaPorCdc')),
          400: respuestaError('CDC requerido, o no hay empresa con certificado para consultar a SIFEN'),
          401: NO_AUTORIZADO,
          404: respuestaError('CDC no encontrado ni localmente ni en SIFEN')
        }
      }
    },

    '/api/invoices/estado/{cdc}': {
      get: {
        tags: ['Facturas'],
        summary: 'Consultar el estado de un CDC directamente en SET',
        description: 'Consulta el CDC en los servicios de la SET usando el certificado de la empresa emisora, y actualiza el estado local si cambió.',
        parameters: [paramRuta('cdc', 'Código de Control (44 dígitos)')],
        responses: {
          200: okJson('Estado según SET', ref('EstadoSegunSet')),
          400: respuestaError('La empresa de la factura no tiene certificado cargado'),
          401: NO_AUTORIZADO,
          404: respuestaError('Factura no encontrada en la base local'),
          500: ERROR_SERVIDOR
        }
      }
    },

    '/api/invoices/logs': {
      get: {
        tags: ['Facturas'],
        summary: 'Logs de operaciones de facturas',
        parameters: [
          ...paramPagina,
          { name: 'tipo', in: 'query', schema: ref('TipoOperacion') },
          { name: 'estado', in: 'query', schema: { type: 'string', enum: ['success', 'error', 'warning'] } }
        ],
        responses: {
          200: okJson('Listado paginado (paginación distinta a /api/logs: usa currentPage y no incluye limit)', {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              logs: { type: 'array', items: ref('LogOperacion') },
              totalPages: { type: 'integer' },
              currentPage: { type: 'integer' },
              total: { type: 'integer' }
            }
          }),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/invoices/clear': {
      delete: {
        tags: ['Facturas'],
        summary: 'Eliminar TODAS las facturas',
        description: '⚠️ Destructivo e irreversible. Requiere **sesión JWT de admin** (una API Key no alcanza) y reconfirmación con la contraseña del usuario.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password'],
                properties: {
                  password: { type: 'string', format: 'password', description: 'Contraseña del usuario autenticado' }
                }
              }
            }
          }
        },
        responses: {
          200: okJson('Facturas eliminadas', {
            type: 'object',
            description: 'Los contadores van en la raiz, no dentro de data',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              deletedCount: { type: 'integer', example: 152, description: 'Facturas eliminadas' },
              deletedLogs: { type: 'integer', example: 480, description: 'Logs de operaciones eliminados' }
            }
          }),
          400: respuestaError('Falta la contraseña o no coincide'),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario admin')
        }
      }
    },

    '/api/invoices/{id}': {
      get: {
        tags: ['Facturas'],
        summary: 'Detalle de una factura',
        parameters: [paramRuta('id', 'ID de la factura')],
        responses: {
          200: okJson('Factura', envuelto(ref('FacturaDetalle'), false)),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      },
      delete: {
        tags: ['Facturas'],
        summary: 'Eliminar una factura',
        description: 'Requiere el permiso `facturas:eliminar` en API Keys. Una factura que pertenece a un lote no se puede eliminar (400 FACTURA_BLOQUEADA_POR_LOTE).',
        parameters: [paramRuta('id', 'ID de la factura')],
        responses: {
          200: okJson('Eliminada', {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              deletedId: objectId('ID de la factura eliminada')
            }
          }),
          400: respuestaError('La factura pertenece a un lote y no puede eliminarse'),
          401: NO_AUTORIZADO,
          403: respuestaError('La API Key no tiene el permiso facturas:eliminar'),
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/invoices/{id}/logs': {
      get: {
        tags: ['Facturas'],
        summary: 'Logs de una factura',
        description: 'A diferencia del resto de la API, responde el array directamente (sin envoltorio `{success, data}`).',
        parameters: [paramRuta('id', 'ID de la factura')],
        responses: {
          200: okJson('Logs de la factura, más recientes primero', {
            type: 'array',
            items: ref('LogOperacion')
          }),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/invoices/{id}/eventos': {
      get: {
        tags: ['Facturas'],
        summary: 'Eventos SIFEN de una factura',
        parameters: [paramRuta('id', 'ID de la factura')],
        responses: {
          200: okJson('Eventos de la factura', {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              total: { type: 'integer' },
              eventos: { type: 'array', items: ref('Evento') }
            }
          }),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/invoices/{id}/retry': {
      post: {
        tags: ['Facturas'],
        summary: 'Reintentar el envío a SIFEN',
        description: 'Reenvía a SET el XML ya firmado de una factura que quedó en error. Requiere `facturas:crear` en API Keys.',
        parameters: [paramRuta('id', 'ID de la factura')],
        responses: {
          200: okJson('Reenvío completado', envuelto({
            type: 'object',
            properties: {
              invoice: ref('FacturaResumen'),
              estado: ref('EstadoSifen'),
              codigoRetorno: { type: 'string', nullable: true, example: '0260' },
              mensajeRetorno: { type: 'string', nullable: true }
            }
          })),
          400: respuestaError('El XML no existe en disco, o la factura ya está en un estado final'),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/invoices/{id}/refresh-status': {
      post: {
        tags: ['Facturas'],
        summary: 'Refrescar el estado desde SET',
        description: 'Consulta el CDC en SET y actualiza el estado local. Si la factura ya está en un estado final (aceptado/rechazado/error/observado) no consulta: esos estados no cambian.',
        parameters: [paramRuta('id', 'ID de la factura')],
        responses: {
          200: okJson('Resultado de la consulta', ref('RefreshEstado')),
          400: respuestaError('La factura no tiene CDC asignado'),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/invoices/{id}/download-xml': {
      get: {
        tags: ['Facturas'],
        summary: 'Descargar el XML firmado',
        parameters: [paramRuta('id', 'ID de la factura')],
        responses: {
          200: {
            description: 'XML firmado (attachment)',
            content: { 'application/xml': { schema: { type: 'string', format: 'binary' } } }
          },
          401: NO_AUTORIZADO,
          404: respuestaError('La factura no existe o el archivo no está en disco')
        }
      }
    },

    '/api/invoices/{id}/download-pdf': {
      get: {
        tags: ['Facturas'],
        summary: 'Descargar el KUDE (PDF)',
        description: 'El PDF lo genera un worker aparte tras la aprobación; puede no estar disponible inmediatamente.',
        parameters: [paramRuta('id', 'ID de la factura')],
        responses: {
          200: {
            description: 'KUDE en PDF (attachment)',
            content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } }
          },
          401: NO_AUTORIZADO,
          404: respuestaError('La factura no existe o el KUDE todavía no fue generado')
        }
      }
    },

    // -----------------------------------------------------------------------
    // Empresas
    // -----------------------------------------------------------------------
    '/api/empresas': {
      get: {
        tags: ['Empresas'],
        summary: 'Listar empresas',
        responses: {
          200: okJson('Empresas del usuario', envuelto({
            type: 'array',
            items: ref('EmpresaCompleta')
          }, false)),
          401: NO_AUTORIZADO
        }
      },
      post: {
        tags: ['Empresas'],
        summary: 'Crear una empresa',
        description: 'Solo con sesión JWT (las mutaciones de empresas no se permiten con API Key). El certificado digital se sube aparte, con `POST /api/empresas/{id}/certificado`.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: ref('Empresa') }
          }
        },
        responses: {
          201: okJson('Empresa creada', envuelto(ref('EmpresaCompleta'))),
          400: respuestaError('Faltan campos requeridos o el RUC/CSC no cumple el formato'),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)')
        }
      }
    },

    '/api/empresas/{id}': {
      get: {
        tags: ['Empresas'],
        summary: 'Detalle de una empresa',
        parameters: [paramRuta('id', 'ID de la empresa')],
        responses: {
          200: okJson('Empresa', envuelto(ref('EmpresaCompleta'), false)),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      },
      put: {
        tags: ['Empresas'],
        summary: 'Actualizar una empresa',
        description: 'Solo con sesión JWT.',
        parameters: [paramRuta('id', 'ID de la empresa')],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('Empresa') } }
        },
        responses: {
          200: okJson('Actualizada', envuelto(ref('EmpresaCompleta'))),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)'),
          404: NO_ENCONTRADO
        }
      },
      delete: {
        tags: ['Empresas'],
        summary: 'Eliminar una empresa',
        description: 'Solo con sesión JWT.',
        parameters: [paramRuta('id', 'ID de la empresa')],
        responses: {
          200: okJson('Eliminada'),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)'),
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/empresas/{id}/certificado': {
      post: {
        tags: ['Empresas'],
        summary: 'Subir el certificado digital (.p12)',
        description: `
Sube el certificado F1 emitido por un Prestador Cualificado de Servicios de
Confianza. Solo se aceptan archivos \`.p12\`, hasta 5 MB. Solo con sesión JWT.

La contraseña se cifra con AES-256-GCM usando \`CERTIFICADO_MASTER_KEY\` antes
de guardarse: **esa variable de entorno tiene que estar configurada antes de
subir el primer certificado**, y si cambia, los certificados ya cargados
quedan indescifrables.
`.trim(),
        parameters: [paramRuta('id', 'ID de la empresa')],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['certificado', 'contrasena'],
                properties: {
                  certificado: { type: 'string', format: 'binary', description: 'Archivo .p12 (máx. 5 MB)' },
                  contrasena: { type: 'string', format: 'password', description: 'Contraseña del .p12' }
                }
              }
            }
          }
        },
        responses: {
          200: okJson('Certificado cargado', envuelto({
            type: 'object',
            properties: {
              nombreArchivo: { type: 'string', example: 'kingston-f1.p12' },
              fechaCarga: fechaHora()
            }
          })),
          400: respuestaError('Archivo no es .p12, supera 5 MB, o la contraseña no abre el certificado'),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)'),
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/empresas/{id}/validar-certificado': {
      get: {
        tags: ['Empresas'],
        summary: 'Validar el certificado cargado',
        description: 'Verifica que el .p12 se pueda abrir con la contraseña guardada e informa su vencimiento.',
        parameters: [paramRuta('id', 'ID de la empresa')],
        responses: {
          200: okJson('Resultado de la validación', envuelto(ref('ValidacionCertificado'), false)),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/empresas/{id}/stats': {
      get: {
        tags: ['Empresas'],
        summary: 'Estadísticas de una empresa',
        parameters: [paramRuta('id', 'ID de la empresa')],
        responses: {
          200: okJson('Estadísticas', envuelto(ref('EstadisticasEmpresa'), false)),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    // -----------------------------------------------------------------------
    // Eventos SIFEN
    // -----------------------------------------------------------------------
    '/api/eventos/enviar': {
      post: {
        tags: ['Eventos SIFEN'],
        summary: 'Enviar un evento a SET',
        description: `
Manual Técnico SIFEN v150, sección 11.

**Cancelación**: solo la puede pedir el emisor, sobre una factura ya aprobada
por SET (estado \`aceptado\` u \`observado\`), y dentro de las **48 horas** de
aprobada (168 horas para el resto de los documentos). El backend valida el
plazo localmente y responde \`EVENTO_CANCELACION_FUERA_DE_PLAZO\` si venció;
en ese caso corresponde emitir una Nota de Crédito. La cancelación es
**irreversible**: al registrarse (\`dCodRes 0600\`) la factura local pasa a
\`estadoSifen: cancelado\`.

**Idempotencia**: si el DTE ya estaba cancelado, SET responde
\`4003 "CDC ya se encuentra con el mismo evento solicitado"\` y el backend lo
trata como \`registrado\` (marca la factura igual). SET a veces responde
\`0100 Error Inesperado\` (transitorio): reintentar el mismo pedido.

**Eventos del receptor** (conformidad, disconformidad, desconocimiento,
notificación): los campos extra que exige SIFEN van en \`datosEvento\`.
\`devolucion_ajuste\` **no** es un evento: se documenta con Nota de Crédito
(la API lo rechaza con 400).

El resultado de SET viene en \`data\`: \`estadoEvento: registrado\` con
\`codigoRetorno 0600/0601\` (o 4003 idempotente) = éxito;
\`rechazado\` = SET no lo aceptó (ver \`mensajeRetorno\`).
`.trim(),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['invoiceId', 'tipoEvento', 'descripcion'],
                properties: {
                  invoiceId: objectId('ID de la factura'),
                  tipoEvento: {
                    type: 'string',
                    enum: ['cancelacion', 'conformidad', 'disconformidad', 'desconocimiento', 'notificacion_recepcion'],
                    description: 'Tipo de evento a registrar (devolucion_ajuste no se acepta: usar Nota de Crédito)'
                  },
                  descripcion: { type: 'string', minLength: 5, maxLength: 500, description: 'Motivo del evento (SIFEN exige de 5 a 500 caracteres)' },
                  datosEvento: {
                    type: 'object',
                    description: 'Campos adicionales que exige SIFEN según el tipo de evento. cancelacion/disconformidad: ninguno. conformidad: tipoConformidad (1=total, 2=parcial; con 2 es obligatoria fechaRecepcion "YYYY-MM-DDTHH:mm:ss"). desconocimiento/notificacion_recepcion: fechaEmision, fechaRecepcion, tipoReceptor, nombre (y documento del receptor).',
                    additionalProperties: true,
                    example: { tipoConformidad: 1 }
                  },
                  usuario: {
                    type: 'object',
                    description: 'Opcional; por defecto se toma del usuario autenticado',
                    properties: {
                      documentoNumero: { type: 'string' },
                      nombre: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          200: okJson('Evento enviado a SET (ver data.estadoEvento: registrado o rechazado)', envuelto(ref('ResultadoEvento'))),
          400: respuestaError('Faltan campos, el tipo no es válido (devolucion_ajuste incluido), la factura no está aprobada (aceptado/observado), o la cancelación está fuera de plazo (EVENTO_CANCELACION_FUERA_DE_PLAZO, con horasLimite y horasTranscurridas)'),
          401: NO_AUTORIZADO,
          404: respuestaError('Factura no encontrada'),
          500: respuestaError('EVENTO_ENVIO_ERROR: fallo generando/firmando/enviando el evento (p.ej. datosEvento incompleto para eventos del receptor)')
        }
      }
    },

    '/api/eventos': {
      get: {
        tags: ['Eventos SIFEN'],
        summary: 'Listar eventos',
        parameters: [
          ...paramPagina,
          { name: 'tipoEvento', in: 'query', schema: ref('TipoEvento') },
          {
            name: 'estadoEvento',
            in: 'query',
            schema: { type: 'string', enum: ['enviado', 'registrado', 'rechazado', 'error'] }
          },
          { name: 'cdc', in: 'query', schema: { type: 'string' } }
        ],
        responses: {
          200: okJson('Listado paginado', {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              eventos: { type: 'array', items: ref('Evento') },
              totalPages: { type: 'integer' },
              currentPage: { type: 'integer' },
              total: { type: 'integer' }
            }
          }),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/eventos/factura/{invoiceId}': {
      get: {
        tags: ['Eventos SIFEN'],
        summary: 'Eventos de una factura',
        parameters: [paramRuta('invoiceId', 'ID de la factura')],
        responses: {
          200: okJson('Eventos', {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              total: { type: 'integer' },
              eventos: { type: 'array', items: ref('Evento') }
            }
          }),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/eventos/cdc/{cdc}': {
      get: {
        tags: ['Eventos SIFEN'],
        summary: 'Eventos por CDC',
        parameters: [paramRuta('cdc', 'Código de Control')],
        responses: {
          200: okJson('Eventos', {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              total: { type: 'integer' },
              eventos: { type: 'array', items: ref('Evento') }
            }
          }),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/eventos/{id}': {
      get: {
        tags: ['Eventos SIFEN'],
        summary: 'Detalle de un evento',
        parameters: [paramRuta('id', 'ID del evento')],
        responses: {
          200: okJson('Evento', {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              evento: ref('Evento')
            }
          }),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    // -----------------------------------------------------------------------
    // Lotes
    // -----------------------------------------------------------------------
    '/api/lotes/list': {
      get: {
        tags: ['Lotes'],
        summary: 'Listar lotes de envío',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          {
            name: 'estado',
            in: 'query',
            schema: { type: 'string', enum: ['en_espera', 'enviado', 'procesando', 'completado', 'error'] }
          },
          { name: 'empresaId', in: 'query', schema: { type: 'string' } },
          { name: 'tipoDocumento', in: 'query', schema: { type: 'string' } }
        ],
        responses: {
          200: okJson('Listado paginado', {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'array', items: ref('Lote') },
              total: { type: 'integer' },
              page: { type: 'integer' },
              totalPages: { type: 'integer' }
            }
          }),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/lotes/{id}': {
      get: {
        tags: ['Lotes'],
        summary: 'Detalle de un lote',
        parameters: [paramRuta('id', 'ID del lote')],
        responses: {
          200: okJson('Lote', envuelto(ref('Lote'), false)),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      },
      delete: {
        tags: ['Lotes'],
        summary: 'Eliminar un lote',
        description: 'Solo lotes en estado `en_espera` o `error`. Requiere `facturas:eliminar` en API Keys.',
        parameters: [paramRuta('id', 'ID del lote')],
        responses: {
          200: okJson('Eliminado', {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              facturasDesvinculadas: { type: 'integer', description: 'Facturas que quedaron sin lote (no se eliminan)' }
            }
          }),
          400: respuestaError('El lote no está en un estado eliminable'),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/lotes/enviar/{id}': {
      post: {
        tags: ['Lotes'],
        summary: 'Enviar un lote a SET',
        description: 'Requiere `facturas:crear` en API Keys.',
        parameters: [paramRuta('id', 'ID del lote')],
        responses: {
          200: okJson('Lote enviado', envuelto(ref('Lote'))),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    '/api/lotes/enviar-pendientes': {
      post: {
        tags: ['Lotes'],
        summary: 'Enviar todos los lotes en espera',
        description: 'Requiere `facturas:crear` en API Keys.',
        responses: {
          200: okJson('Resultado por lote', envuelto({
            type: 'array',
            items: {
              type: 'object',
              properties: {
                loteId: objectId(),
                success: { type: 'boolean' },
                error: { type: 'string', description: 'Presente solo cuando success es false' }
              }
            }
          }, false)),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/lotes/consultar/{id}': {
      post: {
        tags: ['Lotes'],
        summary: 'Consultar el resultado de un lote en SET',
        description: 'Consulta el número de lote en SET y actualiza el estado de cada factura del lote. Requiere `facturas:crear` en API Keys.',
        parameters: [paramRuta('id', 'ID del lote')],
        responses: {
          200: okJson('Resultado de la consulta', envuelto({
            type: 'object',
            description: 'Estado del lote y de sus facturas según SET',
            additionalProperties: true
          }, false)),
          401: NO_AUTORIZADO,
          404: NO_ENCONTRADO
        }
      }
    },

    // -----------------------------------------------------------------------
    // Cola
    // -----------------------------------------------------------------------
    '/api/queue/stats': {
      get: {
        tags: ['Cola'],
        summary: 'Estadísticas de las colas',
        description: 'Trabajos en espera, activos, completados y fallidos de las colas `facturacion` y `kude`.',
        responses: {
          200: okJson('Contadores por cola', envuelto(ref('ColaEstadisticas'))),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/queue/jobs': {
      get: {
        tags: ['Cola'],
        summary: 'Trabajos recientes',
        description: 'Trabajos de ambas colas combinados, más recientes primero.',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }],
        responses: {
          200: okJson('Trabajos recientes', envuelto({
            type: 'array',
            items: ref('TrabajoCola')
          })),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/queue/clear': {
      post: {
        tags: ['Cola'],
        summary: 'Limpiar trabajos completados',
        description: 'Requiere sesión JWT de admin.',
        requestBody: { content: { 'application/json': { schema: ref('LimpiezaCola') } } },
        responses: {
          200: okJson('Cola limpiada', ref('ResultadoLimpieza')),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario admin')
        }
      }
    },

    '/api/queue/clear-completed': {
      post: {
        tags: ['Cola'],
        summary: 'Limpiar trabajos completados',
        description: 'Requiere sesión JWT de admin.',
        requestBody: { content: { 'application/json': { schema: ref('LimpiezaCola') } } },
        responses: {
          200: okJson('Cola limpiada', ref('ResultadoLimpieza')),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario admin')
        }
      }
    },

    '/api/queue/clear-failed': {
      post: {
        tags: ['Cola'],
        summary: 'Limpiar trabajos fallidos',
        description: 'Requiere sesión JWT de admin.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  queue: { type: 'string', enum: ['facturacion', 'kude'], default: 'facturacion' }
                }
              }
            }
          }
        },
        responses: {
          200: okJson('Cola limpiada', ref('ResultadoLimpieza')),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario admin')
        }
      }
    },

    '/api/queue/clear-all': {
      post: {
        tags: ['Cola'],
        summary: 'Vaciar la cola por completo',
        description: '⚠️ Elimina todos los trabajos, incluidos los pendientes de procesar. Requiere sesión JWT de admin.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  queue: { type: 'string', enum: ['facturacion', 'kude'], default: 'facturacion' }
                }
              }
            }
          }
        },
        responses: {
          200: okJson('Cola vaciada', ref('ResultadoLimpieza')),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario admin')
        }
      }
    },

    // -----------------------------------------------------------------------
    // Cotizaciones
    // -----------------------------------------------------------------------
    '/api/cotizaciones': {
      get: {
        tags: ['Cotizaciones'],
        summary: 'Cotizaciones vigentes',
        description: 'Última cotización declarada por empresa y moneda (guaraníes por unidad). JWT o API Key con `facturas:leer`.',
        responses: {
          200: {
            description: 'Vigentes por empresa y moneda',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          cotizacionId: { type: 'string', example: '6a91b2c3d4e5f60718293a4b' },
                          empresaId: { type: 'string' },
                          moneda: { type: 'string', example: 'USD' },
                          valor: { type: 'number', example: 7300, description: 'Guaraníes por unidad de la moneda' },
                          declaradaPor: {
                            type: 'object',
                            properties: {
                              tipo: { type: 'string', enum: ['usuario', 'api_key', 'automatica'], description: '`automatica` = la declaró el sincronizador desde el proveedor configurado' },
                              nombre: { type: 'string' },
                              email: { type: 'string' }
                            }
                          },
                          declaradaEn: { type: 'string', format: 'date-time' }
                        }
                      }
                    },
                    monedasSoportadas: { type: 'array', items: { type: 'string' }, description: 'Códigos ISO aceptados (catálogo SIFEN, sin PYG)' }
                  }
                }
              }
            }
          },
          401: { description: 'Token faltante o inválido' }
        }
      },
      post: {
        tags: ['Cotizaciones'],
        summary: 'Declarar una cotización',
        description: 'Declara la cotización vigente de una moneda para la empresa (queda historial de quién y cuándo). La cotización SIEMPRE la declara el usuario: el sistema no la consulta de ninguna fuente externa. Sesión JWT, o API Key con permiso `cotizaciones:editar` (pensado para un actualizador automático externo). Con una sola empresa en el alcance, `empresaId`/`ruc` es opcional.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['moneda', 'valor'],
                properties: {
                  moneda: { type: 'string', example: 'USD', description: 'Código ISO del catálogo SIFEN (distinto de PYG)' },
                  valor: { type: 'number', example: 7300, description: 'Guaraníes por unidad de la moneda, mayor a 0' },
                  empresaId: { type: 'string', description: 'Opcional si el alcance tiene una sola empresa' },
                  ruc: { type: 'string', description: 'Alternativa a empresaId', example: '80055783-2' }
                }
              }
            }
          }
        },
        responses: {
          201: {
            description: 'Cotización declarada (vigente desde ahora)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string', example: 'Cotización USD declarada: 7300 Gs' },
                    data: {
                      type: 'object',
                      properties: {
                        cotizacionId: { type: 'string' },
                        empresaId: { type: 'string' },
                        ruc: { type: 'string' },
                        moneda: { type: 'string', example: 'USD' },
                        valor: { type: 'number', example: 7300 },
                        declaradaPor: { type: 'object' },
                        declaradaEn: { type: 'string', format: 'date-time' }
                      }
                    }
                  }
                }
              }
            }
          },
          400: { description: 'Moneda inválida, valor inválido o empresa no indicada (MONEDA_INVALIDA / COTIZACION_INVALIDA / EMPRESA_REQUERIDA)' },
          401: { description: 'Token faltante o inválido' },
          403: { description: 'API Key sin permiso cotizaciones:editar' },
          404: { description: 'EMPRESA_FUERA_DE_ALCANCE' }
        }
      }
    },

    '/api/cotizaciones/proveedores': {
      get: {
        tags: ['Cotizaciones'],
        summary: 'Catálogo de proveedores de cotización automática',
        description: 'Lista HARDCODEADA de fuentes disponibles. La empresa solo puede elegir un `id` de esta lista: no se acepta una URL arbitraria (sería un SSRF y una vía para inyectar cotizaciones falsas en documentos fiscales). JWT o API Key con `facturas:leer`.',
        responses: {
          200: okJson('Proveedores disponibles', envuelto({
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', example: 'sistemaaguila' },
                nombre: { type: 'string', example: 'Sistema Águila (cotizaciones SET)' },
                descripcion: { type: 'string' },
                monedas: { type: 'array', items: { type: 'string' }, example: ['USD', 'BRL', 'ARS', 'JPY', 'EUR', 'GBP'] },
                fuente: { type: 'string', format: 'uri' }
              }
            }
          })),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/cotizaciones/automatica': {
      get: {
        tags: ['Cotizaciones'],
        summary: 'Configuración de la actualización automática',
        description: 'Devuelve la configuración de la empresa y el resultado del último intento de sincronización. `fechaObjetivo` es la fecha de la cotización que rige hoy (la publicada ayer). Con una sola empresa en el alcance, `empresaId`/`ruc` es opcional.',
        parameters: [
          { name: 'empresaId', in: 'query', schema: { type: 'string' }, description: 'ID de la empresa' },
          { name: 'ruc', in: 'query', schema: { type: 'string' }, description: 'RUC de la empresa (alternativa a empresaId)' }
        ],
        responses: {
          200: okJson('Configuración vigente', envuelto(ref('CotizacionAutomatica'))),
          401: NO_AUTORIZADO,
          404: respuestaError('La empresa no existe o no pertenece al alcance')
        }
      },
      put: {
        tags: ['Cotizaciones'],
        summary: 'Configurar la actualización automática',
        description: `
Activa o ajusta la actualización automática. **Solo sesión JWT**: define de dónde
salen valores que terminan en documentos fiscales firmados, así que una API Key
filtrada no puede cambiar la fuente.

**Cómo funciona el ciclo.** En Paraguay la cotización que rige para facturar el día D
es la que la SET/DNIT publicó el día D-1 (la fuente la publica esa misma tarde,
~17:00 PY). Al cambiar el día en hora de Asunción, la empresa queda "sin la
cotización de hoy" y el worker la busca; si la fuente todavía no publicó, reintenta
cada 5 minutos entre las 00:00 y las 06:00, y cada hora el resto del día. Cuando ya
está al día no se hace ninguna petición. Sábados, domingos y feriados la fuente no
publica y sigue vigente la última cotización, que es lo que corresponde.

**Cuándo se aplica.** La fuente publica la cotización del día D la tarde del
propio día D, pero ese valor recién rige el día D+1: si ya publicó la de hoy,
**no se aplica hasta la medianoche**. Y una cotización declarada a mano hoy no
la pisa el sincronizador hasta el día siguiente — una decisión humana sobre el
día en curso manda.

**Guardas** (esto es dinero en documentos firmados):
- Solo fuentes del catálogo, por https, con lista blanca de hosts revalidada tras redirecciones.
- Se rechaza una fecha futura o más vieja que 5 días.
- \`variacionMaximaPct\`: si el valor nuevo se aparta de la cotización vigente más que
  ese porcentaje, **no se aplica** y queda marcado para revisión manual.
- Una sola cotización por empresa+moneda+fecha de la fuente (índice único): reintentar
  no duplica nada.
`.trim(),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  activo: { type: 'boolean', description: 'Requiere al menos una moneda configurada' },
                  proveedor: { type: 'string', example: 'sistemaaguila', description: 'id del catálogo (GET /api/cotizaciones/proveedores)' },
                  monedas: { type: 'array', items: { type: 'string' }, example: ['USD'], description: 'Deben estar entre las que publica el proveedor' },
                  tipoValor: { type: 'string', enum: ['compra', 'venta', 'promedio'], default: 'venta' },
                  variacionMaximaPct: { type: 'number', default: 10, minimum: 0.1, maximum: 100 },
                  empresaId: { type: 'string' },
                  ruc: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          200: okJson('Configuración guardada', envuelto(ref('CotizacionAutomatica'))),
          400: respuestaError('Proveedor, moneda, tipoValor o variación inválidos, o activar sin monedas'),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario (no API Key)')
        }
      }
    },

    '/api/cotizaciones/sincronizar': {
      post: {
        tags: ['Cotizaciones'],
        summary: 'Forzar una sincronización ahora',
        description: 'Consulta la fuente en el momento, salteando el atajo de "ya está al día" y la caché. Las validaciones y la guarda de variación siguen aplicando. Sesión JWT o API Key con `cotizaciones:editar`.\n\nEstados posibles: `ok` (se aplicó), `sin_cambios` (ya estaba), `pendiente_fuente` (la fuente todavía no publicó la del día), `bloqueada` (variación excesiva, requiere revisión) y `error`.',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  empresaId: { type: 'string' },
                  ruc: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          200: okJson('Resultado de la sincronización', envuelto(ref('ResumenSincronizacion'))),
          401: NO_AUTORIZADO,
          502: respuestaError('No se pudo consultar la fuente')
        }
      }
    },

    '/api/cotizaciones/historial': {
      get: {
        tags: ['Cotizaciones'],
        summary: 'Historial de declaraciones',
        description: 'Declaraciones más recientes primero, con quién y cuándo (respaldo contable).',
        parameters: [
          { name: 'moneda', in: 'query', schema: { type: 'string' }, example: 'USD' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } }
        ],
        responses: {
          200: { description: 'Lista de declaraciones (empresaId populado con ruc y nombreFantasia)' },
          401: { description: 'Token faltante o inválido' }
        }
      }
    },

    // -----------------------------------------------------------------------
    // Logs
    // -----------------------------------------------------------------------
    '/api/logs': {
      get: {
        tags: ['Logs'],
        summary: 'Listar logs de operaciones',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 15 } },
          { name: 'estado', in: 'query', schema: { type: 'string', enum: ['success', 'error', 'warning'] } },
          { name: 'tipoOperacion', in: 'query', schema: ref('TipoOperacion') },
          { name: 'invoiceId', in: 'query', schema: { type: 'string' } }
        ],
        responses: {
          200: okJson('Listado paginado', ref('ListadoLogs')),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/logs/clear': {
      delete: {
        tags: ['Logs'],
        summary: 'Eliminar logs',
        description: '⚠️ Borra el rastro de auditoría. Requiere **sesión JWT de admin**: una API Key no alcanza.',
        parameters: [
          {
            name: 'tipo',
            in: 'query',
            schema: { type: 'string', enum: ['all', 'success', 'error', 'warning'] },
            description: 'Sin este parámetro (o con `all`) se eliminan todos'
          }
        ],
        responses: {
          200: okJson('Logs eliminados', envuelto({
            type: 'object',
            properties: { deletedCount: { type: 'integer', example: 320 } }
          })),
          401: NO_AUTORIZADO,
          403: respuestaError('Requiere sesión de usuario admin')
        }
      }
    },

    // -----------------------------------------------------------------------
    // Estadísticas y consultas
    // -----------------------------------------------------------------------
    '/api/stats': {
      get: {
        tags: ['Estadísticas'],
        summary: 'Estadísticas generales',
        description: 'Totales por estado, facturas del día, tendencia de los últimos 7 días y uptime del proceso. Limitado a las empresas del alcance.',
        responses: {
          200: okJson('Estadísticas', envuelto(ref('Estadisticas'), false)),
          401: NO_AUTORIZADO
        }
      }
    },

    '/api/consulta/ruc/{ruc}': {
      get: {
        tags: ['Consultas SET'],
        summary: 'Consultar un RUC en SET',
        description: 'Consulta el padrón de la SET para validar un RUC de cliente antes de facturarle. Usa el certificado de una empresa del alcance. Acepta el RUC con o sin dígito verificador (SET lo exige sin DV; se normaliza automáticamente).',
        parameters: [paramRuta('ruc', 'RUC a consultar, con o sin dígito verificador (ej: 80055783-2 o 80055783)')],
        responses: {
          200: okJson('Contribuyente encontrado', envuelto(ref('ContribuyenteSet'))),
          400: respuestaError('RUC requerido, o no hay empresa con certificado activo para firmar la consulta'),
          401: NO_AUTORIZADO,
          404: respuestaError('SET respondió que el RUC no existe (RUC_NOT_FOUND, con el mensaje de SET)'),
          502: respuestaError('No se pudo consultar a SET (transporte/certificado) o la respuesta tuvo una estructura inesperada')
        }
      }
    },

    '/api/utils/webhook-echo': {
      post: {
        tags: ['Utilidades'],
        summary: 'Receptor de prueba de webhooks (echo)',
        security: [],
        description: 'Receptor de prueba para verificar la integración de webhooks sin backend propio: configurá `notificaciones.webhookUrl` de la empresa apuntando acá, emití una factura, y consultá con el GET lo que llegó (payload y headers de firma). Guarda los últimos 10 en memoria (se pierden al reiniciar). El POST es público, como cualquier receptor de webhooks.',
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: okJson('Recibido', { type: 'object' }) }
      },
      get: {
        tags: ['Utilidades'],
        summary: 'Ver los webhooks recibidos por el echo',
        description: 'Devuelve los últimos webhooks recibidos por el receptor de prueba: `{ recibidoEn, headers: {x-dte-evento, x-dte-firma, user-agent}, body }`. Para verificar la firma: HMAC-SHA256 hex del body (JSON serializado) con el webhookSecret de la empresa.',
        responses: {
          200: okJson('Listado', { type: 'object', properties: { count: { type: 'integer' }, recibidos: { type: 'array', items: { type: 'object' } } } }),
          401: NO_AUTORIZADO
        }
      }
    }
  },

  // -------------------------------------------------------------------------
  // Componentes
  // -------------------------------------------------------------------------
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'JWT obtenido en `/api/auth/login`, o una API Key creada en `/api/api-keys`. Van en la misma cabecera.'
      }
    },

    schemas: {
      // ------------------------------ genéricos ------------------------------
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: { type: 'string', description: 'Código de error estable (para lógica del cliente)', example: 'FACTURA_NOT_FOUND' },
          message: { type: 'string', description: 'Descripción legible' }
        }
      },

      RespuestaOk: {
        type: 'object',
        description: 'Confirmación sin datos adicionales',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string' }
        }
      },

      // ------------------------------ enums ------------------------------
      EstadoSifen: {
        type: 'string',
        enum: ['recibido', 'encolado', 'procesando', 'enviado', 'aceptado', 'observado', 'rechazado', 'error', 'cancelado'],
        description: 'Estado del documento en SIFEN. aceptado/observado/rechazado/error son finales; cancelado indica DTE anulado por evento de cancelación registrado en SET.'
      },

      Proceso: {
        type: 'string',
        nullable: true,
        enum: ['Completado', 'No completado', null],
        description: 'Completado cuando el DTE fue resuelto por SET y el KUDE generado'
      },

      TipoOperacion: {
        type: 'string',
        enum: [
          'inicio_proceso', 'generacion_xml', 'firma_xml', 'envio_sifen',
          'respuesta_sifen', 'error', 'envio_exitoso', 'reintento',
          'reintento_respuesta', 'actualizacion_estado', 'consulta_estado',
          'error_consulta_estado', 'error_respuesta_set', 'encolado_lote', 'envio_lote'
        ]
      },

      TipoEvento: {
        type: 'string',
        enum: [
          'cancelacion',
          'devolucion_ajuste',
          'conformidad',
          'disconformidad',
          'desconocimiento',
          'notificacion_recepcion'
        ],
        description: 'Emisor: cancelacion. Receptor: conformidad, disconformidad, desconocimiento, notificacion_recepcion. devolucion_ajuste queda solo como valor histórico en registros viejos: /api/eventos/enviar lo rechaza (la devolución se documenta con Nota de Crédito).'
      },

      // ------------------------------ salud / auth ------------------------------
      SaludServicio: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          servicio: { type: 'string', example: 'dtepy-backend' },
          version: { type: 'string', example: version },
          mongo: {
            type: 'string',
            enum: ['desconectado', 'conectado', 'conectando', 'desconectando'],
            description: 'Estado de la conexión a MongoDB'
          },
          fecha: { type: 'string', format: 'date-time' }
        }
      },

      Usuario: {
        type: 'object',
        properties: {
          id: objectId(),
          username: { type: 'string', example: 'fabian' },
          email: { type: 'string', format: 'email' },
          nombre: { type: 'string' },
          apellido: { type: 'string' },
          rol: { type: 'string', enum: ['admin', 'usuario', 'contador'] }
        }
      },

      PerfilUsuario: {
        allOf: [
          ref('Usuario'),
          {
            type: 'object',
            properties: {
              activo: { type: 'boolean' },
              ultimoAcceso: fechaHora(),
              fechaCreacion: fechaHora()
            }
          }
        ]
      },

      LoginRespuesta: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Login exitoso' },
          data: {
            type: 'object',
            properties: {
              usuario: ref('Usuario'),
              token: { type: 'string', description: 'JWT para la cabecera Authorization', example: 'eyJhbGciOiJIUzI1NiIs...' }
            }
          }
        }
      },

      // ------------------------------ api keys ------------------------------
      ApiKeyResumen: {
        type: 'object',
        properties: {
          id: objectId(),
          nombre: { type: 'string', example: 'Integración ERPNext' },
          descripcion: { type: 'string' },
          permisos: {
            type: 'array',
            items: { type: 'string', enum: ['facturas:crear', 'facturas:leer', 'facturas:eliminar', 'stats:leer', 'admin'] }
          },
          activa: { type: 'boolean' },
          expiracion: fechaHora('null = no vence'),
          ultimoUso: fechaHora(),
          fechaCreacion: fechaHora(),
          keyParcial: {
            type: 'string',
            example: 'a1b2c3d4...e5f6a7b8',
            description: 'Prefijo y sufijo para identificarla; la clave completa no se puede recuperar'
          }
        }
      },

      ApiKeyDetalle: {
        type: 'object',
        description: 'Documento crudo de la base (a diferencia del listado, usa _id y trae metadatos)',
        properties: {
          _id: objectId(),
          nombre: { type: 'string' },
          descripcion: { type: 'string' },
          permisos: { type: 'array', items: { type: 'string' } },
          activa: { type: 'boolean' },
          keyParcial: { type: 'string', nullable: true },
          expiracion: fechaHora(),
          ultimoUso: fechaHora(),
          ipOrigen: { type: 'string', nullable: true, description: 'IP del último uso' },
          usuario: objectId('Dueño de la key'),
          empresaId: { ...objectId('Empresa asociada'), nullable: true },
          fechaCreacion: fechaHora(),
          createdAt: fechaHora(),
          updatedAt: fechaHora()
        },
        additionalProperties: true
      },

      ApiKeyCreada: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string' },
          data: {
            type: 'object',
            properties: {
              id: objectId(),
              key: {
                type: 'string',
                example: '3f9c2b8e71a4d5f6b0c9e8d7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7',
                description: '⚠️ Única vez que se muestra: no queda guardada en la base'
              },
              nombre: { type: 'string' },
              descripcion: { type: 'string' },
              permisos: { type: 'array', items: { type: 'string' } },
              expiracion: fechaHora(),
              fechaCreacion: fechaHora()
            }
          },
          advertencia: { type: 'string', example: 'Guarda esta API Key en un lugar seguro. No podrás verla nuevamente.' }
        }
      },

      // ------------------------------ facturación ------------------------------
      FacturaEncolada: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Factura encolada para procesamiento asíncrono' },
          data: {
            type: 'object',
            properties: {
              facturaId: objectId(),
              correlativo: { type: 'string', example: '001-001-0000060' },
              estado: ref('EstadoSifen'),
              proceso: ref('Proceso'),
              cdc: { type: 'string', nullable: true, description: '44 dígitos; null hasta que se firma el XML' },
              jobId: { type: 'string', example: 'factura-68ae1f2b9c3d4e5f6a7b8c9d' },
              xmlLink: { type: 'string', format: 'uri' },
              kudeLink: { type: 'string', format: 'uri' },
              urls: {
                type: 'object',
                properties: {
                  estado: { type: 'string', example: '/api/factura/estado/68ae1f2b9c3d4e5f6a7b8c9d' },
                  consulta: { type: 'string', example: '/api/invoices/68ae1f2b9c3d4e5f6a7b8c9d' }
                }
              },
              reintentando: { type: 'boolean', description: 'Presente cuando el correlativo ya existía en error y se reintenta' },
              kudeJobId: { type: 'string', description: 'Presente cuando la factura ya estaba aprobada y solo se regenera el PDF' },
              idempotente: { type: 'boolean', description: 'Presente (true) cuando la Idempotency-Key ya tenía factura y se devuelve esa' }
            }
          }
        }
      },

      EmpresaEmisora: {
        type: 'object',
        description: 'Vista mínima de la empresa para integraciones',
        properties: {
          ruc: { type: 'string', example: '80055783-2' },
          nombreFantasia: { type: 'string', example: 'Kingston Center' },
          razonSocial: { type: 'string', example: 'Kingston Center S.A.' },
          tieneCertificadoValido: { type: 'boolean' },
          activo: { type: 'boolean' }
        }
      },

      EstadoFacturaCola: {
        type: 'object',
        properties: {
          facturaId: objectId(),
          correlativo: { type: 'string', example: '001-001-0000060' },
          estado: ref('EstadoSifen'),
          cdc: { type: 'string', nullable: true },
          codigoRetorno: { type: 'string', nullable: true, example: '0260', description: 'Código de respuesta de SET (0260 = aprobado)' },
          mensajeRetorno: { type: 'string', nullable: true },
          fechaCreacion: fechaHora(),
          fechaEnvio: fechaHora(),
          tipoEmision: { type: 'integer', example: 1 },
          grupoLoteId: { ...objectId('Lote al que pertenece, si se envía por lotes'), nullable: true },
          proceso: ref('Proceso'),
          job: {
            type: 'object',
            description: 'Estado del trabajo en la cola de Bull',
            properties: {
              status: {
                type: 'string',
                nullable: true,
                enum: ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused', null],
                description: 'null si el trabajo ya no está en la cola'
              },
              progress: { type: 'integer', minimum: 0, maximum: 100, example: 100 },
              attempts: { type: 'integer', example: 1 },
              failedReason: { type: 'string', nullable: true }
            }
          }
        }
      },

      // ------------------------------ facturas ------------------------------
      FacturaResumen: {
        type: 'object',
        description: 'Documento de factura como viene de la base, con alias de compatibilidad',
        properties: {
          _id: objectId(),
          empresaId: objectId('Empresa emisora'),
          rucEmpresa: { type: 'string', example: '80055783-2' },
          correlativo: { type: 'string', example: '001-001-0000060' },
          cdc: { type: 'string', nullable: true },
          estadoSifen: ref('EstadoSifen'),
          estado: { allOf: [ref('EstadoSifen')], description: 'Alias de estadoSifen' },
          estadoVisual: { type: 'string', description: 'Estado simplificado para la UI', example: 'aceptado' },
          proceso: ref('Proceso'),
          de: { type: 'string', description: 'Descripción del tipo de documento', example: 'Factura electrónica' },
          cliente: {
            type: 'object',
            properties: {
              ruc: { type: 'string' },
              nombre: { type: 'string' }
            },
            additionalProperties: true
          },
          total: { type: 'number', example: 1500000 },
          codigoRetorno: { type: 'string', nullable: true },
          mensajeRetorno: { type: 'string', nullable: true },
          digestValue: { type: 'string', nullable: true },
          facturaHash: { type: 'string', nullable: true, description: 'Hash interno de idempotencia del payload' },
          tipoEmision: { type: 'integer', example: 1 },
          datosFactura: { type: 'object', additionalProperties: true, description: 'Payload original con el que se emitió (param/data)' },
          xmlContent: { type: 'string', nullable: true, description: 'XML firmado del DTE' },
          xmlPath: { type: 'string', nullable: true },
          kudePath: { type: 'string', nullable: true },
          grupoLoteId: { ...objectId(), nullable: true },
          fechaCreacion: fechaHora(),
          fechaEnvio: fechaHora(),
          fechaProceso: fechaHora('Fecha de resolución en SET'),
          createdAt: fechaHora(),
          updatedAt: fechaHora()
        },
        additionalProperties: true
      },

      ListadoFacturas: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
          invoices: { type: 'array', items: ref('FacturaResumen') },
          totalPages: { type: 'integer', example: 8 },
          currentPage: { type: 'integer', example: 1 },
          total: { type: 'integer', example: 73 }
        }
      },

      FacturaDetalle: {
        type: 'object',
        properties: {
          facturaId: objectId(),
          correlativo: { type: 'string', example: '001-001-0000060' },
          cdc: { type: 'string', nullable: true },
          estado: ref('EstadoSifen'),
          proceso: ref('Proceso'),
          estadoVisual: { type: 'string', example: 'aceptado' },
          esEstadoFinal: { type: 'boolean', description: 'aceptado/rechazado/error/observado no cambian más' },
          recomendarRefresh: { type: 'boolean', description: 'true si conviene consultar el estado en SET' },
          xmlPath: { type: 'string', nullable: true },
          kudePath: { type: 'string', nullable: true },
          xmlLink: { type: 'string', format: 'uri', nullable: true },
          kudeLink: { type: 'string', format: 'uri', nullable: true },
          cliente: { type: 'object', additionalProperties: true },
          total: { type: 'number' },
          fechaCreacion: fechaHora(),
          fechaEnvio: fechaHora(),
          fechaProceso: fechaHora(),
          codigoRetorno: { type: 'string', nullable: true, example: '0260' },
          mensajeRetorno: { type: 'string', nullable: true },
          digestValue: { type: 'string', nullable: true },
          qrCode: { type: 'string', nullable: true, description: 'URL del QR impreso en el KUDE' },
          datosFactura: { type: 'object', nullable: true, description: 'JSON original con el que se emitió', additionalProperties: true },
          xmlContent: { type: 'string', nullable: true, description: 'XML firmado completo' },
          de: { type: 'string', example: 'Factura electrónica' },
          tipoEmision: { type: 'integer', example: 1 },
          grupoLoteId: { ...objectId(), nullable: true }
        }
      },

      BusquedaPorCdc: {
        type: 'object',
        description: 'La fuente indica de dónde salió el resultado',
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
          encontrado: { type: 'boolean' },
          fuente: { type: 'string', enum: ['local', 'sifen'] },
          data: {
            type: 'object',
            description: 'Con fuente=local: resumen de la factura (FacturaResumen). Con fuente=sifen: { respuesta } cruda de SET.',
            additionalProperties: true
          }
        }
      },

      EstadoSegunSet: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
          encontrado: { type: 'boolean' },
          cdc: { type: 'string' },
          estadoLocal: ref('EstadoSifen'),
          proceso: ref('Proceso'),
          estadoSET: { type: 'string', nullable: true, description: 'Estado según la consulta en vivo a SET (null si no se pudo consultar)' },
          estadoActualizado: { type: 'boolean', description: 'true si el estado de SET difiere del local' },
          data: {
            type: 'object',
            properties: {
              correlativo: { type: 'string' },
              codigoRetorno: { type: 'string', nullable: true },
              mensajeRetorno: { type: 'string', nullable: true },
              fechaCreacion: fechaHora(),
              fechaEnvio: fechaHora(),
              fechaProceso: fechaHora(),
              total: { type: 'number' },
              cliente: { type: 'object', additionalProperties: true }
            },
            additionalProperties: true
          }
        }
      },

      RefreshEstado: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
          esEstadoFinal: { type: 'boolean' },
          consultoSET: { type: 'boolean', description: 'false si no hizo falta consultar (estado final)' },
          estadoAnterior: ref('EstadoSifen'),
          estadoActual: ref('EstadoSifen'),
          estadoVisual: { type: 'string' },
          estadoCambio: { type: 'boolean', description: 'true si la consulta cambió el estado local' },
          data: {
            type: 'object',
            properties: {
              estado: ref('EstadoSifen'),
              estadoVisual: { type: 'string' },
              facturaId: objectId(),
              correlativo: { type: 'string' },
              cdc: { type: 'string', nullable: true },
              codigoRetorno: { type: 'string', nullable: true },
              mensajeRetorno: { type: 'string', nullable: true }
            },
            additionalProperties: true
          }
        },
        additionalProperties: true
      },

      // ------------------------------ logs ------------------------------
      LogOperacion: {
        type: 'object',
        properties: {
          _id: objectId(),
          invoiceId: {
            nullable: true,
            description: 'Factura relacionada. En /api/logs y /api/invoices/logs viene populada como objeto {_id, correlativo, cdc, estadoSifen}; en /api/invoices/{id}/logs viene como string (el ObjectId pelado); null en operaciones globales'
          },
          createdAt: fechaHora(),
          updatedAt: fechaHora(),
          tipoOperacion: ref('TipoOperacion'),
          descripcion: { type: 'string', example: 'XML firmado exitosamente' },
          estado: { type: 'string', enum: ['success', 'error', 'warning'] },
          fecha: fechaHora(),
          detalle: { type: 'object', nullable: true, description: 'Contexto adicional de la operación', additionalProperties: true }
        }
      },

      ListadoLogs: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          logs: { type: 'array', items: ref('LogOperacion') },
          total: { type: 'integer', example: 320 },
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 15 },
          totalPages: { type: 'integer', example: 22 }
        }
      },

      // ------------------------------ eventos ------------------------------
      Evento: {
        type: 'object',
        properties: {
          _id: objectId(),
          tipoEvento: ref('TipoEvento'),
          cdc: { type: 'string' },
          correlativo: { type: 'string' },
          invoiceId: {
            type: 'object',
            nullable: true,
            description: 'Factura relacionada (populada en algunos endpoints)',
            properties: {
              _id: objectId(),
              correlativo: { type: 'string' },
              cdc: { type: 'string' },
              estadoSifen: ref('EstadoSifen')
            }
          },
          empresaId: {
            type: 'object',
            nullable: true,
            description: 'Empresa emisora (populada en algunos endpoints)',
            properties: {
              _id: objectId(),
              ruc: { type: 'string' },
              nombreFantasia: { type: 'string' }
            }
          },
          descripcion: { type: 'string', description: 'Motivo declarado del evento' },
          estadoEvento: { type: 'string', enum: ['enviado', 'registrado', 'rechazado', 'error'] },
          codigoRetorno: { type: 'string', nullable: true },
          mensajeRetorno: { type: 'string', nullable: true },
          idEventoSET: { type: 'string', nullable: true, description: 'Protocolo dProtAut que asigna SET al registrar el evento' },
          usuario: {
            type: 'object',
            description: 'Quién solicitó el evento',
            properties: {
              documentoNumero: { type: 'string' },
              nombre: { type: 'string' }
            }
          },
          rucEmpresa: { type: 'string' },
          rucReceptor: { type: 'string', nullable: true },
          xmlEvento: { type: 'string', description: 'XML del evento generado (con sobre SOAP), sin firmar' },
          xmlFirmado: { type: 'string', description: 'XML del evento firmado, tal como se envió a SET' },
          fechaRegistro: fechaHora('Puede faltar en eventos creados por /api/eventos/enviar (usar createdAt)'),
          createdAt: fechaHora(),
          updatedAt: fechaHora()
        },
        additionalProperties: true
      },

      ResultadoEvento: {
        type: 'object',
        description: 'Resultado que devuelve el servicio de eventos (incluye su propio flag success)',
        properties: {
          success: { type: 'boolean' },
          eventoId: objectId('ID del evento guardado'),
          idEventoSET: { type: 'string', nullable: true },
          codigoRetorno: { type: 'string', nullable: true, example: '0600', description: '0600/0601 = evento registrado. En cancelaciones, 4003/4155/4204 ("ya cancelado") también se reportan como registrado (idempotente). 0100 = error transitorio de SET (reintentar).' },
          mensajeRetorno: { type: 'string', nullable: true },
          estadoEvento: { type: 'string', enum: ['enviado', 'registrado', 'rechazado', 'error'] },
          tipoEvento: ref('TipoEvento'),
          cdc: { type: 'string' },
          correlativo: { type: 'string' }
        }
      },

      // ------------------------------ lotes ------------------------------
      Lote: {
        type: 'object',
        properties: {
          _id: objectId(),
          empresaId: {
            type: 'object',
            description: 'Empresa emisora (populada)',
            properties: {
              _id: objectId(),
              ruc: { type: 'string' },
              nombreFantasia: { type: 'string' },
              razonSocial: { type: 'string' }
            }
          },
          tipoDocumento: { type: 'string', example: 'factura' },
          descripcion: { type: 'string' },
          ambiente: { type: 'string', enum: ['test', 'produccion'] },
          estado: { type: 'string', enum: ['en_espera', 'enviado', 'procesando', 'completado', 'error'] },
          count: { type: 'integer', description: 'Cantidad de facturas del lote' },
          facturas: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                facturaId: {
                  type: 'object',
                  description: 'Factura del lote (populada)',
                  properties: {
                    _id: objectId(),
                    correlativo: { type: 'string' },
                    cdc: { type: 'string', nullable: true },
                    estadoSifen: ref('EstadoSifen')
                  }
                },
                estadoIndividual: {
                  type: 'string',
                  enum: ['pendiente', 'aceptado', 'rechazado', 'observado', 'error'],
                  description: 'Resultado de esta factura dentro del lote'
                }
              }
            }
          },
          createdAt: fechaHora(),
          updatedAt: fechaHora()
        },
        additionalProperties: true
      },

      // ------------------------------ cola ------------------------------
      ContadoresCola: {
        type: 'object',
        properties: {
          waiting: { type: 'integer', example: 2, description: 'En espera de un worker' },
          active: { type: 'integer', example: 1, description: 'Procesándose ahora' },
          completed: { type: 'integer', example: 148 },
          failed: { type: 'integer', example: 3 }
        }
      },

      ColaEstadisticas: {
        type: 'object',
        properties: {
          facturacion: ref('ContadoresCola'),
          kude: ref('ContadoresCola')
        }
      },

      TrabajoCola: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'factura-68ae1f2b9c3d4e5f6a7b8c9d' },
          queue: { type: 'string', enum: ['facturacion', 'kude'] },
          estado: { type: 'string', enum: ['waiting', 'active', 'completed', 'failed'] },
          correlativo: { type: 'string', example: '001-001-0000060' },
          ruc: { type: 'string', description: 'RUC del cliente o emisor asociado al trabajo' },
          timestamp: { type: 'number', description: 'Epoch ms del último cambio de estado', example: 1787788748870 },
          error: { type: 'string', nullable: true, description: 'Motivo del fallo, si falló' },
          attempts: { type: 'integer', example: 1 }
        }
      },

      ContribuyenteSet: {
        type: 'object',
        description: 'Resultado de la consulta de RUC, ya interpretado (sin claves SOAP ns2:)',
        properties: {
          ruc: { type: 'string', example: '80055783', description: 'RUC consultado, normalizado sin DV' },
          encontrado: { type: 'boolean', example: true },
          razonSocial: { type: 'string', nullable: true, example: 'KINGSTON CENTER SOCIEDAD ANONIMA' },
          estado: { type: 'string', nullable: true, example: 'ACT', description: 'Código de estado del RUC en SET' },
          estadoDescripcion: { type: 'string', nullable: true, example: 'ACTIVO' },
          facturadorElectronico: { type: 'boolean', description: 'true si SET lo registra como facturador electrónico en ese ambiente' },
          codigoSet: { type: 'string', nullable: true, example: '0502', description: '0502 = RUC encontrado' }
        }
      },

      LimpiezaCola: {
        type: 'object',
        properties: {
          queue: { type: 'string', enum: ['facturacion', 'kude'], default: 'facturacion' },
          keep: { type: 'integer', default: 0, description: 'Cantidad de trabajos recientes a conservar' }
        }
      },

      ResultadoLimpieza: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string', example: 'Se eliminaron 148 jobs completados de la cola facturacion' },
          data: {
            type: 'object',
            properties: {
              removed: { type: 'integer', example: 148, description: 'Trabajos eliminados' },
              queue: { type: 'string', enum: ['facturacion', 'kude'] },
              keep: { type: 'integer', description: 'Solo en clear/clear-completed: cuantos se conservaron' }
            }
          }
        }
      },

      // ------------------------------ estadísticas ------------------------------
      ConteoPorEstado: {
        type: 'object',
        properties: {
          _id: { allOf: [ref('EstadoSifen')], description: 'El estado agrupado' },
          count: { type: 'integer', example: 25 }
        }
      },

      Estadisticas: {
        type: 'object',
        properties: {
          totalFacturas: { type: 'integer', example: 73 },
          facturasPorEstado: { type: 'array', items: ref('ConteoPorEstado') },
          facturasProcesando: { type: 'integer' },
          facturasEnviadas: { type: 'integer' },
          facturasError: { type: 'integer' },
          facturasRechazadas: { type: 'integer' },
          facturasAceptadas: { type: 'integer' },
          facturasHoy: { type: 'integer', example: 3 },
          ultimasFacturas: {
            type: 'array',
            description: 'Últimas 10, con campos resumidos',
            items: {
              type: 'object',
              properties: {
                _id: objectId(),
                correlativo: { type: 'string' },
                cdc: { type: 'string', nullable: true },
                estadoSifen: ref('EstadoSifen'),
                fechaCreacion: fechaHora(),
                total: { type: 'number' }
              }
            }
          },
          tendenciasPorDia: {
            type: 'array',
            description: 'Últimos 7 días',
            items: {
              type: 'object',
              properties: {
                _id: { type: 'string', example: '2026-08-26', description: 'Día (YYYY-MM-DD)' },
                count: { type: 'integer', example: 12 },
                total: { type: 'number', example: 18500000, description: 'Suma de montos del día' }
              }
            }
          },
          fechaUltimaConsulta: fechaHora(),
          uptime: { type: 'number', description: 'Segundos desde el arranque del proceso' },
          memoria: {
            type: 'object',
            description: 'process.memoryUsage() en bytes',
            properties: {
              rss: { type: 'integer' },
              heapTotal: { type: 'integer' },
              heapUsed: { type: 'integer' },
              external: { type: 'integer' }
            },
            additionalProperties: true
          }
        }
      },

      // ------------------------------ empresas ------------------------------
      Empresa: {
        type: 'object',
        description: 'Cuerpo para crear/actualizar una empresa',
        required: ['ruc', 'nombreFantasia', 'razonSocial'],
        properties: {
          ruc: {
            type: 'string',
            description: 'Con o sin guión, entre 6 y 12 dígitos',
            example: '80055783-2'
          },
          nombreFantasia: { type: 'string', example: 'Kingston Center' },
          razonSocial: { type: 'string', example: 'Kingston Center S.A.' },
          direccion: { type: 'string' },
          telefono: { type: 'string' },
          email: { type: 'string', format: 'email' },
          configuracionSifen: {
            type: 'object',
            properties: {
              timbrado: {
                type: 'string',
                maxLength: 8,
                description: 'Número de timbrado otorgado por SET',
                example: '12558946'
              },
              idCSC: { type: 'string', maxLength: 4, default: '0001' },
              csc: {
                type: 'string',
                minLength: 32,
                maxLength: 32,
                description: 'Código de Seguridad del Contribuyente. **Exactamente 32 caracteres**, lo entrega SET.'
              },
              modo: { type: 'string', enum: ['test', 'produccion'], default: 'test' },
              urlLogo: { type: 'string', format: 'uri', description: 'Logo que se imprime en el KUDE' },
              envioFacturas: {
                type: 'string',
                enum: ['normal', 'lotes'],
                default: 'normal',
                description: '`normal` envía cada documento por separado; `lotes` los agrupa'
              },
              validacionReceptor: {
                type: 'string',
                enum: ['estricto', 'advertencia', 'off'],
                default: 'advertencia',
                description: 'Validación del receptor pre-SIFEN en /api/facturar/crear. `estricto`: los errores rechazan con 400 RECEPTOR_INVALIDO (con los códigos SIFEN que habrían rechazado el DTE). `advertencia` (default): normaliza el cliente (DV recalculado, documento limpio, país por defecto) y registra el resultado en la bitácora (validacion_receptor) sin rechazar. `off`: sin validación.'
              },
              timbradoFecha: {
                type: 'string',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                example: '2026-02-11',
                description: 'Fecha de inicio de vigencia del timbrado (dFeIniT). Si falta, se usa la del payload o la fecha de emisión.'
              },
              establecimiento: {
                type: 'string',
                maxLength: 3,
                default: '001',
                description: 'Establecimiento POR DEFECTO para emitir cuando la factura no trae data.establecimiento'
              },
              puntoExpedicion: {
                type: 'string',
                maxLength: 3,
                default: '001',
                description: 'Punto de expedición POR DEFECTO para emitir cuando la factura no trae data.punto. Cada punto lleva numeración correlativa propia.'
              },
              monedasPermitidas: {
                type: 'array',
                items: { type: 'string', pattern: '^[A-Z]{3}$' },
                default: ['PYG', 'USD'],
                description: 'Política contable: monedas en las que la empresa emite. Una factura en otra moneda se rechaza con 400 MONEDA_NO_PERMITIDA (SIFEN admite cualquier ISO 4217, la restricción es de la empresa).'
              }
            }
          },
          notificaciones: {
            type: 'object',
            description: 'Notificaciones al integrador cuando una factura llega a estado final (aceptado/observado/rechazado/error/cancelado; el email del KUDE solo para aceptado/observado).',
            properties: {
              webhookUrl: {
                type: 'string',
                format: 'uri',
                description: 'URL que recibe un POST JSON `{evento: "factura.estado_final", timestamp, factura: {id, correlativo, estado, cdc, codigoRetorno, mensajeRetorno, total, cliente}, links: {pdf, xml}}`. Headers: `X-DTE-Evento` y `X-DTE-Firma` (HMAC-SHA256 hex del body con webhookSecret — verificála para autenticar el origen). 3 intentos (0s/10s/60s, timeout 10s); se considera entregado con cualquier 2xx. Nota: el link del PDF puede tardar unos segundos más que el webhook — si da 404, reintentar a los 5s. String vacío = desactivar. Para probar sin backend propio: apuntarla a /api/utils/webhook-echo.'
              },
              webhookSecret: {
                type: 'string',
                description: 'Secreto con el que se firma el webhook. Si se activa webhookUrl sin secreto, el sistema genera uno (visible en GET /api/empresas).'
              },
              emailAutomatico: {
                type: 'boolean',
                default: false,
                description: 'Al aprobarse la factura, envía automáticamente el KUDE (PDF) + XML al email del cliente (data.cliente.email). Usa el proveedor SMTP seleccionado en smtpProviderId (gestionados desde la UI en /api/smtp-providers); si la empresa no tiene proveedor, cae a las variables de entorno del servidor: SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_FROM y SMTP_SEGURO=true si el puerto es 465.'
              },
              smtpProviderId: {
                type: 'string',
                nullable: true,
                description: 'ID del proveedor SMTP (colección gestionada en la UI, endpoints /api/smtp-providers, solo sesión JWT) con el que se envían los emails de esta empresa. null o vacío = usar el SMTP del entorno del servidor.'
              }
            }
          },
          tipoContribuyente: { type: 'integer', enum: [1, 2], description: '1 = persona física, 2 = persona jurídica. Fallback de param.tipoContribuyente.' },
          tipoRegimen: { type: 'integer', minimum: 1, maximum: 8, description: '1 = Régimen de Turismo, 2 = Importador, 3 = Exportador, 4 = Maquila, 5 = Ley 60/90, 6 = Pequeño Productor, 7 = Mediano Productor, 8 = Régimen Contable. Fallback de param.tipoRegimen.' },
          actividadesEconomicas: {
            type: 'array',
            description: 'Actividades económicas del RUC. Fallback de param.actividadesEconomicas.',
            items: {
              type: 'object',
              required: ['codigo', 'descripcion'],
              properties: {
                codigo: { type: 'string', example: '46520' },
                descripcion: { type: 'string', example: 'COMERCIO AL POR MAYOR DE EQUIPOS ELECTRÓNICOS' }
              }
            }
          },
          establecimientos: {
            type: 'array',
            description: 'Sucursales habilitadas con el timbrado. Fallback de param.establecimientos: con esto cargado, las integraciones pueden emitir mandando solo cliente + items.',
            items: {
              type: 'object',
              required: ['codigo', 'denominacion'],
              properties: {
                codigo: { type: 'string', example: '001' },
                denominacion: { type: 'string', example: 'Casa Matriz' },
                direccion: { type: 'string', example: 'AVDA. ADRIAN JARA Y ABAY' },
                numeroCasa: { type: 'string', example: '1104' },
                departamento: { type: 'integer', example: 11 },
                departamentoDescripcion: { type: 'string', example: 'ALTO PARANA' },
                distrito: { type: 'integer', example: 145 },
                distritoDescripcion: { type: 'string', example: 'CIUDAD DEL ESTE' },
                ciudad: { type: 'integer', example: 3428 },
                ciudadDescripcion: { type: 'string', example: 'CIUDAD DEL ESTE(PLANTA URBANA)' },
                telefono: { type: 'string', example: '061505666' },
                email: { type: 'string', example: 'hello@kingstonimports.com' }
              }
            }
          }
        }
      },

      EmpresaCompleta: {
        allOf: [
          ref('Empresa'),
          {
            type: 'object',
            description: 'Como la devuelve la API (la contraseña del certificado nunca se incluye)',
            properties: {
              _id: objectId(),
              usuarioId: objectId('Dueño de la empresa'),
              activo: { type: 'boolean' },
              certificado: {
                type: 'object',
                nullable: true,
                properties: {
                  nombreArchivo: { type: 'string', example: 'kingston-f1.p12' },
                  fechaVencimiento: fechaHora(),
                  fechaCarga: fechaHora(),
                  activo: { type: 'boolean' }
                }
              },
              certificadoEnFileSystem: {
                type: 'boolean',
                description: 'true si el archivo .p12 existe físicamente en el volumen. Solo presente en listar y obtener; crear/actualizar devuelven el documento sin este campo'
              },
              createdAt: fechaHora(),
              updatedAt: fechaHora()
            }
          }
        ]
      },

      ValidacionCertificado: {
        type: 'object',
        properties: {
          tieneCertificado: { type: 'boolean', description: 'Metadatos completos y vigente' },
          certificadoActivo: { type: 'boolean' },
          certificadoEnFileSystem: { type: 'boolean', description: 'El archivo .p12 existe en el volumen' },
          fechaVencimiento: fechaHora(),
          fechaCarga: fechaHora(),
          nombreArchivo: { type: 'string', nullable: true },
          infoAdicional: {
            type: 'object',
            nullable: true,
            description: 'Detalle del archivo en disco (tamaño, ruta)',
            additionalProperties: true
          }
        }
      },

      EstadisticasEmpresa: {
        type: 'object',
        properties: {
          empresa: {
            type: 'object',
            properties: {
              nombreFantasia: { type: 'string' },
              ruc: { type: 'string' }
            }
          },
          totalFacturas: { type: 'integer' },
          facturasPorEstado: { type: 'array', items: ref('ConteoPorEstado') },
          ultimaFactura: {
            type: 'object',
            nullable: true,
            properties: {
              _id: objectId(),
              fechaCreacion: fechaHora(),
              correlativo: { type: 'string' }
            }
          }
        }
      },

      // ------------------------------ solicitud de factura ------------------------------
      CotizacionAutomatica: {
        type: 'object',
        description: 'Configuración de actualización automática de cotizaciones de una empresa.',
        properties: {
          empresaId: { type: 'string' },
          ruc: { type: 'string' },
          activo: { type: 'boolean', default: false },
          proveedor: { type: 'string', example: 'sistemaaguila' },
          monedas: { type: 'array', items: { type: 'string' }, example: ['USD'] },
          tipoValor: { type: 'string', enum: ['compra', 'venta', 'promedio'], example: 'venta' },
          variacionMaximaPct: { type: 'number', example: 10, description: 'Un salto mayor a este % sobre la vigente no se aplica solo' },
          fechaObjetivo: { type: 'string', format: 'date', example: '2026-08-31', description: 'Fecha de la cotización que rige hoy (la publicada ayer)' },
          ultimaSincronizacion: {
            type: 'object',
            nullable: true,
            properties: {
              en: { type: 'string', format: 'date-time' },
              estado: { type: 'string', enum: ['ok', 'sin_cambios', 'pendiente_fuente', 'bloqueada', 'error'] },
              fechaCotizacion: { type: 'string', format: 'date', nullable: true },
              mensaje: { type: 'string' }
            }
          }
        }
      },

      ResumenSincronizacion: {
        type: 'object',
        description: 'Qué hizo (o por qué no hizo nada) una sincronización.',
        properties: {
          empresaId: { type: 'string' },
          ruc: { type: 'string' },
          estado: { type: 'string', enum: ['ok', 'sin_cambios', 'pendiente_fuente', 'bloqueada', 'error'] },
          mensaje: { type: 'string' },
          fechaCotizacion: { type: 'string', format: 'date', description: 'Fecha publicada por la fuente' },
          monedas: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                moneda: { type: 'string', example: 'USD' },
                estado: { type: 'string', enum: ['aplicada', 'sin_cambios', 'pendiente_fuente', 'bloqueada', 'no_publicada', 'error'] },
                valor: { type: 'number', example: 5912.9 },
                valorAnterior: { type: 'number', nullable: true },
                variacionPct: { type: 'number', description: 'Solo cuando quedó bloqueada' },
                fechaCotizacion: { type: 'string', format: 'date' },
                mensaje: { type: 'string' }
              }
            }
          }
        }
      },

      SolicitudFactura: {
        type: 'object',
        required: ['param', 'data'],
        description: 'Estructura del DTE según el Manual Técnico SIFEN v150. `param` describe al emisor y `data` al documento.',
        properties: {
          param: {
            type: 'object',
            description: 'Datos del emisor y del timbrado. TODO salvo `ruc` es opcional si la empresa tiene cargados sus datos de emisor (establecimientos, actividadesEconomicas, tipoContribuyente, tipoRegimen, timbrado y timbradoFecha en su configuración): lo que falte acá se completa desde la empresa. También data.establecimiento/data.punto caen a los defaults de la empresa, y data.numero a la numeración correlativa automática — una integración mínima manda param.ruc + data.cliente + data.items.',
            properties: {
              version: { type: 'integer', default: 150 },
              ruc: { type: 'string', example: '80069563-1', description: 'RUC del emisor; debe existir como empresa activa del alcance' },
              razonSocial: { type: 'string' },
              nombreFantasia: { type: 'string' },
              timbradoNumero: { type: 'string', example: '12558946' },
              timbradoFecha: { type: 'string', format: 'date', example: '2022-08-25' },
              tipoContribuyente: { type: 'integer', example: 2 },
              tipoRegimen: { type: 'integer', example: 8, description: '1 = Régimen de Turismo, 2 = Importador, 3 = Exportador, 4 = Maquila, 5 = Ley 60/90, 6 = Pequeño Productor, 7 = Mediano Productor, 8 = Régimen Contable' },
              actividadesEconomicas: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    codigo: { type: 'string' },
                    descripcion: { type: 'string' }
                  }
                }
              },
              establecimientos: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    codigo: { type: 'string', example: '001' },
                    direccion: { type: 'string' },
                    numeroCasa: { type: 'string' },
                    departamento: { type: 'integer' },
                    departamentoDescripcion: { type: 'string' },
                    distrito: { type: 'integer' },
                    distritoDescripcion: { type: 'string' },
                    ciudad: { type: 'integer' },
                    ciudadDescripcion: { type: 'string' },
                    telefono: { type: 'string' },
                    email: { type: 'string', format: 'email' }
                  }
                }
              }
            }
          },
          data: {
            type: 'object',
            description: 'Datos del documento a emitir',
            properties: {
              tipoDocumento: { type: 'integer', example: 1, description: '1 = Factura electrónica' },
              establecimiento: { type: 'string', example: '001' },
              punto: { type: 'string', example: '001' },
              numero: { type: 'string', example: '0000060', description: 'Número del documento (7 dígitos). OPCIONAL: si se omite, el sistema asigna automáticamente el siguiente número correlativo de la secuencia timbrado + tipo de documento + establecimiento + punto (recomendado). Si se envía, se usa tal cual (para integraciones que manejan su propia numeración).' },
              fecha: { type: 'string', format: 'date-time' },
              tipoEmision: { type: 'integer', example: 1 },
              tipoTransaccion: { type: 'integer', example: 1 },
              tipoImpuesto: { type: 'integer', example: 1 },
              moneda: { type: 'string', example: 'PYG', description: 'PYG (por defecto) o una de las monedas habilitadas de la empresa (configuracionSifen.monedasPermitidas, default PYG y USD) — otra moneda se rechaza con 400 MONEDA_NO_PERMITIDA. Si no es PYG, condicionTipoCambio es obligatorio y cambio se toma del payload o de la cotización declarada vigente' },
              condicionAnticipo: { type: 'integer' },
              condicionTipoCambio: { type: 'integer', description: '1 = cotización global de la operación (con data.cambio), 2 = cotización por item (cambio en cada item)' },
              cambio: { type: 'number', example: 7300, description: 'Guaraníes por unidad de la moneda (obligatorio si moneda != PYG y condicionTipoCambio = 1)' },
              descuentoGlobal: { type: 'number' },
              observacion: {
                type: 'string',
                description: 'Información de interés del emisor (dInfoEmi): aparece en el KUDE. Usarla para la leyenda del Régimen de Turismo ("Régimen de Turismo de Compras - Decreto N° 2063/2024") y el país de residencia real del cliente extranjero (el campo cliente.pais es PRY en toda operación que no sea B2F, regla 1320).'
              },
              cliente: {
                type: 'object',
                properties: {
                  contribuyente: { type: 'boolean' },
                  ruc: { type: 'string' },
                  razonSocial: { type: 'string' },
                  nombreFantasia: { type: 'string' },
                  tipoOperacion: { type: 'integer', description: '1 = B2B, 2 = B2C, 3 = B2G, 4 = B2F (SOLO exportación de servicios al exterior; un turista que compra bienes es B2C con pasaporte/cédula extranjera y pais PRY — regla SIFEN 1320)' },
                  direccion: { type: 'string' },
                  numeroCasa: { type: 'string' },
                  departamento: { type: 'integer' },
                  distrito: { type: 'integer' },
                  ciudad: { type: 'integer' },
                  pais: { type: 'string', example: 'PRY' },
                  tipoContribuyente: { type: 'integer' },
                  documentoTipo: { type: 'integer', description: 'Obligatorio si contribuyente=false: 1 = cédula paraguaya, 2 = pasaporte, 3 = cédula extranjera, 4 = carnet de residencia, 5 = innominado (solo B2C y total < 7.000.000 Gs — Decreto 872/2023), 6 = tarjeta diplomática, 9 = otro (exige documentoTipoDescripcion). No informar si contribuyente=true.' },
                  documentoNumero: { type: 'string', description: 'Sin puntos, barras ni espacios (se normaliza). Pasaporte: A-Z0-9, 5 a 15. Innominado: "0".' },
                  documentoTipoDescripcion: { type: 'string', description: 'Obligatorio con documentoTipo 9 (ej: "CNPJ", "Tax ID")' },
                  telefono: { type: 'string' },
                  celular: { type: 'string' },
                  email: { type: 'string', format: 'email' }
                }
              },
              condicion: {
                type: 'object',
                description: 'Forma de pago (contado o crédito)',
                properties: {
                  tipo: { type: 'integer', example: 1, description: '1 = contado, 2 = crédito' },
                  entregas: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        tipo: { type: 'integer', description: '1 = efectivo, 3 = tarjeta de crédito (exige infoTarjeta), etc.' },
                        monto: { type: 'string', description: 'En la moneda de la entrega' },
                        moneda: { type: 'string' },
                        monedaDescripcion: { type: 'string', example: 'US Dollar' },
                        cambio: { type: 'number', description: 'Guaraníes por unidad (obligatorio si la moneda de la entrega no es PYG)' }
                      }
                    }
                  }
                }
              },
              items: {
                type: 'array',
                description: 'Ítems del documento',
                items: {
                  type: 'object',
                  properties: {
                    codigo: { type: 'string' },
                    descripcion: { type: 'string' },
                    unidadMedida: { type: 'integer', example: 77 },
                    cantidad: { type: 'number' },
                    precioUnitario: { type: 'number', description: 'En la moneda de la operación (data.moneda)' },
                    cambio: { type: 'number', description: 'Cotización por item, solo con condicionTipoCambio = 2' },
                    ivaTipo: { type: 'integer', example: 1, description: '1 = gravado, 2 = exonerado, 3 = exento, 4 = gravado parcial' },
                    ivaBase: { type: 'number', example: 100, description: '% del precio que está gravado (100 normal; 0 obligatorio con ivaTipo 2 o 3)' },
                    iva: { type: 'integer', example: 10, description: 'Tasa: 10, 5 o 0 (0 obligatorio con ivaTipo 2 o 3)' }
                  }
                }
              },
              templateFactura: {
                type: 'string',
                enum: ['normal', 'ticket'],
                default: 'normal',
                description: 'Plantilla del KUDE: `ticket` usa el formato angosto'
              }
            }
          }
        }
      }
    }
  }
};
