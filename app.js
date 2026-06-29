let map;
let realBinsLayer;
let userLayer;
let puntosCriticosLayer;
let heatLayer;
let clustersLayer;
let distritoZonasLayer;
let layersControl;

/* ===== Módulo de Rutas ===== */
let rutaLayer = null;          // línea recta (azul)
let rutaOptLayer = null;       // ruta OSRM (roja)
let rutaMarkersLayer = null;   // marcadores origen/destino de la ruta activa

/* ===== Estado compartido entre la carga inicial y el recálculo tras recibir datos OSM ===== */
let distritoCountsGlobal = {};
let distritoPuntos = {};
let distritoClusterCount = {};
let currentPriorityRanking = [];
let lastPanelData = null;

/* ===== Normalización de tipo_rs (mismas correcciones del script de limpieza) ===== */
const CORRECCIONES_TIPO_RS = {
    "domicialiarios": "domiciliarios",
    "hospitaliarios": "hospitalarios"
};
function normalizarTipoRs(valor) {
    if (!valor) return valor;
    const v = String(valor).trim().toLowerCase();
    return CORRECCIONES_TIPO_RS[v] || v;
}

/* ===== Distancia Haversine en metros ===== */
function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/* ===== Clustering DBSCAN (mismo criterio usado en PostGIS: eps≈300m, minPts=3) ===== */
function dbscan(points, epsMeters, minPts) {
    const n = points.length;
    const labels = new Array(n).fill(undefined); // undefined = sin visitar, -1 = ruido, >=0 = cluster
    let clusterId = 0;

    function regionQuery(idx) {
        const neighbors = [];
        for (let j = 0; j < n; j++) {
            if (j === idx) continue;
            const d = haversineMeters(points[idx].lat, points[idx].lng, points[j].lat, points[j].lng);
            if (d <= epsMeters) neighbors.push(j);
        }
        return neighbors;
    }

    for (let i = 0; i < n; i++) {
        if (labels[i] !== undefined) continue;
        const neighbors = regionQuery(i);
        if (neighbors.length + 1 < minPts) {
            labels[i] = -1;
            continue;
        }
        labels[i] = clusterId;
        const seeds = [...neighbors];
        while (seeds.length) {
            const j = seeds.shift();
            if (labels[j] === -1) labels[j] = clusterId;
            if (labels[j] !== undefined) continue;
            labels[j] = clusterId;
            const jNeighbors = regionQuery(j);
            if (jNeighbors.length + 1 >= minPts) seeds.push(...jNeighbors);
        }
        clusterId++;
    }
    return { labels, numClusters: clusterId };
}

const CLUSTER_COLORS = ['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#46c0c0',
    '#f032e6','#9a8b00','#008080','#9a6324','#800000','#5e6bff','#c2185b','#00796b'];

/* ===== Clave consistente "Ciudad - Distrito N" usada para agrupar por distrito ===== */
function distritoKeyOf(props) {
    return `${props.ciu || 'S/I'} - Distrito ${props.distrito || 'S/I'}`;
}

/* ===== Envolvente convexa (monotone chain) - usada para dibujar zonas aproximadas ===== */
function convexHull(points) {
    const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (pts.length <= 2) return pts;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
}

/* ===== Escala de color secuencial por densidad (estilo ColorBrewer YlOrRd) ===== */
const DENSITY_SCALE = ['#ffffb2','#fed976','#feb24c','#fd8d3c','#fc4e2a','#e31a1c','#bd0026'];
function colorForCount(count, maxCount) {
    if (maxCount <= 0) return DENSITY_SCALE[0];
    const t = Math.min(count / maxCount, 1);
    const idx = Math.min(DENSITY_SCALE.length - 1, Math.round(t * (DENSITY_SCALE.length - 1)));
    return DENSITY_SCALE[idx];
}

/* ===== Opción C: zonas aproximadas por distrito (proxy de mapa de coropletas) =====
   No tenemos polígonos administrativos reales, así que se construye la envolvente
   convexa de los puntos de cada distrito como aproximación visual, coloreada
   según la cantidad de puntos críticos que contiene. */
function buildDistritoZonasLayer(distritoPuntosLocal, distritoCountsLocal) {
    const layer = L.layerGroup();
    const maxCount = Math.max(...Object.values(distritoCountsLocal), 1);

    Object.entries(distritoPuntosLocal).forEach(([key, pts]) => {
        const count = distritoCountsLocal[key] || pts.length;
        const color = colorForCount(count, maxCount);
        const centroid = {
            lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
            lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length
        };

        let shape;
        if (pts.length < 3) {
            // con 1-2 puntos no se puede formar un polígono: usamos un círculo de referencia
            shape = L.circle([centroid.lat, centroid.lng], {
                radius: 350, color: '#555', weight: 1, fillColor: color, fillOpacity: 0.45
            });
        } else {
            const hull = convexHull(pts.map(p => ({ x: p.lng, y: p.lat })));
            // se infla levemente el casco hacia afuera del centroide solo para que
            // se vea como una "zona" y no quede pegado exactamente a los puntos extremos
            const padded = hull.map(h => ({
                x: centroid.lng + (h.x - centroid.lng) * 1.15,
                y: centroid.lat + (h.y - centroid.lat) * 1.15
            }));
            shape = L.polygon(padded.map(h => [h.y, h.x]), {
                color: '#555', weight: 1, fillColor: color, fillOpacity: 0.45
            });
        }
        shape.bindPopup(() => zonaPopupHtml(key, count));
        layer.addLayer(shape);
    });

    return layer;
}

function zonaPopupHtml(key, count) {
    const rankInfo = currentPriorityRanking.find(r => r.distrito === key);
    const rankTxt = rankInfo
        ? `Prioridad: #${rankInfo.rank} de ${currentPriorityRanking.length}`
        : 'Prioridad: calculando…';
    return `
        <b>${key}</b><br>
        ${count} puntos críticos registrados<br>
        ${rankTxt}<br>
        <span style="font-size:11px;color:#777">Zona aproximada calculada a partir de los puntos
        registrados; no representa el límite administrativo oficial del distrito.</span>
    `;
}

/* ===== Opción A: índice de prioridad por distrito =====
   Combina 3 factores normalizados (0-1): cantidad de puntos críticos, número de
   clusters espaciales que tocan el distrito, y ausencia de cobertura OSM (cuando
   ya está disponible). Mientras no haya datos de cobertura, el índice usa solo
   los dos primeros factores y se recalcula automáticamente al recibirlos. */
function computePriorityRanking(distritoCountsLocal, distritoClusterCountLocal, coverageGapByDistrito) {
    const keys = Object.keys(distritoCountsLocal);
    const maxPuntos = Math.max(...keys.map(k => distritoCountsLocal[k] || 0), 1);
    const maxClusters = Math.max(...keys.map(k => (distritoClusterCountLocal[k] ? distritoClusterCountLocal[k].size : 0)), 1);
    const maxSinCobertura = coverageGapByDistrito
        ? Math.max(...keys.map(k => coverageGapByDistrito[k] != null ? coverageGapByDistrito[k] : 0), 1)
        : null;

    const rows = keys.map(k => {
        const puntos = distritoCountsLocal[k] || 0;
        const clusters = distritoClusterCountLocal[k] ? distritoClusterCountLocal[k].size : 0;
        const normPuntos = puntos / maxPuntos;
        const normClusters = clusters / maxClusters;
        let score, sinCobertura = null;

        if (coverageGapByDistrito && coverageGapByDistrito[k] != null) {
            sinCobertura = coverageGapByDistrito[k];
            const normCobertura = sinCobertura / maxSinCobertura;
            score = 0.4 * normPuntos + 0.3 * normClusters + 0.3 * normCobertura;
        } else {
            score = 0.55 * normPuntos + 0.45 * normClusters;
        }
        return { distrito: k, puntos, clusters, sinCobertura, score };
    });

    rows.sort((a, b) => b.score - a.score);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
}

/* ===== Cobertura OSM por distrito, calculada con los contenedores ya cargados en realBinsLayer ===== */
function computeCoverageGapByDistrito(distritoPuntosLocal) {
    if (!realBinsLayer) return null;
    const binCoords = [];
    realBinsLayer.eachLayer(l => {
        if (typeof l.getLatLng === 'function') {
            const ll = l.getLatLng();
            binCoords.push([ll.lat, ll.lng]);
        }
    });
    if (binCoords.length === 0) return null; // aún no hay contenedores OSM cargados

    const gap = {};
    Object.entries(distritoPuntosLocal).forEach(([key, pts]) => {
        let sinCobertura = 0;
        pts.forEach(p => {
            const cubierto = binCoords.some(([blat, blng]) => haversineMeters(p.lat, p.lng, blat, blng) <= 300);
            if (!cubierto) sinCobertura++;
        });
        gap[key] = sinCobertura;
    });
    return gap;
}

/* ===== Pinta el contenido del panel de Análisis Espacial ===== */
function renderStatsPanel({ total, distritoCounts, critCounts, numClusters, puntosEnCluster, priorityRanking, coverageReady }) {
    const content = document.getElementById('statsPanelContent');
    if (!content) return;

    const distritoEntries = Object.entries(distritoCounts).sort((a, b) => b[1] - a[1]);
    const tipoEntries = Object.entries(critCounts).sort((a, b) => b[1] - a[1]);
    const maxDistrito = distritoEntries.length ? distritoEntries[0][1] : 1;
    const pctCluster = total ? Math.round((puntosEnCluster / total) * 100) : 0;
    const ranking = priorityRanking || [];

    const filaDistrito = ([nombre, cant]) => `
        <tr>
            <td>
                ${nombre}
                <div class="stats-bar-bg"><div class="stats-bar-fill" style="width:${(cant / maxDistrito) * 100}%"></div></div>
            </td>
            <td>${cant}</td>
        </tr>`;

    const filaTipo = ([nombre, cant]) => `
        <tr><td>${nombre}</td><td>${cant}</td></tr>`;

    const filaPrioridad = (r) => {
        const medalla = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `#${r.rank}`;
        const coberturaTxt = r.sinCobertura != null
            ? `${r.sinCobertura} de ${r.puntos} puntos sin contenedor OSM cercano (300m)`
            : (coverageReady ? 'sin datos de cobertura para este distrito' : 'cobertura OSM: calculando…');
        return `
            <tr>
                <td colspan="2">
                    <div class="flex items-center justify-between">
                        <b>${medalla} ${r.distrito}</b>
                        <span class="text-xs text-gray-400">score ${r.score.toFixed(2)}</span>
                    </div>
                    <div class="stats-bar-bg"><div class="stats-bar-fill" style="width:${Math.round(r.score * 100)}%; background:#4527a0;"></div></div>
                    <div class="text-[11px] text-gray-500 mt-1">${r.puntos} puntos · ${r.clusters} clusters · ${coberturaTxt}</div>
                </td>
            </tr>`;
    };

    content.innerHTML = `
        <div class="space-y-5 text-sm">
            <div class="bg-green-50 p-3 rounded-lg border-l-4 border-green-600">
                <p class="font-bold text-green-900">${total} puntos críticos registrados</p>
                <p class="text-gray-600 text-xs mt-1">Fuente: GeoBolivia (relevamiento ~enero 2026)</p>
            </div>

            <div>
                <h4 class="font-bold mb-2 text-gray-800">🏆 Índice de prioridad por distrito</h4>
                <p class="text-xs text-gray-500 mb-2">
                    Combina cantidad de puntos críticos, número de clusters espaciales y
                    ${coverageReady ? 'ausencia de cobertura de contenedores OSM (ya calculada)' : 'cobertura OSM (aún calculando)'}.
                    Mayor barra = mayor prioridad de intervención.
                </p>
                <table class="stats-table stats-table-priority"><tbody>
                    ${ranking.map(filaPrioridad).join('')}
                </tbody></table>
            </div>

            <div>
                <h4 class="font-bold mb-2 text-gray-800">Puntos críticos por distrito</h4>
                <table class="stats-table"><tbody>
                    ${distritoEntries.map(filaDistrito).join('')}
                </tbody></table>
            </div>

            <div>
                <h4 class="font-bold mb-2 text-gray-800">Puntos críticos por tipo de residuo</h4>
                <table class="stats-table"><tbody>
                    ${tipoEntries.map(filaTipo).join('')}
                </tbody></table>
            </div>

            <div class="bg-indigo-50 p-3 rounded-lg border-l-4 border-indigo-600">
                <p class="font-bold text-indigo-900">🎯 Clusters espaciales (DBSCAN)</p>
                <p class="text-gray-700 text-xs mt-1">
                    Se identificaron <b>${numClusters} zonas</b> de concentración (puntos a menos de ~300m entre sí, mínimo 3 puntos por grupo).
                    El <b>${pctCluster}%</b> de los puntos críticos forma parte de alguna de estas zonas; el resto son puntos aislados.
                    Activa la capa "Clusters Espaciales" en el mapa para verlos.
                </p>
            </div>

            <div class="bg-amber-50 p-3 rounded-lg border-l-4 border-amber-600">
                <p class="font-bold text-amber-900">⚠ Cobertura de contenedores (OSM)</p>
                <p class="text-gray-700 text-xs mt-1">
                    ${coverageReady
                        ? 'Cálculo en vivo: se cruzaron los puntos críticos con los contenedores reales de OpenStreetMap cargados para el área visible del mapa (radio de 300m). El resultado por distrito ya está incorporado en el índice de prioridad de arriba.'
                        : 'Cargando contenedores reales desde OpenStreetMap para calcular la cobertura por distrito… esto se actualiza automáticamente en unos segundos.'}
                </p>
            </div>

            <div class="text-xs text-gray-400 italic border-t pt-3 mt-2">
                Metodología: PostgreSQL + PostGIS para el análisis base; clustering DBSCAN, zonas por distrito
                e índice de prioridad replicados en JavaScript (eps≈300m, minPts=3) para visualización interactiva;
                cruce con OpenStreetMap vía Overpass API.
            </div>
        </div>
    `;
}

document.addEventListener("DOMContentLoaded", function() {
    map = L.map('map').setView([-16.5000, -68.1500], 14);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    realBinsLayer = L.layerGroup().addTo(map);
    userLayer = L.layerGroup(); 
    puntosCriticosLayer = L.layerGroup().addTo(map);

    const overlays = {
        "Contenedores (OSM - Real)": realBinsLayer,
        "Puntos Críticos (GeoJSON)": puntosCriticosLayer
    };
    layersControl = L.control.layers(null, overlays).addTo(map);

    const legend = L.control({position: 'bottomleft'});
    legend.onAdd = function (map) {
        const container = L.DomUtil.create('div', 'info legend');

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';

        const title = document.createElement('h4');
        title.textContent = 'Referencias';
        title.style.margin = '0';
        title.style.fontSize = '14px';
        title.style.fontWeight = '700';

        const btn = document.createElement('button');
        btn.innerHTML = '\u25B6'; 
        btn.title = 'Expandir leyenda';
        btn.style.background = 'transparent';
        btn.style.border = 'none';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '16px';

        header.appendChild(title);
        header.appendChild(btn);
        container.appendChild(header);

        const content = document.createElement('div');
        content.className = 'legend-content';
        content.style.marginTop = '8px';
        content.style.display = 'none';
        content.style.maxHeight = '240px';
        content.style.overflow = 'auto';

        const osmHtml = document.createElement('div');
        osmHtml.innerHTML = `
            <div style="margin-bottom:6px"><i style="background:#2e7d32; border-radius:50%"></i> Contenedor / Papelera (OSM)</div>
            <div style="margin-bottom:6px"><i style="background:#1565c0; border-radius:50%"></i> Punto de Reciclaje (OSM)</div>
            <div style="margin-bottom:6px"><i style="background:#4e342e; border-radius:50%"></i> Contenedor Grande (OSM)</div>
            <hr style="margin:6px 0; border:none; border-top:1px solid #eee;">
        `;
        content.appendChild(osmHtml);

        const critSection = document.createElement('div');
        critSection.className = 'legend-crit-section';
        content.appendChild(critSection);

        container.appendChild(content);

        L.DomEvent.disableClickPropagation(container);
        btn.addEventListener('click', () => {
            if (content.style.display === 'none') {
                content.style.display = '';
                btn.innerHTML = '\u25BC'; 
                btn.title = 'Contraer leyenda';
            } else {
                content.style.display = 'none';
                btn.innerHTML = '\u25B6';
                btn.title = 'Expandir leyenda';
            }
        });

        return container;
    };
    legend.addTo(map);

    async function loadLocalGeoJSON() {
        const baseColors = ['#d32f2f','#fb8c00','#8e24aa','#6a1b9a','#1565c0','#2e7d32','#0288d1','#26a69a','#fbc02d','#7b1fa2','#455a64'];

        let critCategories = [];
        let critCounts = {};
        const critCategoryLayers = {};
        let geo = null;
        try {
            let resp = await fetch('puntos_criticos_lpea_limpio.geojson');
            if (!resp.ok) {
                console.warn('No se encontró el geojson limpio, usando el original sin normalizar.');
                resp = await fetch('puntos_criticos_lpea.geojson');
            }
            if (!resp.ok) throw new Error('No se pudo obtener ningún geojson de puntos críticos');
            geo = await resp.json();

            const values = geo.features.map(f => normalizarTipoRs(f.properties && f.properties.tipo_rs));
            critCategories = Array.from(new Set(values));

            critCategories.forEach((c, i) => {
                critCounts[c] = 0;
                critCategoryLayers[c] = L.layerGroup();
            });

            geo.features.forEach(feature => {
                const lat = feature.geometry && feature.geometry.coordinates ? feature.geometry.coordinates[1] : null;
                const lng = feature.geometry && feature.geometry.coordinates ? feature.geometry.coordinates[0] : null;
                if (lat === null || lng === null) return;

                const cat = normalizarTipoRs(feature.properties && feature.properties.tipo_rs) || 'sin_dato';
                const color = baseColors[critCategories.indexOf(cat) % baseColors.length] || '#999';
                critCounts[cat] = (critCounts[cat] || 0) + 1;

                const marker = L.circleMarker([lat, lng], { radius: 7, fillColor: color, color: '#fff', weight:1, fillOpacity:0.95 });
                let html = '<b>🗑 Punto Crítico</b><br>';
                if (feature.properties) {
                    for (const key in feature.properties) {
                        html += `${key}: ${feature.properties[key]}<br>`;
                    }
                }
                const nombrePunto = (feature.properties && feature.properties.tipo_rs) ? feature.properties.tipo_rs : 'sin dato';
                html += `<br><button onclick="trazarRutaAlContenedor(${lat},${lng},'${nombrePunto}')" 
                    style="margin-top:4px;padding:4px 10px;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px">
                    🗺 Ruta al contenedor más cercano</button>`;
                marker.bindPopup(html);
                critCategoryLayers[cat].addLayer(marker);
            });

            puntosCriticosLayer.clearLayers();
            critCategories.forEach(c => puntosCriticosLayer.addLayer(critCategoryLayers[c]));

            /* ===== Heatmap de densidad ===== */
            try {
                const heatPoints = geo.features
                    .filter(f => f.geometry && f.geometry.coordinates)
                    .map(f => [f.geometry.coordinates[1], f.geometry.coordinates[0], 0.6]);
                if (typeof L.heatLayer === 'function') {
                    heatLayer = L.heatLayer(heatPoints, { radius: 28, blur: 20, maxZoom: 17, max: 1.0 });
                } else {
                    console.warn('leaflet.heat no está disponible; se omite la capa de Mapa de Calor.');
                }
            } catch (heatErr) {
                console.warn('No se pudo construir el Mapa de Calor.', heatErr);
            }

            /* ===== Clustering espacial (DBSCAN, eps≈300m, minPts=3) ===== */
            try {
                const ptsForCluster = geo.features
                    .filter(f => f.geometry && f.geometry.coordinates)
                    .map(f => ({
                        lat: f.geometry.coordinates[1],
                        lng: f.geometry.coordinates[0],
                        props: f.properties || {}
                    }));
                const { labels: clusterLabels, numClusters } = dbscan(ptsForCluster, 300, 3);

                clustersLayer = L.layerGroup();
                distritoCountsGlobal = {};
                distritoPuntos = {};
                distritoClusterCount = {};
                let puntosEnCluster = 0;

                ptsForCluster.forEach((p, i) => {
                    const key = distritoKeyOf(p.props);
                    distritoCountsGlobal[key] = (distritoCountsGlobal[key] || 0) + 1;
                    if (!distritoPuntos[key]) distritoPuntos[key] = [];
                    distritoPuntos[key].push({ lat: p.lat, lng: p.lng });
                    if (!distritoClusterCount[key]) distritoClusterCount[key] = new Set();

                    const cid = clusterLabels[i];
                    if (cid === -1) return; // punto aislado: no entra a la capa de clusters
                    puntosEnCluster++;
                    distritoClusterCount[key].add(cid);

                    const color = CLUSTER_COLORS[cid % CLUSTER_COLORS.length];
                    const marker = L.circleMarker([p.lat, p.lng], {
                        radius: 8, fillColor: color, color: '#fff', weight: 1.5, fillOpacity: 0.9
                    });
                    marker.bindPopup(
                        `<b>Cluster #${cid}</b><br>` +
                        `Distrito: ${p.props.distrito || 'S/I'} (${p.props.ciu || ''})<br>` +
                        `Tipo: ${normalizarTipoRs(p.props.tipo_rs) || 'S/I'}<br>` +
                        `Ubicación: ${p.props.ubi || 'S/I'}`
                    );
                    clustersLayer.addLayer(marker);
                });

                /* ===== Opción C: zonas aproximadas por distrito ===== */
                distritoZonasLayer = buildDistritoZonasLayer(distritoPuntos, distritoCountsGlobal);

                if (layersControl) {
                    if (heatLayer) layersControl.addOverlay(heatLayer, '🔥 Mapa de Calor (Densidad)');
                    layersControl.addOverlay(clustersLayer, '🎯 Clusters Espaciales (DBSCAN)');
                    layersControl.addOverlay(distritoZonasLayer, '🗺️ Densidad por Distrito (zonas aprox.)');
                }

                /* ===== Opción A: índice de prioridad — fase 1 (sin datos OSM todavía) ===== */
                currentPriorityRanking = computePriorityRanking(distritoCountsGlobal, distritoClusterCount, null);

                lastPanelData = {
                    total: geo.features.length,
                    distritoCounts: distritoCountsGlobal,
                    critCounts,
                    numClusters,
                    puntosEnCluster,
                    priorityRanking: currentPriorityRanking,
                    coverageReady: false
                };
                renderStatsPanel(lastPanelData);
            } catch (analysisErr) {
                console.error('Error calculando clusters/zonas/prioridad; se muestra un panel reducido.', analysisErr);
                // Aun si el análisis avanzado falla, mostramos al menos lo básico
                // (puntos por distrito y por tipo) para que el panel no se quede colgado.
                const distritoCountsFallback = {};
                geo.features.forEach(f => {
                    const key = distritoKeyOf(f.properties || {});
                    distritoCountsFallback[key] = (distritoCountsFallback[key] || 0) + 1;
                });
                renderStatsPanel({
                    total: geo.features.length,
                    distritoCounts: distritoCountsFallback,
                    critCounts,
                    numClusters: 0,
                    puntosEnCluster: 0,
                    priorityRanking: [],
                    coverageReady: false
                });
            }
        } catch (err) {
            console.error('Error cargando puntos_criticos_lpea.geojson', err);
        }

        try {
            const legendDiv = document.querySelector('.info.legend');
            if (legendDiv) {
                const critSection = legendDiv.querySelector('.legend-crit-section');
                if (critSection) {
                    critSection.innerHTML = '';
                    const totalCrit = Object.values(critCounts).reduce((a,b)=>a+b,0) || 0;
                    const header = document.createElement('div');
                    header.style.fontWeight = '700';
                    header.style.marginBottom = '6px';
                    header.textContent = `Puntos Críticos (GeoJSON) — ${totalCrit} puntos`;
                    critSection.appendChild(header);

                    const list = document.createElement('div');
                    list.style.display = 'flex';
                    list.style.flexDirection = 'column';
                    list.style.gap = '6px';
                    list.style.marginBottom = '8px';

                    critCategories.forEach((c, i) => {
                        const color = baseColors[i % baseColors.length];
                        const count = critCounts[c] || 0;

                        const row = document.createElement('label');
                        row.style.display = 'flex';
                        row.style.alignItems = 'center';
                        row.style.gap = '8px';
                        row.style.cursor = 'pointer';

                        const chk = document.createElement('input');
                        chk.type = 'checkbox';
                        chk.checked = true;
                        chk.style.marginRight = '6px';

                        chk.addEventListener('change', () => {
                            try {
                                if (chk.checked) {
                                    puntosCriticosLayer.addLayer(critCategoryLayers[c]);
                                } else {
                                    puntosCriticosLayer.removeLayer(critCategoryLayers[c]);
                                }
                            } catch (err) { console.warn('Toggle error', err); }
                        });

                        const sw = document.createElement('i');
                        sw.style.background = color;
                        sw.style.width = '14px';
                        sw.style.height = '14px';
                        sw.style.borderRadius = '3px';
                        sw.style.display = 'inline-block';

                        const txt = document.createElement('span');
                        txt.style.fontSize = '12px';
                        txt.textContent = `${c} — ${count}`;

                        row.appendChild(chk);
                        row.appendChild(sw);
                        row.appendChild(txt);
                        list.appendChild(row);
                    });

                    critSection.appendChild(list);
                    const hr = document.createElement('hr');
                    hr.style.margin = '6px 0';
                    hr.style.border = 'none';
                    hr.style.borderTop = '1px solid #eee';
                    critSection.appendChild(hr);
                }
            }
        } catch(e) { console.warn('No se pudo actualizar visualmente la leyenda.', e); }

        try {
            let bounds = null;
            const extendBoundsFromLayer = (layer) => {
                try {
                    if (!layer) return;
                    if (typeof layer.getBounds === 'function') {
                        const b = layer.getBounds();
                        if (b && b.isValid && b.isValid()) {
                            bounds = bounds ? bounds.extend(b) : L.latLngBounds(b);
                        }
                    } else if (typeof layer.getLatLng === 'function') {
                        const ll = layer.getLatLng();
                        bounds = bounds ? bounds.extend(ll) : L.latLngBounds(ll, ll);
                    } else if (typeof layer.eachLayer === 'function') {
                        layer.eachLayer(sub => extendBoundsFromLayer(sub));
                    }
                } catch(e) { /* ignore */ }
            };

            extendBoundsFromLayer(puntosCriticosLayer);

            if (bounds) {
                map.fitBounds(bounds, {padding: [40,40]});
            }
        } catch(e) { /* ignore */ }

        try {
            if (typeof fetchRealData === 'function') fetchRealData();
        } catch(e) { /* ignore */ }
    }

    loadLocalGeoJSON();    
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };

    const observer = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                
                        if (entry.target.id === 'mapa-section') {
                            setTimeout(() => {
                                map.invalidateSize();
                            }, 400);
                        }

                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    const fadeElements = document.querySelectorAll('.fade-in-section');
    fadeElements.forEach(el => observer.observe(el));

    const ctxBar = document.getElementById('barChart').getContext('2d');
    new Chart(ctxBar, {
        type: 'bar',
        data: {
            labels: ['Santa Cruz', 'El Alto', 'La Paz', 'Cochabamba', 'Oruro'],
            datasets: [{
                label: 'Toneladas por Día (Aprox)',
                data: [1900, 700, 680, 600, 250],
                backgroundColor: ['rgba(46, 125, 50, 0.7)', 'rgba(102, 187, 106, 0.7)', 'rgba(102, 187, 106, 0.7)', 'rgba(102, 187, 106, 0.7)', 'rgba(165, 214, 167, 0.7)'],
                borderColor: '#1b5e20', borderWidth: 1
            }]
        },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: 'Toneladas / Día' } } } }
    });

    const ctxPie = document.getElementById('pieChart').getContext('2d');
    new Chart(ctxPie, {
        type: 'doughnut',
        data: {
            labels: ['Orgánico (55%)', 'Plásticos (12%)', 'Papel/Cartón (8%)', 'Vidrio (5%)', 'Otros (20%)'],
            datasets: [{
                data: [55, 12, 8, 5, 20],
                backgroundColor: ['#4CAF50', '#2196F3', '#FFC107', '#FF5722', '#9E9E9E'],
                hoverOffset: 4
            }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } } }
    });
});

async function fetchRealData() {
    if (!map || !realBinsLayer) return;
    const loader = document.getElementById('loader');
    loader.style.opacity = '1';
    loader.style.display = 'flex';
    
    realBinsLayer.clearLayers();

    const bounds = map.getBounds();
    const south = bounds.getSouth();
    const west = bounds.getWest();
    const north = bounds.getNorth();
    const east = bounds.getEast();

    const query = `
        [out:json][timeout:25];
        (
          node["amenity"="waste_basket"](${south},${west},${north},${east});
          node["amenity"="waste_disposal"](${south},${west},${north},${east});
          node["amenity"="recycling"](${south},${west},${north},${east});
        );
        out body;
    `;

    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const data = await response.json();

            if (data.elements && data.elements.length > 0) {
                data.elements.forEach(element => {
                    let color = "#2e7d32"; 
                    let type = "Contenedor/Papelera (OSM)";

                    if (element.tags.amenity === "recycling") {
                        color = "#1565c0"; 
                        type = "Punto de Reciclaje (OSM)";
                    } else if (element.tags.amenity === "waste_disposal") {
                        color = "#4e342e"; 
                        type = "Contenedor Grande (OSM)";
                    }

                    const marker = L.circleMarker([element.lat, element.lon], {
                        radius: 6,
                        fillColor: color,
                        color: "#fff",
                        weight: 1,
                        opacity: 1,
                        fillOpacity: 0.8
                    });

                    let popupContent = `<b>${type}</b><br>`;
                    if (element.tags.name) popupContent += `Nombre: ${element.tags.name}<br>`;
                    if (element.tags.operator) popupContent += `Operador: ${element.tags.operator}<br>`;
                    if (element.tags.recycling_type) popupContent += `Tipo: ${element.tags.recycling_type}<br>`;
                    if (element.tags.description) popupContent += `Descripción: ${element.tags.description}<br>`;
                    
                    marker.bindPopup(popupContent);
                    realBinsLayer.addLayer(marker);
                });
                console.log(`Cargados ${data.elements.length} puntos reales de OSM.`);
            } else {
                 console.log("No se encontraron puntos de basura mapeados en OpenStreetMap en esta área visible.");
            }
            break; 

        } catch (error) {
            console.error("Error conectando a Overpass API. Reintento:", attempt + 1, error);
            attempt++;
            if (attempt >= maxRetries) {
                console.error("Fallo definitivo al cargar datos reales de Overpass API.");
            } else {
                const delay = Math.pow(2, attempt) * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    loader.style.opacity = '0';
    setTimeout(() => { loader.style.display = 'none'; }, 500);

    /* ===== Opción A fase 2: recalcular prioridad ahora que tenemos datos OSM reales ===== */
    try {
        if (lastPanelData && Object.keys(distritoPuntos).length > 0) {
            const coverageGap = computeCoverageGapByDistrito(distritoPuntos);
            if (coverageGap) {
                currentPriorityRanking = computePriorityRanking(distritoCountsGlobal, distritoClusterCount, coverageGap);
                renderStatsPanel({ ...lastPanelData, priorityRanking: currentPriorityRanking, coverageReady: true });
                lastPanelData = { ...lastPanelData, priorityRanking: currentPriorityRanking, coverageReady: true };
                // refrescar popups de zonas con el nuevo ranking
                if (distritoZonasLayer) {
                    distritoZonasLayer.eachLayer(l => { if (l.getPopup) l.closePopup(); });
                }
            }
        }
    } catch(e) { console.warn('No se pudo recalcular el índice de prioridad con datos OSM.', e); }
    
}
window.fetchRealData = fetchRealData;

/* ===== Módulo de Rutas: punto crítico → contenedor OSM más cercano ===== */

/**
 * Devuelve el contenedor OSM más cercano (en línea recta) al punto [lat, lng].
 * Recorre todas las capas de realBinsLayer para obtener sus coordenadas.
 */
function contenedorMasCercano(lat, lng) {
    let minDist = Infinity;
    let closest = null;
    realBinsLayer.eachLayer(layer => {
        if (!layer.getLatLng) return;
        const c = layer.getLatLng();
        const d = haversineMeters(lat, lng, c.lat, c.lng);
        if (d < minDist) {
            minDist = d;
            closest = { lat: c.lat, lng: c.lng, dist: d, layer };
        }
    });
    return closest;
}

/**
 * Limpia las capas de ruta anteriores del mapa.
 */
function limpiarRuta() {
    if (rutaLayer)        { map.removeLayer(rutaLayer);        rutaLayer = null; }
    if (rutaOptLayer)     { map.removeLayer(rutaOptLayer);     rutaOptLayer = null; }
    if (rutaMarkersLayer) { map.removeLayer(rutaMarkersLayer); rutaMarkersLayer = null; }
}

/**
 * Dado un punto crítico (lat, lng) y el contenedor más cercano:
 * 1. Dibuja la línea recta (azul) con la distancia en línea recta.
 * 2. Consulta OSRM y dibuja la ruta óptima por calles (roja) con distancia y tiempo.
 * 3. Abre un popup en el contenedor con el resumen.
 */
async function trazarRutaAlContenedor(latOrigen, lngOrigen, nombreOrigen) {
    // 1. Obtener contenedor más cercano
    const dest = contenedorMasCercano(latOrigen, lngOrigen);
    if (!dest) {
        alert('No hay contenedores OSM cargados todavía. Espera unos segundos e intenta de nuevo.');
        return;
    }

    limpiarRuta();
    rutaMarkersLayer = L.layerGroup().addTo(map);

    // 2. Línea recta (azul)
    const geomRecta = L.polyline(
        [[latOrigen, lngOrigen], [dest.lat, dest.lng]],
        { color: '#1565c0', weight: 2.5, dashArray: '6 4', opacity: 0.85 }
    ).addTo(map);
    rutaLayer = geomRecta;

    const distRecta = (dest.dist / 1000).toFixed(2);

    // Marcador origen
    const mOrigen = L.circleMarker([latOrigen, lngOrigen], {
        radius: 9, fillColor: '#1565c0', color: '#fff', weight: 2, fillOpacity: 1
    }).bindPopup(`<b>🗑 Punto Crítico</b><br>${nombreOrigen}<br><i>Origen de la ruta</i>`).addTo(rutaMarkersLayer);

    // 3. Ruta óptima OSRM (roja)
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/` +
        `${lngOrigen},${latOrigen};${dest.lng},${dest.lat}` +
        `?overview=full&geometries=geojson`;

    let distOpt = null, durMin = null;
    try {
        const resp = await fetch(osrmUrl);
        const data = await resp.json();
        if (data.routes && data.routes.length > 0) {
            const ruta = data.routes[0];
            distOpt = (ruta.distance / 1000).toFixed(2);
            durMin  = (ruta.duration / 60).toFixed(1);

            const coordsGeo = ruta.geometry.coordinates.map(c => [c[1], c[0]]);
            rutaOptLayer = L.polyline(coordsGeo, {
                color: '#c62828', weight: 4, opacity: 0.9
            }).addTo(map);
        }
    } catch (e) {
        console.warn('OSRM no disponible, solo se muestra la línea recta.', e);
    }

    // 4. Popup en el contenedor destino con resumen completo
    const resumen = distOpt
        ? `<b>📦 Contenedor más cercano</b><br>
           Distancia en línea recta: <b>${distRecta} km</b><br>
           Ruta óptima por calles: <b>${distOpt} km</b><br>
           Tiempo estimado: <b>${durMin} min</b><br>
           <small style="color:#555">Línea azul = recta · Línea roja = ruta OSRM</small><br>
           <a href="#" onclick="limpiarRuta();return false;" style="color:#c62828;font-size:11px">✕ Cerrar ruta</a>`
        : `<b>📦 Contenedor más cercano</b><br>
           Distancia en línea recta: <b>${distRecta} km</b><br>
           <small style="color:#888">(Ruta OSRM no disponible)</small><br>
           <a href="#" onclick="limpiarRuta();return false;" style="color:#c62828;font-size:11px">✕ Cerrar ruta</a>`;

    const mDest = L.circleMarker([dest.lat, dest.lng], {
        radius: 9, fillColor: '#c62828', color: '#fff', weight: 2, fillOpacity: 1
    }).bindPopup(resumen).addTo(rutaMarkersLayer);

    // Ajustar vista para mostrar ambos puntos
    map.fitBounds(L.latLngBounds([[latOrigen, lngOrigen], [dest.lat, dest.lng]]), { padding: [60, 60] });
    mDest.openPopup();
}

// Exponer al scope global para que los botones en popups puedan llamarla
window.trazarRutaAlContenedor = trazarRutaAlContenedor;
window.limpiarRuta = limpiarRuta;

/* ===== Toggle del panel de Análisis Espacial ===== */
(function setupStatsPanel() {
    const toggleBtn = document.getElementById('statsToggleBtn');
    const closeBtn = document.getElementById('statsCloseBtn');
    const panel = document.getElementById('statsPanel');
    const overlay = document.getElementById('statsOverlay');
    if (!toggleBtn || !panel || !overlay) return;

    function open() {
        panel.classList.add('is-open');
        overlay.classList.add('is-open');
    }
    function close() {
        panel.classList.remove('is-open');
        overlay.classList.remove('is-open');
    }

    toggleBtn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', close);
})();