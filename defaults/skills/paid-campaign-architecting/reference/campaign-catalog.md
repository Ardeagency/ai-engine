# Catalogo de pauta — tipos, objetivos, formulas, comunicacion

Referencia de paid-campaign-architecting. Doctrina profesional (confianza = investigado,
no medido en cuenta). Los nombres de objetivos cambian con el tiempo: si dudas de si un tipo
sigue vigente, dilo y verificalo contra la cuenta real o doc oficial. Sin tildes. Pesos COP.

---

## 1. Meta (Facebook / Instagram) — sistema ODAX

Meta = demanda generada: interrumpes a alguien que no estaba buscando. El algoritmo (era
Andromeda) LEE el creativo y el copy para decidir a quien mostrar; por eso la alineacion
objetivo+audiencia+copy importa mas que la microsegmentacion.

| Objetivo (ODAX) | Para que | Etapa | Optimizacion del evento |
|---|---|---|---|
| Reconocimiento | maximo alcance al menor CPM | awareness | alcance / impresiones / ThruPlay |
| Trafico | llevar clics a un destino | consideracion | clics en enlace / vistas de LP |
| Interaccion | likes/seguidores/mensajes/vistas | awareness-consideracion | la interaccion elegida (perfil, msg) |
| Clientes potenciales (Leads) | capturar leads | prospeccion | formulario instantaneo / lead en sitio |
| Promocion de la app | instalaciones / eventos in-app | — | instalacion / evento |
| Ventas | conversion con pixel | conversion | compra / lead / add-to-cart |

**Familias Advantage+:** `Advantage+ Shopping` (ventas e-commerce, automatizado), `Advantage+
audience` (broad guiado por senales — deja que el algoritmo lea el creativo en vez de cerrar
intereses). Usa Advantage+ cuando el creativo carga bien la intencion; usa intereses+
comportamientos (flexible_spec) cuando necesitas pre-calificar un publico angosto.

**Ubicacion de la conversion (critico, se bloquea tras publicar):**
- Interaccion -> Perfil de Instagram / Pagina / "en tus anuncios" (NUNCA sitio web).
- Leads -> formulario instantaneo o sitio web con pixel.
- Ventas -> sitio web + evento de compra del pixel.
Fijala correcta ANTES de publicar; para corregir una ya publicada, DUPLICA el conjunto (la copia
nace sin publicar y deja cambiarla).

**CBO vs ABO:** CBO (presupuesto a nivel campana) deja que Meta mueva la plata al mejor conjunto —
bueno para escalar, pero concentra ~90-95% en un anuncio (ojo al diagnosticar). ABO (presupuesto
por conjunto) da control para probar audiencias con plata pareja — bueno para aprender.

---

## 2. Google Ads — sistema por intencion

Google = demanda existente: alguien ya busca. Search es intencion pura; lo demas escala alcance.

| Tipo | Para que | Etapa | Nota |
|---|---|---|---|
| Search | captura intencion de busqueda | conversion/consideracion | keyword del grupo en >=3 titulos RSA |
| Performance Max | full-funnel automatizado en toda la red | todo el embudo | exige feed/creativos buenos; caja negra |
| Demand Gen | crear demanda en Discover/YouTube/Gmail | awareness-consideracion | lo mas parecido a social |
| Display | alcance barato y retargeting | awareness/RT | CPM bajo, intencion baja |
| Video (YouTube) | awareness y consideracion | awareness | skippable/bumper segun meta |
| Shopping | productos con feed | conversion e-commerce | depende de Merchant Center |

**Regla de oro Google:** primero Search de intencion alta (marca + "comprar/mejor/precio X") porque
ahi la plata convierte; PMax solo cuando hay creativos y feed que alimentar, si no es una caja negra
que gasta sin control. Demand Gen para crear demanda cuando Meta no basta.

**Puja (progresion sana):** arranca manual o cost-cap -> acumula 50+ conversiones -> pasa a puja
automatica con objetivo (tCPA/tROAS) basada en el historico real. Puja automatica sin data convierte
a la plataforma en quien decide a ciegas.

---

## 3. Meta vs Google — cuando cada uno

| | Meta | Google |
|---|---|---|
| Demanda | la generas (interrumpes) | la capturas (ya buscan) |
| Senal | intereses/comportamiento/creativo | la palabra que escriben |
| Brilla en | descubrimiento, ticket emocional, B2C visual | intencion alta, ticket considerado, B2B/servicios |
| Ancla | en el copy y el visual (lo lee la IA) | la keyword en el RSA |

Ticket alto / compra considerada -> Google pega fuerte en alta intencion + Meta para crear demanda y
nutrir. Ticket bajo / impulso -> Meta, volumen y urgencia.

---

## 4. Formulas de creacion del anuncio (el copy lo escribo yo)

Estructuras que el algoritmo y el humano leen bien. La eleccion depende de la etapa:

- **PAS (Problema - Agitacion - Solucion):** problema -> agitas el dolor -> tu solucion -> CTA.
  Fuerte en prospeccion/conversion (dolor concreto).
- **BAB (Antes - Despues - Puente):** estado actual doloroso -> futuro deseado -> tu producto como
  puente. Fuerte en consideracion.
- **Prueba social primero:** dato/testimonio impactante -> que haces -> CTA. Fuerte en retargeting
  (ya te conocen, baja la friccion con prueba).
- **Por formato:** post estatico = hook en la 1ra linea del caption + ancla en el titulo de la pieza;
  carrusel = 1 caption + cada tarjeta titulo corto+descripcion con cadencia pareja y narrativa
  secuencial; reel = hook en los primeros 3s (decide ~80% del resultado); RSA = keyword del grupo en
  >=3 de los 15 titulos.

---

## 5. Comunicacion estrategica por etapa del embudo

El mismo producto cambia de tono segun donde esta el publico. El error caro es pedir lead en
awareness o ser frio en retargeting.

| Etapa | Tono | Ancla | CTA |
|---|---|---|---|
| Reconocimiento/Interaccion | emocional, sensorial | SUAVE (categoria+geo+estilo) | seguir/guardar/comentar — NUNCA lead |
| Prospeccion | valor + diferenciador | DURA (intencion de compra) | conocer / registrarse |
| Retargeting | "ya nos conoces" + urgencia amable + prueba | media/dura | a lead |
| Conversion | CTA directo, friccion minima | dura | comprar / cotizar + pregunta que filtra calidad |

Regla transversal: cada texto editable lleva >=1 ancla de intencion (no stuffing, es alineacion); el
algoritmo tambien lee el texto incrustado en la imagen (OCR). Cero claims falsos (en preventa, nada
de "avance de obra"; la solidez se construye con respaldo/fiducia/mejor precio, no con datos
inventados).

---

## 6. Presupuesto — jerarquia por objetivo (no porcentaje fijo)

El presupuesto se reparte por **prioridad del objetivo modulada por contexto**, no por % de
plantilla ni por "cuanto no gastar" (la reserva es techo, no criterio).

1. **Que vende y a que precio** (ticket/consideracion) -> define canal y forma.
2. **Madurez** -> invierte el orden: maduro = Reconocimiento > Retargeting > Conversion; inmaduro =
   prospeccion/conversion primero para aprender quien convierte.
3. **Costo por subasta** -> dimensiona cada capa con su costo medido (CPM para alcance, CPL/CPA para
   conversion). Brecha tipica alcance vs conversion ~2x+.
4. **Temporada viva sin aprovechar** -> proponla (baja CPL, sube ROI), aunque sea en un solo anuncio.
5. **Reserva** al final como limite, no como criterio.
6. Si una capa no puede absorber su presupuesto hoy (pozo vacio, ej. RT sin trafico), fasea y
   vuelca a la capa de arriba mientras se llena.

Mismo procedimiento para Meta y Google. Las cifras de reparto salen de costos REALES si existen; si
no hay historico (canal nuevo), se dice "supuesto de partida", no proyeccion sobre datos.

---

## 7. Optimizacion de una campana viva (resumen; el diagnostico fino es de live-social-metrics)

- **CPA alto:** revisa post-clic (landing/form) primero -> ajusta audiencia -> nuevo angulo de
  creativo -> relevancia/calidad -> puja.
- **CTR bajo:** creativo no resuena (nuevo hook) o audiencia equivocada o fatiga.
- **CPM alto:** audiencia muy angosta (ampliar) o competencia alta o baja relevancia del creativo.
- **Saturacion vs fatiga:** no se adivina; se lee el discriminador CPM/CTR/frecuencia AISLANDO el
  anuncio que carga el gasto. Ese diagnostico vive en live-social-metrics.
- **Ventanas de retargeting:** caliente (carrito/trial) 1-7d, tibio (paginas clave) 7-30d, frio
  (cualquier visita) 30-90d, con frecuencia decreciente.
- **Una variable a la vez, 7 dias para estabilizar.** Tocar audiencia+creativo+puja el mismo dia
  resetea el aprendizaje y pierdes la lectura.
