"""
Copia las notas de Mitpad de Neon a Convex (notes, noteLinks, users).

Lee Neon en solo lectura con la URL de la variable NEON_DB_URL (nunca en el
código), escribe un JSONL por tabla en una carpeta temporal privada y lo carga
con `npx convex import --replace`.

    NEON_DB_URL=postgresql://... python scripts/migrar_neon_a_convex.py            # cuenta filas
    NEON_DB_URL=postgresql://... python scripts/migrar_neon_a_convex.py --importar [--prod]
"""
import json
import os
import subprocess
import sys
import tempfile

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def ms(fecha):
    return fecha.timestamp() * 1000 if fecha else None


def leer_neon(url):
    import psycopg2
    conn = psycopg2.connect(url, connect_timeout=15)
    conn.set_session(readonly=True, autocommit=True)
    c = conn.cursor()
    c.execute("SELECT id, user_id, title, content, created_at, updated_at FROM notes ORDER BY created_at")
    notes = [{"_creationTime": ms(cr), "uuid": str(i), "userId": str(u or ""),
              **({"title": t} if t is not None else {}), "content": co, "createdAt": ms(cr),
              "updatedAt": ms(up or cr)} for i, u, t, co, cr, up in c.fetchall()]
    c.execute("SELECT id, source_note_id, target_note_id, created_at FROM note_links")
    links = [{"uuid": str(i), "sourceNoteId": str(s), "targetNoteId": str(t), "createdAt": ms(cr)}
             for i, s, t, cr in c.fetchall()]
    c.execute("SELECT id, nombre, entorno, gustos, odia, proyectos, created_at FROM users")
    users = [{"_creationTime": ms(cr), "uuid": str(i), "nombre": n, **({"entorno": e} if e else {}),
              **({"gustos": g} if g is not None else {}), **({"odia": o} if o is not None else {}),
              **({"proyectos": p} if p is not None else {}), "createdAt": ms(cr)}
             for i, n, e, g, o, p, cr in c.fetchall()]
    conn.close()
    return {"notes": notes, "noteLinks": links, "users": users}


def importar(tablas, prod=False):
    with tempfile.TemporaryDirectory(prefix="mitpad-migracion-") as carpeta:
        os.chmod(carpeta, 0o700)
        for tabla, filas in tablas.items():
            if not filas:
                print(f"{tabla}: vacía, no se importa")
                continue
            ruta = os.path.join(carpeta, f"{tabla}.jsonl")
            with open(ruta, "w", encoding="utf-8") as f:
                f.writelines(json.dumps(x, ensure_ascii=False) + "\n" for x in filas)
            destino = ["--prod"] if prod else []
            r = subprocess.run(["npx", "convex", "import", *destino, "--table", tabla, "--replace", "-y", ruta],
                               cwd=RAIZ, capture_output=True, text=True)
            print(f"{tabla}: {len(filas)} filas -> {'ok' if r.returncode == 0 else 'ERROR ' + r.stderr[-600:]}")


if __name__ == "__main__":
    url = os.environ.get("NEON_DB_URL")
    if not url:
        sys.exit("Falta NEON_DB_URL en el entorno.")
    datos = leer_neon(url)
    for nombre, filas in datos.items():
        print(f"{nombre}: {len(filas)} filas")
    if "--importar" in sys.argv:
        importar(datos, prod="--prod" in sys.argv)
