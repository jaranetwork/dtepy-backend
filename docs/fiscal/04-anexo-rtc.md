# Anexo RTC: qué productos entran y cuáles no

Fuente primaria: **Anexo del Decreto 2063/2024** (texto oficial DNIT, 485 códigos NCM de 10 dígitos, transcriptos completos en [anexo-rtc-ncm.csv](anexo-rtc-ncm.csv)). Verificado contra el **Decreto 3237/2025** (leído página por página): **NO modifica la lista de bienes** — solo cambia requisitos del importador (art. 4: antigüedad 2 años o garantía US$ 25.000, capital mínimo 300 millones ₲ en vez de 6.000 millones, movimientos bancarios mínimos), agrega topes mensuales de importación CIF por tamaño y reglas de suspensión. **La lista vigente es la del 2063: 485 códigos, sin cambios.**

## Regla de oro

La elegibilidad es **por código NCM de 10 dígitos, no por nombre de producto**. En el catálogo `rtc_eligible` arranca en **true** (decisión de negocio: el catálogo es esencialmente electrónica del anexo) — lo que hay que hacer es **apagar el switch "Turismo (RTC)" en las excepciones** (aires 8415, scooters eléctricos 8711, heladeras, drones, ropa/calzado revendidos…), desde la ficha del producto o con la edición masiva del dashboard. Ante la duda, confirmar la partida arancelaria con el despacho de importación (ahí figura el NCM exacto). Un producto que no está en el anexo **se vende igual a extranjeros, pero con IVA 10%** (B2C común). B2F no tiene nada que ver con esto: es solo exportación de servicios.

## Qué SÍ entra (lo relevante para Kingston)

Prácticamente todo el rubro informática/electrónica de consumo:

- **Celulares y smartphones** (8517.13/8517.14) · routers, módems, APs (8517.62) · teléfonos fijos e inalámbricos
- **Computación completa** (8471): notebooks, desktops, tablets, all-in-one, teclados, mouse, discos/SSD externos, lectoras · partes y placas (8473) · monitores y proyectores (8528.52/62) · impresoras y multifunción con tintas/tóneres (8443)
- **Smart TVs y TV boxes** (8528.72/71) · antenas y controles (8529)
- **Audio**: parlantes, auriculares, micrófonos, amplificadores (8518) · parlantes portátiles/radiograbadores (8519.81) · radios (8527)
- **Gaming**: consolas y videojuegos (9504.50) · juguetes en general incl. radio control (9503) · juegos de mesa (9504.90)
- **Cámaras digitales, webcams y videocámaras** (8525.50/60/89) · objetivos (9002) · flashes (9006.61)
- **Relojes**: pulsera y smartwatch-adyacentes (9102), despertadores/pared (9105)
- **Energía**: cargadores/UPS/transformadores (8504.31/40 — subpartidas puntuales), pilas (8506), powerbanks/baterías litio (8507.60/80), paneles solares (8541.43), focos LED (8539)
- **Electrodomésticos chicos**: aspiradoras (8508), licuadoras/batidoras (8509), afeitadoras (8510), pavas/planchas/secadores/microondas/hornos eléctricos (8516), lavarropas automáticos ≤10 kg (8450.11), máquinas de coser (8452), dispensers de agua (8418.69.31), ventiladores (8414.51)
- **Herramientas**: eléctricas de mano (8467) y manuales (8203–8215)
- **Perfumería y cosmética** (3303–3307), **bebidas** (vinos 2204, destilados y licores 2208), **chocolates y golosinas** (1704/1806), **valijas y mochilas** (4202), **anteojos de sol** (9004.10), **bisutería** (7117), **termos** (9617), **instrumentos musicales eléctricos** (9207), deportes/fitness (9506), pesca (9507), muebles básicos (9401/9403), iluminación (9405)

## Qué NO entra (gravado 10% siempre, aun vendiendo a turista)

Ausencias notables del anexo, por rubro:

| Rubro | NO entra (capítulo/partida ausente) |
|---|---|
| Climatización | **Aires acondicionados** (8415) — muy vendido en CDE y NO está |
| Línea blanca | **Heladeras, freezers, exhibidoras** (8418.10/21/29/30/40 — del 8418 solo está la subpartida 8418.69.31) · **secadoras de ropa** (8451) · lavarropas > 10 kg o no automáticos (8450.12/19/20) · lavavajillas (8422.11) |
| Movilidad | **Drones** (8806) · **motos y scooters eléctricos** (8711) · **bicicletas** (8712, solo partes 8714) · monopatines eléctricos (8711.60) · neumáticos y autopartes (4011, 8708) |
| Joyería y lujo | **Joyas de oro/plata y relojes con metal precioso** (7113/7114/9101) — solo entra **bisutería** (7117) y relojes 9102 |
| Óptica/foto | **Binoculares y telescopios** (9005) · cámaras analógicas (9006 salvo flashes) |
| Bebidas/tabaco | **Cerveza** (2203) · **cigarrillos y tabaco** (capítulo 24, ausente completo) · gaseosas y aguas (2201/2202) |
| Música | Instrumentos **acústicos** (9201 pianos, 9202 guitarras/cuerdas) — solo eléctricos (9207) |
| Electrónica puntual | Cigarrillos electrónicos/vapes (8543.40) · walkie-talkies (8525.60 está pero verificar subpartida) · **fuentes de PC y adaptadores fuera de las subpartidas 8504.31/40 listadas** — confirmar NCM exacto |
| Varios | Colchones (9404) · vajilla de acero inox fuera de 7323 · perfumes de ambiente/aerosoles no cosméticos (3808...) · alimentos en general fuera de los puntuales listados |

## Ropa y calzado: entran CON condición especial (art. 23)

Los capítulos **61, 62 (ropa) y 64 (calzado, 6404 zapatillas)** están en el anexo, **pero** el art. 23 del Decreto 2063 los limita: solo aplica el RTC cuando **el importador inscripto los vende de manera directa al turista**, con inventario inicial declarado ante la DNIT y detalle **trimestral** de ventas. Un comerciante que compró esa mercadería a un importador RTC **no puede** venderla exenta. Para Kingston: si no importan ropa/calzado directamente, esos ítems van con IVA 10% — no marcar `rtc_eligible`.

## Reglas de venta que acompañan la lista (Decreto 2063)

- **Art. 8**: el IVA de importación (base 12,5% × 10%) es **pago único y definitivo** cuando se vende a turistas o a otros Contribuyentes RTC; si se vende a locales, pasa a ser crédito fiscal.
- **Art. 9**: venta a personas domiciliadas en Paraguay → **IVA régimen general** (10% base completa).
- **Art. 10**: la venta al turista va respaldada por comprobante con **nombre y apellido del turista y su país de residencia**, y las operaciones (incluidas ventas entre Contribuyentes RTC) se consignan en la casilla de **"exentas"** del comprobante. → Exactamente lo que emite el sistema: ítems `ivaTipo 3` + país de residencia en la observación del DTE.
- **Art. 2**: la cadena exenta es importador RTC → turista **o** importador RTC → comerciante RTC → turista.

## Fuentes

- Decreto 2063/2024 con anexo completo (texto oficial DNIT): https://www.dnit.gov.py/documents/20123/559197/DECRETO2063.pdf/75e706c1-279a-b8b9-74f2-dc4e93a9f1fd
- Decreto 3237/2025 (modifica requisitos, NO la lista): https://www.dnit.gov.py/documents/20123/559197/DECRETO+N%C2%B0+3237+-+2025+-+SE+MODIFICA+Y+AMPLIA+DECRETO+2063_2024+SOBRE+EL+REGIMEN+DE+TURISMO+DE+COMPRAS+-+RTC.pdf/1e337b9a-6e74-5fc1-44ab-e29f8ffdbfcf
- Normativas del Régimen de Turismo (índice DNIT): https://www.dnit.gov.py/en/web/portal-institucional/normativas1
- CSV con los 485 códigos: [anexo-rtc-ncm.csv](anexo-rtc-ncm.csv) (extraído del anexo oficial; descripciones a nivel de partida — la clasificación fina la confirma el despachante)
