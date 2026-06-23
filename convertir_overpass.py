"""
Convierte la respuesta cruda de Overpass API (contenedores_osm.json)
a un GeoJSON estandar listo para cargar a PostGIS con ogr2ogr.

Como usarlo:
    python3 convertir_overpass.py
"""

import json

ARCHIVO_ENTRADA = "contenedores_osm.json"
ARCHIVO_SALIDA = "contenedores_osm.geojson"


def main():
    with open(ARCHIVO_ENTRADA, "r", encoding="utf-8") as f:
        data = json.load(f)

    elementos = data.get("elements", [])
    print(f"Elementos encontrados en Overpass: {len(elementos)}")

    features = []
    for el in elementos:
        if el.get("type") != "node":
            continue  # solo nos interesan nodos (puntos), no ways/relations

        tags = el.get("tags", {})
        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [el["lon"], el["lat"]],
            },
            "properties": {
                "osm_id": el["id"],
                "amenity": tags.get("amenity", "sin_dato"),
                "recycling_type": tags.get("recycling_type", "sin_dato"),
                "name": tags.get("name", "sin_dato"),
            },
        }
        features.append(feature)

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }

    with open(ARCHIVO_SALIDA, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)

    print(f"Listo. {len(features)} puntos guardados en {ARCHIVO_SALIDA}")

    # resumen rapido por tipo
    tipos = {}
    for feat in features:
        a = feat["properties"]["amenity"]
        tipos[a] = tipos.get(a, 0) + 1
    print("\nResumen por tipo:")
    for k, v in sorted(tipos.items(), key=lambda x: -x[1]):
        print(f"  {v:4d}  {k}")


if __name__ == "__main__":
    main()
