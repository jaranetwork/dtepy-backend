# Facturación a extranjeros y exento de IVA — resumen directo

Actualizado: 2026-09-01. Verificado contra Manual Técnico SIFEN v150 + Notas Técnicas 1–27 (DNIT) y normativa RTC vigente.

## Estado de la empresa

**KINGSTON CENTER S.A. (RUC 80055783-2) ESTÁ INSCRIPTA en el Régimen de Turismo** — verificado en el listado oficial DNIT actualizado al 06/08/2026, fila 257, página 5: "80055783 KINGSTON CENTER SOCIEDAD ANONIMA MEDIANO CIUDAD DEL ESTE".
Fuente: https://www.dnit.gov.py/web/portal-institucional/contribuyentes-inscriptos-en-el-r%C3%A9gimen-de-turismo (PDF: "Listado Regimen de Turismo para la WEB 06-08-2026").
Consecuencia: **los 3 requisitos de plaza se cumplen** (inscripta + Ciudad del Este habilitada + rubro informática/electrónica en el anexo) -> se puede facturar EXENTO a turistas extranjeros no residentes por bienes del anexo. Recordar: la inscripción vence (vigencia 2 años, RG 26/2025) — **verificar renovación antes del vencimiento** y que la mercadería vendida exenta sea de origen RTC (importada bajo el régimen o comprada a importador RTC — confirmar con el contador).

## SE PUEDE (exento de IVA)

1. **RTC — Régimen de Turismo de Compras**: vender bienes del anexo (485 códigos NCM: electrónica, informática, etc. — lista completa en [04-anexo-rtc.md](04-anexo-rtc.md) y [anexo-rtc-ncm.csv](anexo-rtc-ncm.csv)) a un turista extranjero, **exento de IVA**.
   Necesario: empresa **inscripta en el Registro RTC** de la DNIT (RG 26/2025, vigencia 2 años) + local en ciudad habilitada (Asunción, CDE, Encarnación, PJC, Pilar, Salto del Guairá) + comprador **persona física extranjera sin nacionalidad paraguaya, sin domicilio ni residencia en PY** + factura **siempre nominada** con pasaporte o cédula extranjera y país de residencia.
   → Detalle: [01-exento-iva-extranjeros.md](01-exento-iva-extranjeros.md)

2. **B2F — exportación de servicios**: facturar un servicio a persona/empresa del exterior, sin IVA.
   Necesario: `tipoOperacion 4`, país real del cliente (≠ PRY), dirección del exterior + número de casa, nunca innominada.

3. **Exportación de bienes** con despacho aduanero (circuito aparte, no aplica al e-commerce local).

## NO SE PUEDE

1. **Eximir IVA a un extranjero solo por ser extranjero.** Si compra bienes o servicios que se consumen en Paraguay y no es una venta RTC, paga **IVA 10% igual que un paraguayo**. La factura sale B2C nominada con su pasaporte, gravada normal.
   ✓ Resuelto (01/09/2026): el checkout factura según residencia/RTC con el motor fiscal de `next-compras-aqui/lib/fiscal` — ver [05-emision-tienda.md](05-emision-tienda.md).
2. **"Tax free" (devolución de IVA al turista): no existe en Paraguay.** No hay esquema de devolución en frontera/aeropuerto. Solo existe RTC (exención en origen).
3. **Usar B2F para venta de bienes a un turista** → SIFEN rechaza (regla 1320: B2F exige país ≠ PRY; venta local exige país = PRY).
4. **Vender bajo RTC a un residente en Paraguay** → reliquidación del IVA + sanciones DNIT.
5. **Factura innominada ≥ 7.000.000 ₲** (vigente desde 01/01/2025) — ni en B2B/B2G/B2F a ningún monto.
6. **NC/ND sobre una factura innominada** sin antes registrar el evento de nominación.

## FACTURAR NORMAL (gravado)

| Cliente | naturaleza | operación | documento | IVA |
|---|---|---|---|---|
| Empresa/persona con RUC | contribuyente | 1 B2B | RUC + DV | 10% |
| Ente estatal | contribuyente | 3 B2G | RUC + DV | 10% |
| Paraguayo sin RUC | no contribuyente | 2 B2C | 1 = CI | 10% |
| Extranjero residente | no contribuyente | 2 B2C | 4 = carnet residencia | 10% |
| Extranjero no residente (fuera de RTC) | no contribuyente | 2 B2C | 2 = pasaporte / 3 = cédula extranjera | **10%** |
| Turista RTC (empresa inscripta + bien del anexo) | no contribuyente | 2 B2C | 2 pasaporte / 3 cédula ext. | **exento** |
| Servicio al exterior | no contribuyente | 4 B2F | 2 pasaporte / 9 tax ID | **no gravado** |
| Sin identificar (< 7M ₲, solo B2C) | no contribuyente | 2 B2C | 5 innominado ("0" / "Sin Nombre") | 10% |

En **todos** los casos B2C/B2B locales el país del receptor en el XML es `PRY` (regla 1320), aunque el cliente sea extranjero. El país real va en `observacion`.

## Archivos

- [01-exento-iva-extranjeros.md](01-exento-iva-extranjeros.md) — RTC y B2F al detalle, con fuentes.
- [02-reglas-receptor-sifen.md](02-reglas-receptor-sifen.md) — todas las reglas del receptor con códigos de rechazo SIFEN.
- [03-payloads-dte-api.md](03-payloads-dte-api.md) — payloads listos para `POST /api/facturar/crear` por caso.
- [04-anexo-rtc.md](04-anexo-rtc.md) — qué productos entran y cuáles no, con el CSV de los 485 códigos NCM ([anexo-rtc-ncm.csv](anexo-rtc-ncm.csv)).
- [05-emision-tienda.md](05-emision-tienda.md) — decisiones de la emisión desde comprasaqui.com: código de cliente, dirección/catalogo geográfico, recargo distribuido, cancelación 48 h, bitácora.
