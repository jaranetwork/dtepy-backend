# Emisión desde la tienda (comprasaqui.com) — decisiones y operativa

Actualizado: 2026-09-01. Documenta lo implementado en `next-compras-aqui`
(dominio `lib/domains/invoicing` + `lib/fiscal`) contra esta API DTE.

## Cuándo se emite

Al **confirmarse el pago completo** de la orden (hook post-pago), así el KUDE
viaja impreso con el paquete AEX. La emisión es idempotente (claim
compare-and-set sobre `dte_status`: solo un emisor gana; nunca puede salir
doble factura) y jamás emite sobre una orden no fondeada del todo.

## Qué viaja en `cliente` (y por qué)

| Campo | Valor | Motivo |
|---|---|---|
| `codigo` | **nº de orden** (p. ej. `10123`) | dCodCliente (campo D211 del MT, opcional, 3-15 chars): identificador interno que el emisor le asigna al cliente. Usamos el nº de orden para cruzar el papel con el sistema de un vistazo: KUDE en mano → orden en el dashboard. No es dato fiscal, SIFEN no lo valida contra nada. ⚠️ xmlgen lo lee de **`cliente.codigo`** — con el nombre `codigoCliente` lo ignora en silencio y el KUDE imprime "Código Cliente" vacío (bug nuestro hasta el 01/09/2026; las facturas ≤ 001-002-0000010 salieron sin él). |
| `telefono` | dígitos del celular (6-15) | dTelRec: sin esto el KUDE imprime Teléfono vacío. |
| `direccion` + `numeroCasa` + `ciudad` | dirección de entrega + **ciudad mapeada al catálogo SIFEN** | Ver sección siguiente. `numeroCasa` solo dígitos (xmlgen lo exige numérico); sin dígitos va `0`. |
| `email` | email del cliente | Para el envío automático del KUDE por la API. |

## Dirección en el KUDE: mapeo ciudad AEX → catálogo SIFEN

**Problema**: xmlgen exige `ciudad` (código del catálogo geográfico SIFEN)
cuando viaja `direccion` con operación ≠ B2F — regla vieja que la NT 3 sacó
de SIFEN pero que la librería (pinned 1.0.283) sigue aplicando. Las órdenes
solo guardan el código de ciudad del courier (AEX), que no es el de SIFEN.
Mandar dirección sin ciudad SIFEN = rechazo "Obligatorio especificar la
Ciudad…" (visto en la 001-002-0000008).

**Solución** (`lib/fiscal/sifen-geo.ts`): la ciudad se resuelve **por nombre
normalizado** (acentos, paréntesis, abreviaturas Pte./Gral./Col., mojibake de
datos viejos) contra el catálogo extraído de **la misma xmlgen que valida
acá** (6766 ciudades / 272 distritos / 18 departamentos), con el departamento
como desambiguador y preferencia por la cabecera del distrito. xmlgen deriva
distrito y departamento a partir de la ciudad — solo se manda `ciudad`.

**Regla de oro: null antes que adivinar.** Si el nombre no matchea de forma
inequívoca, la factura sale **sin dirección** (fiscalmente válida igual) y la
bitácora `payload-built` registra `direccion.enviada: false` con el motivo.
Una dirección ausente es cosmética; una ciudad equivocada es un dato falso
ante SIFEN. El **departamento es restricción dura**: ningún fallback puede
devolver una ciudad de otro departamento.

**Cobertura verificada (01/09/2026)**: las **180 ciudades reales** del API
AEX corridas contra el resolver → **176 resueltas (97,8 %), 0 errores de
departamento**. Las 4 sin match (Nueva Fortuna, Santa Rosa del Mbutuy,
Edelira 28, San Rafael del Paraná) no existen en el catálogo SIFEN
(verificado una a una): esas facturas salen sin dirección. El resolver
maneja typos de ambos lados ("Itagua"→ITAUGUA, "ARGTIGAS" del catálogo),
grafía guaraní QU↔K ("Itakyry"→ITAQUYRY), iniciales del catálogo
("Higinio Morinigo"→GRAL. H. MORINIGO), sufijos AEX ("San Ignacio
Misiones", "Bella Vista Norte"), cabeceras de distrito ("San José de los
Arroyos"→SAN JOSE (MUNICIPIO)) y 4 aliases curados (Santaní→SAN
ESTANISLAO, Nueva Londres→HUGO STROESSNER, Gral. Resquín→ISIDORO RESQUIN,
Tomás Romero Pereira→MARIA AUXILIADORA).

**Mantenimiento**: si este backend actualiza `facturacionelectronicapy-xmlgen`,
regenerar el catálogo de la tienda:
`node scripts/gen-sifen-geo.mjs <ruta a node_modules/facturacionelectronicapy-xmlgen>`.

## Cancelación y re-emisión (panel del pedido)

- **Cancelar factura**: evento `cancelacion` vía `POST /api/eventos/enviar`
  con motivo obligatorio (queda en el evento y en la auditoría
  `order.invoice.cancel`). **Ventana legal: 48 h desde la emisión** — la
  valida este backend; el panel esconde el botón pasado el plazo.
- Pasadas las 48 h, una devolución/corrección se documenta con **nota de
  crédito** (pendiente de implementar en la tienda).
- Una factura cancelada habilita **"Emitir nueva factura"**: se limpian las
  referencias y sale con **número nuevo** (el correlativo nunca se reusa).
- El número de una factura cancelada o huérfana queda consumido → si queda
  sin usar de forma definitiva, corresponde el evento de **inutilización**
  del rango (pendiente: la 001-002-0000006 quedó huérfana de una prueba,
  nunca firmada).

## Otras decisiones grabadas en el payload

- `factura.presencia = 2` (operación electrónica, catálogo E010) —
  obligatorio para tipoDocumento 1 según xmlgen.
- Precios de la tienda son **sin IVA** → las líneas gravadas van ×1.1
  (SIFEN espera precios IVA incluido); exentas RTC van con `ivaTipo 3`.
- **Recargo del gateway de pago: sin línea propia.** La tasa del medio de
  pago se **distribuye proporcionalmente en el precio de los productos**,
  escalando al total efectivamente cobrado — cada línea refleja lo pagado
  por ella y la suma cierra exacta. El **envío queda fuera del reparto**:
  figura como línea propia con su monto exacto solo cuando la orden lo
  cobra (envío gratis = sin línea), y el ajuste de redondeo tampoco lo
  toca. La observación lo declara ("Precios de los productos incluyen
  recargo del medio de pago…"). Una comisión negativa (descuento por medio
  de pago) sí va como `descuentoGlobal` (SIFEN no acepta líneas negativas).
- Leyenda en `observacion`: país real del turista + declaración de no
  residencia (RTC B2C) o "Venta entre Contribuyentes RTC, exenta de IVA
  (Art. 10)" (B2B entre inscriptos).
- Formas de pago: cash→1, tarjeta→3 (+`infoTarjeta` tipo 99 "Tarjeta
  online"), transferencia→5, PIX→21.
- Fechas en hora **Asunción** (UTC-3 fijo, sin DST desde 2024).

## Registro RTC (1015 RUC)

`lib/fiscal/rtc-registry.ts` transcribe el listado oficial DNIT del
06/08/2026. **Regenerarlo cuando DNIT republique el PDF** (y recordar que la
inscripción propia vence a los 2 años — RG 26/2025).

## Dónde mirar cuando algo falla

Bitácora de la tienda (logs del dashboard, categoría facturación): cada
etapa deja registro — `skipped-unfunded` (con desglose de pagos),
`payload-built` (ítems, receptor, régimen, dirección enviada o motivo),
`emitted`, `emit-failed` (HTTP status + respuesta de esta API),
`blocked` (datos del receptor faltantes), `sifen-aceptado/rechazado`
(CDC + mensaje), `cancel-requested/cancelled-ok/cancel-failed`.
