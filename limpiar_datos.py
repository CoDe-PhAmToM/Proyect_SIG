"""
Script de limpieza - Puntos Críticos de Residuos Sólidos LP/EA
-----------------------------------------------------------------
Que hace:
1. Lee el geojson original (puntos_criticos_lpea.geojson)
2. Normaliza el campo 'tipo_rs' (corrige errores de tipeo)
3. Genera un resumen de conteos (por distrito, por tipo, por ciudad)
4. Guarda un geojson limpio nuevo, sin tocar el original

Como usarlo:
    python limpiar_datos.py

Requisitos: solo Python estandar, no necesita instalar nada.
"""

import json
from collections import Counter

# --- Configuracion ---
ARCHIVO_ENTRADA = "puntos_criticos_lpea.geojson"
ARCHIVO_SALIDA = "puntos_criticos_lpea_limpio.geojson"

# Diccionario de correccion: valor incorrecto -> valor correcto
# Si encuentras mas inconsistencias al revisar, las agregas aqui
CORRECCIONES_TIPO_RS = {
    "domicialiarios": "domiciliarios",
    "hospitaliarios": "hospitalarios",
}


def normalizar_tipo_rs(valor):
    """Corrige errores de tipeo conocidos en el campo tipo_rs."""
    if valor is None:
        return valor
    valor_limpio = valor.strip().lower()
    return CORRECCIONES_TIPO_RS.get(valor_limpio, valor_limpio)


def main():
    # 1. Cargar el geojson original
    with open(ARCHIVO_ENTRADA, "r", encoding="utf-8") as f:
        data = json.load(f)

    features = data["features"]
    print(f"Total de puntos cargados: {len(features)}\n")

    # 2. Conteo ANTES de limpiar (para comparar)
    tipos_antes = Counter(f["properties"].get("tipo_rs", "sin_dato") for f in features)

    # 3. Normalizar el campo tipo_rs en cada punto
    for feat in features:
        props = feat["properties"]
        props["tipo_rs"] = normalizar_tipo_rs(props.get("tipo_rs"))

    # 4. Conteo DESPUES de limpiar
    tipos_despues = Counter(f["properties"].get("tipo_rs", "sin_dato") for f in features)

    # 5. Mostrar comparacion
    print("=== ANTES de limpiar (tipo_rs) ===")
    for tipo, cant in sorted(tipos_antes.items(), key=lambda x: -x[1]):
        print(f"  {cant:4d}  {tipo}")

    print("\n=== DESPUES de limpiar (tipo_rs) ===")
    for tipo, cant in sorted(tipos_despues.items(), key=lambda x: -x[1]):
        print(f"  {cant:4d}  {tipo}")

    # 6. Resumen por distrito y ciudad (no necesita limpieza, ya esta consistente)
    print("\n=== Puntos por ciudad y distrito ===")
    distritos = Counter()
    for feat in features:
        props = feat["properties"]
        key = f"{props.get('ciu', 'S/I')} - distrito {props.get('distrito', 'S/I')}"
        distritos[key] += 1
    for key, cant in sorted(distritos.items()):
        print(f"  {cant:4d}  {key}")

    # 7. Resumen de completitud de campos (cuantos S/I hay)
    print("\n=== Completitud de campos (vacios marcados como S/I) ===")
    campos_a_revisar = ["cantid", "zon", "rut", "reccol"]
    for campo in campos_a_revisar:
        total_si = sum(1 for f in features if f["properties"].get(campo) == "S/I")
        print(f"  {campo}: {total_si}/{len(features)} sin dato (S/I)")

    # 8. Guardar el geojson limpio (no se sobrescribe el original)
    with open(ARCHIVO_SALIDA, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\nListo. Archivo limpio guardado como: {ARCHIVO_SALIDA}")
    print("El archivo original NO fue modificado.")


if __name__ == "__main__":
    main()